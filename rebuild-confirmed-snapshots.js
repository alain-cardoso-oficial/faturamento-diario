const fs = require('fs');

const file = 'data/hourly-snapshots.json';
const snapshots = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const snapshot of snapshots) {
  const channels = {};
  const orders = {};
  const business = {};
  for (const row of snapshot.analytics || []) {
    row.contabilizado = !/^em aberto$/i.test(String(row.situacao || '').trim());
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

fs.writeFileSync(file, JSON.stringify(snapshots, null, 2));
