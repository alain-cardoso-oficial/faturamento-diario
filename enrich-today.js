const fs = require('fs');
const path = require('path');
const { buildAccounts, shouldIncludeOrder } = require('./site/dist/order-classifier.js');

const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, 'data', 'tiny-order-cache.json');
const SEARCH = 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const DETAIL = 'https://api.tiny.com.br/api2/pedido.obter.php';

for (const fileName of ['.env.local', '.env']) {
  const filePath = path.join(ROOT, fileName);
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const accounts = buildAccounts(process.env).filter(acc => Boolean(acc.token));
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const date = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
}).format(new Date());

async function post(url, token, params, attempt = 0) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, formato: 'JSON', ...params })
  });
  const limit = Number(response.headers.get('x-limit-api') || 30);
  if (response.status === 429 && attempt < 6) {
    await wait(Math.min(60000, 5000 * 2 ** attempt));
    return post(url, token, params, attempt + 1);
  }
  const json = await response.json();
  const root = json.retorno || {};
  if (root.status !== 'OK') {
    const code = Number(root.codigo_erro || 0);
    const message = (root.erros || []).map(x => x.erro).join('; ') || `HTTP ${response.status}`;
    if (code === 20 || /não retornou registros/i.test(message)) {
      return { root: { ...root, pedidos: [], numero_paginas: 1 }, limit };
    }
    if (/Excedido o número de acessos/i.test(message) && attempt < 6) {
      await wait(Math.min(60000, 5000 * 2 ** attempt));
      return post(url, token, params, attempt + 1);
    }
    throw new Error(message);
  }
  return { root, limit };
}

async function searchAccountOrders(account) {
  let limit = 30;
  const collectPages = async (extraParams = {}) => {
    let page = 1, pages = 1;
    const found = [];
    do {
      const result = await post(SEARCH, account.token, {
        dataInicial: date,
        dataFinal: date,
        pagina: String(page),
        sort: 'ASC',
        ...extraParams
      });
      limit = result.limit;
      pages = Number(result.root.numero_paginas || 1);
      found.push(...(result.root.pedidos || []).map(x => x.pedido || x).filter(Boolean));
      page++;
    } while (page <= pages);
    return found;
  };

  if (Array.isArray(account.requiredMarkers) && account.requiredMarkers.length > 0) {
    const byId = new Map();
    for (const marker of account.requiredMarkers) {
      const orders = await collectPages({ marcador: marker });
      for (const order of orders) {
        const key = String(order.id || order.numero || '');
        if (key && !byId.has(key)) byId.set(key, order);
      }
    }
    return { orders: [...byId.values()], limit };
  }
  return { orders: await collectPages(), limit };
}

async function enrich(account) {
  const { orders, limit } = await searchAccountOrders(account);
  const missing = orders.filter(x => {
    const cached = cache[`${account.empresa}:${x.id}`];
    if (!cached) return true;
    if (account.requiredMarkers?.length && !shouldIncludeOrder(cached, account.empresa)) return true;
    return false;
  });
  const interval = Math.ceil(60000 / Math.max(10, limit - 4));
  console.log(`${account.empresa}: ${orders.length} pedidos, ${missing.length} detalhes pendentes, limite ${limit}/min`);
  for (let i = 0; i < missing.length; i++) {
    const summary = missing[i], result = await post(DETAIL, account.token, { id: String(summary.id) });
    const detail = result.root.pedido || summary;
    cache[`${account.empresa}:${summary.id}`] = {
      ...detail,
      valor: detail.valor || detail.total_pedido || summary.valor || 0,
      _tinyDetail: true
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    if ((i + 1) % 10 === 0 || i === missing.length - 1) {
      console.log(`${account.empresa}: ${i + 1}/${missing.length} detalhes concluídos`);
    }
    await wait(interval);
  }
}

Promise.all(accounts.map(enrich))
  .then(() => console.log(`Cache completo: ${Object.keys(cache).length} pedidos`))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
