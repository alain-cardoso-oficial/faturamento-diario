const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, 'data', 'tiny-order-cache.json');
const SEARCH = 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const DETAIL = 'https://api.tiny.com.br/api2/pedido.obter.php';

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

const accounts = [
  {empresa:'Oficial',token:process.env.TINY_OFICIAL_TOKEN},
  {empresa:'Prioriza',token:process.env.TINY_PRIORIZA_TOKEN}
];
const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const date = new Intl.DateTimeFormat('pt-BR', {timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date());

async function post(url, token, params, attempt = 0) {
  const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,formato:'JSON',...params})});
  const limit = Number(response.headers.get('x-limit-api') || 30);
  if (response.status === 429 && attempt < 6) { await wait(Math.min(60000, 5000 * 2 ** attempt)); return post(url, token, params, attempt + 1); }
  const json = await response.json();
  const root = json.retorno || {};
  if (root.status !== 'OK') {
    const message = (root.erros || []).map(x=>x.erro).join('; ') || `HTTP ${response.status}`;
    if (/Excedido o número de acessos/i.test(message) && attempt < 6) { await wait(Math.min(60000, 5000 * 2 ** attempt)); return post(url, token, params, attempt + 1); }
    throw new Error(message);
  }
  return {root,limit};
}

async function enrich(account) {
  let page=1,pages=1,orders=[],limit=30;
  do {
    const result=await post(SEARCH,account.token,{dataInicial:date,dataFinal:date,pagina:String(page),sort:'ASC'});
    limit=result.limit; pages=Number(result.root.numero_paginas||1);
    orders.push(...(result.root.pedidos||[]).map(x=>x.pedido||x)); page++;
  } while(page<=pages);
  const missing=orders.filter(x=>!cache[`${account.empresa}:${x.id}`]);
  const interval=Math.ceil(60000/Math.max(10,limit-4));
  console.log(`${account.empresa}: ${orders.length} pedidos, ${missing.length} detalhes pendentes, limite ${limit}/min`);
  for(let i=0;i<missing.length;i++){
    const summary=missing[i], result=await post(DETAIL,account.token,{id:String(summary.id)});
    const detail=result.root.pedido||summary;
    cache[`${account.empresa}:${summary.id}`]={...detail,valor:detail.valor||detail.total_pedido||summary.valor||0};
    fs.writeFileSync(CACHE_FILE,JSON.stringify(cache,null,2));
    if((i+1)%10===0||i===missing.length-1) console.log(`${account.empresa}: ${i+1}/${missing.length} detalhes concluídos`);
    await wait(interval);
  }
}

Promise.all(accounts.map(enrich)).then(()=>console.log(`Cache completo: ${Object.keys(cache).length} pedidos`)).catch(error=>{console.error(error.message);process.exitCode=1});
