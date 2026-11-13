const fs = require('fs');
const {
  channel,
  countableSale,
  classifyFulfillment,
  shouldIncludeOrder
} = require('./site/dist/order-classifier.js');

const snapshotFile = 'data/hourly-snapshots.json';
const cacheFile = 'data/tiny-order-cache.json';
const snapshots = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const byOrder = new Map();

for (const [key, order] of Object.entries(cache)) {
  byOrder.set(`${key.split(':')[0]}:${order.numero}`, order);
}

for (const snapshot of snapshots) {
  const channels = {}, orders = {}, business = {}, nextAnalytics = [];
  for (const row of snapshot.analytics || []) {
    const detail = byOrder.get(`${row.empresa}:${row.pedido}`);
    if (detail) {
      if (!shouldIncludeOrder(detail, row.empresa)) continue;
      const ff = classifyFulfillment(detail, row.empresa);
      row.canal = channel(detail, row.empresa);
      row.fulfillment = ff.fulfillment;
      row.fulfillmentOrigem = ff.fulfillmentOrigem;
      row.modalidade = ff.fulfillment ? 'Fulfillment' : 'Padrão';
    } else {
      const isFf = Boolean(row.fulfillment) || String(row.modalidade || '').toLowerCase() === 'fulfillment';
      row.fulfillment = isFf;
      row.fulfillmentOrigem = row.fulfillmentOrigem || null;
      row.modalidade = isFf ? 'Fulfillment' : 'Padrão';
    }
    row.contabilizado = countableSale({ situacao: row.situacao });
    nextAnalytics.push(row);
    if (!row.contabilizado) continue;
    channels[row.canal] = (channels[row.canal] || 0) + Number(row.valor || 0);
    orders[row.canal] = (orders[row.canal] || 0) + 1;
    const key = `${row.empresa}\u0000${row.canal}`;
    business[key] ||= { empresa: row.empresa, canal: row.canal, gmv: 0, pedidos: 0 };
    business[key].gmv += Number(row.valor || 0);
    business[key].pedidos += 1;
  }
  snapshot.analytics = nextAnalytics;
  snapshot.channels = channels;
  snapshot.orders = orders;
  snapshot.business = Object.values(business);
}

fs.writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2));
console.log(`Snapshots locais reconstruídos: ${snapshots.length}`);
