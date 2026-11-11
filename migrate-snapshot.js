const fs=require('fs');
const file='data/hourly-snapshots.json';
const snapshots=JSON.parse(fs.readFileSync(file,'utf8'));
for(const snapshot of snapshots){
  if(!Array.isArray(snapshot.analytics))continue;
  for(const row of snapshot.analytics){if(row.canal==='Vendas Diretas'&&row.detalhe!=='Completo')row.canal='A identificar'}
  snapshot.channels={};snapshot.orders={};
  const business={};
  for(const row of snapshot.analytics){snapshot.channels[row.canal]=(snapshot.channels[row.canal]||0)+Number(row.valor||0);snapshot.orders[row.canal]=(snapshot.orders[row.canal]||0)+1;const key=`${row.empresa}\u0000${row.canal}`;business[key]??={empresa:row.empresa,canal:row.canal,gmv:0,pedidos:0};business[key].gmv+=Number(row.valor||0);business[key].pedidos++}
  snapshot.business=Object.values(business);
}
fs.writeFileSync(file,JSON.stringify(snapshots,null,2));
