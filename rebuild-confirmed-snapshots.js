const fs = require('fs');

const snapshotFile = 'data/hourly-snapshots.json';
const cacheFile = 'data/tiny-order-cache.json';
const snapshots = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const byOrder = new Map();

for (const [key, order] of Object.entries(cache)) {
  byOrder.set(`${key.split(':')[0]}:${order.numero}`, order);
}

function ecommerceName(order) {
  if (typeof order.ecommerce === 'string') return order.ecommerce.trim();
  return String(order.ecommerce?.nomeEcommerce || order.ecommerce?.canalVenda || order.nome_ecommerce || order.nomeEcommerce || '').trim();
}

function channel(order) {
  const seller = String(order.nome_vendedor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (/^(GABRIEL BARBOSA|CAMILA WALESKO|ANDREIA OTTO)$/.test(seller)) return 'Vendas Diretas';
  const markers = (order.marcadores || []).map(x => x?.marcador?.descricao || x?.descricao || '').join(' ');
  const raw = [ecommerceName(order), order.intermediador?.nome, order.nome_vendedor, order.forma_pagamento, order.obs, order.observacoes, order.obs_interna, markers, order.forma_envio].filter(Boolean).join(' ').toUpperCase();
  if (/TRAY/.test(raw)) return 'Site';
  if (/MERCADO\s*LIVRE|\bMELI\b/.test(raw)) return 'Meli';
  if (/SHOPEE/.test(raw)) return 'Shopee';
  if (/MAGALU|MAGAZINE\s*LUIZA/.test(raw)) return 'MagaLu';
  if (/AMAZON/.test(raw)) return 'Amazon';
  if (/TIK\s*TOK/.test(raw)) return 'TikTok';
  if (/KABUM/.test(raw)) return 'Kabum';
  if (/MADEIRA/.test(raw)) return 'Madeira';
  if (/CARREFOUR/.test(raw)) return 'Carrefour';
  if (/LEROY/.test(raw)) return 'Leroy';
  if (/WEB\s*CONTINENTAL|\bWCO\b/.test(raw)) return 'WebContinental';
  if (/CASAS\s*BAHIA|PONTO|EXTRA|\bVIA\b/.test(raw)) return 'Via';
  if (/ALIEXPRESS/.test(raw)) return 'AliExpress';
  if (/VENDA(S)?\s+DIRETA(S)?|(^|\s)VD($|\s)/.test(raw)) return 'Vendas Diretas';
  return 'A identificar';
}

for (const snapshot of snapshots) {
  const channels = {}, orders = {}, business = {};
  for (const row of snapshot.analytics || []) {
    const detail = byOrder.get(`${row.empresa}:${row.pedido}`);
    if (detail) row.canal = channel(detail);
    row.contabilizado = !/cancelad|exclu/i.test(String(row.situacao || ''));
    if (!row.contabilizado) continue;
    channels[row.canal] = (channels[row.canal] || 0) + Number(row.valor || 0);
    orders[row.canal] = (orders[row.canal] || 0) + 1;
    const key = `${row.empresa}\u0000${row.canal}`;
    business[key] ||= {empresa:row.empresa,canal:row.canal,gmv:0,pedidos:0};
    business[key].gmv += Number(row.valor || 0);
    business[key].pedidos += 1;
  }
  snapshot.channels = channels;
  snapshot.orders = orders;
  snapshot.business = Object.values(business);
}

fs.writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2));
console.log(`Snapshots locais reconstruídos: ${snapshots.length}`);
