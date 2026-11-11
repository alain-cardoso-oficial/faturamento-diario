const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'site', 'dist');
const SNAPSHOTS = path.join(ROOT, 'data', 'hourly-snapshots.json');
const DETAIL_CACHE = path.join(ROOT, 'data', 'tiny-order-cache.json');
const PORT = Number(process.env.PORT || 8787);
const TZ = 'America/Sao_Paulo';
const PESQUISA_ENDPOINT = 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const OBTER_ENDPOINT = 'https://api.tiny.com.br/api2/pedido.obter.php';
const DETAIL_DELAY_MS = Number(process.env.TINY_DETAIL_DELAY_MS || 1200);

function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
loadEnv();

const accounts = [
  { empresa: 'Oficial', token: process.env.TINY_OFICIAL_TOKEN },
  { empresa: 'Prioriza', token: process.env.TINY_PRIORIZA_TOKEN }
];

const brDate = (value = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value));
const brHour = iso => new Intl.DateTimeFormat('pt-BR', { timeZone:TZ, hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(iso));
function apiDate(value = new Date()) { const [y,m,d] = brDate(value).split('-'); return `${d}/${m}/${y}`; }
function slotKey(iso) { const [h,m] = brHour(iso).split(':').map(Number); return `${String(h).padStart(2,'0')}:${m < 30 ? '00' : '30'}`; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function readDetailCache() { const cache = readJson(DETAIL_CACHE, {}); for (const item of Object.values(cache)) item.valor = item.valor || item.total_pedido || item.totalVenda || 0; return cache; }

function tinyError(root, context) {
  if (root?.status === 'OK') return null;
  const code = Number(root?.codigo_erro || 0);
  const message = (root?.erros || []).map(x => x.erro).filter(Boolean).join('; ') || `Falha na API Tiny (${context})`;
  if (code === 20 || /não retornou registros/i.test(message)) return 'EMPTY';
  return new Error(`${context}: ${message}`);
}
async function tinyPost(endpoint, token, params = {}) {
  const response = await fetch(endpoint, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({token, formato:'JSON', ...params}),
    signal:AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Tiny HTTP ${response.status}`);
  return response.json();
}
async function searchOrders(account) {
  if (!account.token) throw new Error(`Token Tiny não configurado para ${account.empresa}`);
  const date = apiDate(), found = [];
  let page = 1, pages = 1;
  do {
    const json = await tinyPost(PESQUISA_ENDPOINT, account.token, {dataInicial:date, dataFinal:date, pagina:String(page)});
    const root = json?.retorno || {}, error = tinyError(root, `${account.empresa} pesquisa`);
    if (error === 'EMPTY') return [];
    if (error) throw error;
    found.push(...(root.pedidos || []).map(x => x.pedido || x).filter(Boolean));
    pages = Number(root.numero_paginas || 1);
    page += 1;
  } while (page <= pages);
  return found;
}
async function getOrder(account, summary) {
  const json = await tinyPost(OBTER_ENDPOINT, account.token, {id:String(summary.id)});
  const root = json?.retorno || {}, error = tinyError(root, `${account.empresa} pedido ${summary.id}`);
  if (error === 'EMPTY') return {...summary, _tinyDetail:false};
  if (error) throw error;
  const detail = root.pedido || summary;
  return {...detail, valor:detail.valor || detail.total_pedido || detail.totalVenda || 0, _tinyDetail:true};
}
const num = value => { const parsed = Number(String(value ?? 0).replace(',','.')); return Number.isFinite(parsed) ? parsed : 0; };
const cancelled = order => /cancelad|exclu/i.test(String(order.situacao || ''));
const countableSale = order => !cancelled(order);
function ecommerceName(order) {
  if (typeof order.ecommerce === 'string') return order.ecommerce.trim();
  return String(order.ecommerce?.nomeEcommerce || order.ecommerce?.canalVenda || order.nome_ecommerce || order.nomeEcommerce || '').trim();
}
function channel(order) {
  const markers = (order.marcadores || []).map(x => x?.marcador?.descricao || x?.descricao || '').join(' ');
  const seller = String(order.nome_vendedor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (/^(GABRIEL BARBOSA|CAMILA WALESKO|ANDREIA OTTO)$/.test(seller)) return 'Vendas Diretas';
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
function orderValue(order) {
  return num(order.valor || order.total_pedido || order.totalVenda || order.total_venda || order.totalProdutos || order.total_produtos)
    || num(order.totalProdutos || order.total_produtos) + num(order.frete || order.valor_frete) - num(order.desconto || order.valor_desconto);
}
function analyticRow(order, empresa, detailed) {
  return {
    empresa,
    pedido:String(order.numero || order.id || '—'),
    canal:channel(order),
    ecommerce:ecommerceName(order) || 'Sem e-commerce',
    situacao:String(order.situacao || '—'),
    valor:orderValue(order),
    detalhe:detailed ? 'Completo' : 'Pendente'
    ,contabilizado:countableSale(order)
  };
}

function buildPayload(all) {
  const today = brDate(), snapshots = all.filter(s => s.dataDate === today).sort((a,b) => new Date(a.at)-new Date(b.at));
  const names = [...new Set(snapshots.flatMap(s => Object.keys(s.channels || {})))];
  const series = names.map(canal => { let previous = 0; return {channel:canal,hours:snapshots.map(s => { const current=num(s.channels[canal]), value=Math.max(0,current-previous); previous=current; return {hour:s.slot || slotKey(s.at),value}; })}; });
  const latest = snapshots.at(-1) || {};
  const totalGmv = Object.values(latest.channels || {}).reduce((sum,value)=>sum+num(value),0);
  const totalOrders = Object.values(latest.orders || {}).reduce((sum,value)=>sum+num(value),0);
  let previousGmv = null, previousOrders = null;
  const snapshotHistory = snapshots.map((snapshot,index) => {
    const gmv = Object.values(snapshot.channels || {}).reduce((sum,value)=>sum+num(value),0);
    const orderCount = Object.values(snapshot.orders || {}).reduce((sum,value)=>sum+num(value),0);
    const item = {at:snapshot.at,slot:snapshot.slot || slotKey(snapshot.at),gmv,orders:orderCount,isBaseline:index===0,deltaGmv:index===0?null:Math.max(0,gmv-previousGmv),deltaOrders:index===0?null:Math.max(0,orderCount-previousOrders)};
    previousGmv = gmv; previousOrders = orderCount;
    return item;
  });
  return {updatedAt:latest.at||null,dataDate:latest.dataDate||today,series,currentChannels:latest.channels||{},previousChannels:snapshots.at(-2)?.channels||{},snapshotHistory,snapshots:snapshots.length,source:'Tiny API Oficial + Prioriza',accounts:latest.accounts||[],business:latest.business||[],analytics:latest.analytics||[],metrics:{totalGmv,totalOrders,ticket:totalOrders?totalGmv/totalOrders:0}};
}

let updating = null;
let recoveryTimer = null;
let reconciliationState = {status:'ok', pending:0, message:''};
function hasFullDetail(order) {
  return order?._tinyDetail === true || Array.isArray(order?.itens) || Object.prototype.hasOwnProperty.call(order || {}, 'total_pedido');
}
async function enrichAccount(account, cache, summaries) {
  const pending = summaries.filter(summary => !hasFullDetail(cache[`${account.empresa}:${summary.id}`]));
  for (const summary of pending) {
    try {
      const detail = await getOrder(account, summary);
      if (hasFullDetail(detail)) {
        cache[`${account.empresa}:${summary.id}`] = detail;
        writeJson(DETAIL_CACHE, cache);
      }
      await new Promise(resolve => setTimeout(resolve, DETAIL_DELAY_MS));
    } catch (error) {
      if (!/Excedido o número de acessos/i.test(error.message)) throw error;
      break;
    }
  }
  const unresolved = summaries.filter(summary => countableSale(summary) && !hasFullDetail(cache[`${account.empresa}:${summary.id}`]));
  if (unresolved.length) {
    const error = new Error(`Reconciliação pendente em ${account.empresa}: ${unresolved.length} pedido(s) aguardando detalhe da API`);
    error.code = 'RECONCILIATION_PENDING';
    error.pending = unresolved.length;
    throw error;
  }
  return summaries.map(summary => {
    const detail = cache[`${account.empresa}:${summary.id}`];
    return {order:{...summary,...(detail || {})}, detailed:hasFullDetail(detail)};
  }).filter(item => !cancelled(item.order));
}
async function updateData() {
  if (updating) return updating;
  reconciliationState = {status:'updating', pending:0, message:'Conferindo todos os pedidos do dia'};
  updating = (async () => {
    const cache = readDetailCache();
    const summariesByAccount = await Promise.all(accounts.map(searchOrders));
    const results = [];
    for (let index=0; index<accounts.length; index++) results.push({account:accounts[index], items:await enrichAccount(accounts[index], cache, summariesByAccount[index])});
    writeJson(DETAIL_CACHE, cache);
    const channels = {}, orders = {}, business = [], analytics = [], accountStatus = [];
    for (const {account,items} of results) {
      accountStatus.push({empresa:account.empresa,pedidos:items.length});
      const company = {};
      for (const item of items) {
        const canal = channel(item.order), gmv = orderValue(item.order);
        analytics.push(analyticRow(item.order, account.empresa, item.detailed));
        if (!countableSale(item.order)) continue;
        channels[canal] = (channels[canal] || 0) + gmv;
        orders[canal] = (orders[canal] || 0) + 1;
        company[canal] = (company[canal] || 0) + gmv;
      }
      for (const [canal,gmv] of Object.entries(company)) business.push({empresa:account.empresa,canal,gmv,pedidos:items.filter(x=>countableSale(x.order)&&channel(x.order)===canal).length});
    }
    analytics.sort((a,b)=>b.valor-a.valor);
    const now = new Date().toISOString(), today = brDate(now), slot = slotKey(now);
    let snapshots = readJson(SNAPSHOTS, []).filter(s => s.dataDate === today);
    const snapshot = {at:now,dataDate:today,slot,channels,orders,business,analytics,accounts:accountStatus};
    const existing = snapshots.findIndex(s => (s.slot || slotKey(s.at)) === slot);
    if (existing >= 0) snapshots[existing] = snapshot; else snapshots.push(snapshot);
    snapshots = snapshots.sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(-48);
    writeJson(SNAPSHOTS, snapshots);
    reconciliationState = {status:'ok', pending:0, message:'Carga reconciliada sem pendências'};
    return buildPayload(snapshots);
  })();
  try { return await updating; }
  catch (error) {
    reconciliationState = {status:'retrying', pending:Number(error.pending||0), message:error.message};
    if (error.code === 'RECONCILIATION_PENDING' || /Excedido o número de acessos/i.test(error.message)) queueRecovery();
    throw error;
  }
  finally { updating = null; }
}
function queueRecovery() {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    try { await updateData(); console.log('Reconciliação automática concluída'); }
    catch (error) { console.error(`Reconciliação automática: ${error.message}`); }
  }, 60000);
  recoveryTimer.unref?.();
}
function schedule() {
  const now = new Date(), delay = (30-now.getMinutes()%30)*60000-now.getSeconds()*1000-now.getMilliseconds()+2000;
  setTimeout(async()=>{try{await updateData();console.log(`Snapshot Tiny atualizado: ${brHour(new Date())}`)}catch(error){console.error(`Atualização Tiny: ${error.message}`)}schedule()},Math.max(delay,2000));
}
function json(res,code,body){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
function serve(req,res){const url=new URL(req.url,'http://localhost'),file=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(PUBLIC,file);if(!target.startsWith(path.resolve(PUBLIC)))return json(res,403,{error:'Acesso negado'});fs.readFile(target,(error,data)=>{if(error)return json(res,404,{error:'Não encontrado'});const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'}[path.extname(target)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);});}
http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/api/update-data'){if(process.env.READ_ONLY_PREVIEW==='1')return json(res,409,{error:'Prévia local protegida: atualização da API desativada'});try{return json(res,200,{...await updateData(),reconciliation:reconciliationState})}catch(error){console.error(error);return json(res,500,{error:error.message,reconciliation:reconciliationState})}}if(url.pathname==='/api/data')return json(res,200,{...buildPayload(readJson(SNAPSHOTS,[])),updating:Boolean(updating),reconciliation:reconciliationState});serve(req,res);}).listen(PORT,()=>{console.log(`Black Friday BI Tiny: http://localhost:${PORT}`);if(process.env.DISABLE_AUTO_UPDATE!=='1')schedule();});
