const http = require('http');
const fs = require('fs');
const path = require('path');
const { brDateIso, getDailyTargetValue } = require('./site/dist/daily-targets.js');
const {
  buildAccounts,
  num,
  cancelled,
  countableSale,
  sellerName,
  shouldIncludeOrder,
  channel,
  orderValue,
  analyticRow,
  formatTinyDateTimeBrt,
  computeIncrementalSinceDate,
  isOrderFromDate
} = require('./site/dist/order-classifier.js');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'site', 'dist');

function loadEnv(rootDir = ROOT, targetEnv = process.env) {
  for (const fileName of ['.env.local', '.env']) {
    const file = path.join(rootDir, fileName);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !targetEnv[match[1]]) {
        targetEnv[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
}
loadEnv();

const SNAPSHOTS = process.env.SNAPSHOTS_FILE || path.join(ROOT, 'data', 'hourly-snapshots.json');
const DETAIL_CACHE = process.env.DETAIL_CACHE_FILE || path.join(ROOT, 'data', 'tiny-order-cache.json');
const DAILY_STATE_FILE = process.env.DAILY_STATE_FILE || path.join(path.dirname(SNAPSHOTS), 'daily-orders-state.json');
const PORT = Number(process.env.PORT || 8787);
const TZ = 'America/Sao_Paulo';
const PESQUISA_ENDPOINT = process.env.TINY_PESQUISA_ENDPOINT || 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const OBTER_ENDPOINT = process.env.TINY_OBTER_ENDPOINT || 'https://api.tiny.com.br/api2/pedido.obter.php';
const DETAIL_DELAY_MS = Number(process.env.TINY_DETAIL_DELAY_MS || 1200);
const RETRY_BASE_MS = Number(process.env.TINY_RETRY_BASE_MS || 5000);
const RETRY_MAX_MS = Number(process.env.TINY_RETRY_MAX_MS || 300000);
const RETRY_MAX_ATTEMPTS = Number(process.env.TINY_RETRY_MAX_ATTEMPTS || 6);
const INCREMENTAL_INTERVAL_MS = Number(process.env.TINY_INCREMENTAL_INTERVAL_MS || 180000);
const INCREMENTAL_WINDOW_SEC = Number(process.env.TINY_INCREMENTAL_WINDOW_SEC || 180);
const INCREMENTAL_OVERLAP_SEC = Number(process.env.TINY_INCREMENTAL_OVERLAP_SEC ?? 30);
const FULL_RECONCILE_INTERVAL_MS = Number(process.env.TINY_FULL_RECONCILE_INTERVAL_MS ?? 3600000);
const SOURCE_LABEL = 'Tiny API Oficial + Prioriza + OFICIALSP + OFICIALSP2';

const accounts = buildAccounts(process.env);

const brDate = brDateIso;
const brHour = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
function apiDate(value = new Date()) { const [y, m, d] = brDate(value).split('-'); return `${d}/${m}/${y}`; }
function slotKey(iso) { const [h, m] = brHour(iso).split(':').map(Number); return `${String(h).padStart(2, '0')}:${m < 30 ? '00' : '30'}`; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function readDetailCache() { const cache = readJson(DETAIL_CACHE, {}); for (const item of Object.values(cache)) item.valor = item.valor || item.total_pedido || item.totalVenda || 0; return cache; }

function createEmptyDailyState(dataDate = brDate()) {
  return {
    dataDate,
    bootstrapped: false,
    lastFullReconcileAt: null,
    lastIncrementalAt: null,
    watermarks: {},
    lastSinceByAccount: {},
    ordersByAccount: {}
  };
}

function readDailyState(today = brDate()) {
  const raw = readJson(DAILY_STATE_FILE, null);
  if (!raw || typeof raw !== 'object' || raw.dataDate !== today) {
    return createEmptyDailyState(today);
  }
  return {
    dataDate: today,
    bootstrapped: Boolean(raw.bootstrapped),
    lastFullReconcileAt: raw.lastFullReconcileAt || null,
    lastIncrementalAt: raw.lastIncrementalAt || null,
    watermarks: raw.watermarks && typeof raw.watermarks === 'object' ? { ...raw.watermarks } : {},
    lastSinceByAccount: raw.lastSinceByAccount && typeof raw.lastSinceByAccount === 'object' ? { ...raw.lastSinceByAccount } : {},
    ordersByAccount: raw.ordersByAccount && typeof raw.ordersByAccount === 'object' ? raw.ordersByAccount : {}
  };
}

function writeDailyState(state) {
  writeJson(DAILY_STATE_FILE, state);
}

function resolveSyncMode(requestedMode, dailyState, nowMs = Date.now(), today = brDate()) {
  if (!dailyState?.bootstrapped || dailyState.dataDate !== today) {
    return 'bootstrap';
  }
  if (requestedMode === 'full') return 'full';
  if (requestedMode === 'incremental') return 'incremental';
  if (FULL_RECONCILE_INTERVAL_MS > 0) {
    const lastFullMs = dailyState.lastFullReconcileAt ? Date.parse(dailyState.lastFullReconcileAt) : NaN;
    if (!Number.isFinite(lastFullMs) || (nowMs - lastFullMs) >= FULL_RECONCILE_INTERVAL_MS) {
      return 'full';
    }
  }
  return 'incremental';
}

let updating = null;
let recoveryTimer = null;
let cancelActiveDelay = null;
let reconciliationState = { status: 'ok', pending: 0, message: '' };
let cycleDate = null;
let activeCycleMode = null;
const cycleCompletedByEmpresa = new Map();

const initialDailyState = readDailyState();

const syncQueue = {
  status: 'idle',
  mode: initialDailyState.bootstrapped ? 'incremental' : 'bootstrap',
  paused: false,
  pausedAt: null,
  pausedReason: null,
  attempt: 0,
  maxAttempts: RETRY_MAX_ATTEMPTS,
  backoffMs: null,
  nextRetryAt: null,
  lastError: null,
  startedAt: null,
  updatedAt: null,
  lastIncrementalAt: initialDailyState.lastIncrementalAt,
  lastFullReconcileAt: initialDailyState.lastFullReconcileAt,
  incrementalIntervalMs: INCREMENTAL_INTERVAL_MS,
  fullReconcileIntervalMs: FULL_RECONCILE_INTERVAL_MS,
  currentTask: null,
  accounts: accounts.map(acc => ({
    empresa: acc.empresa,
    requiredMarkers: [...acc.requiredMarkers],
    status: 'idle',
    foundOrders: 0,
    changedOrders: 0,
    activeOrders: Object.keys(initialDailyState.ordersByAccount?.[acc.empresa] || {}).length,
    pendingOrders: 0,
    processedOrders: 0,
    pendingOrderIds: [],
    lastSyncAt: initialDailyState.watermarks?.[acc.empresa] || null,
    lastSince: initialDailyState.lastSinceByAccount?.[acc.empresa] || null,
    lastError: null
  }))
};

function getAccountQueueEntry(empresa) {
  return syncQueue.accounts.find(a => a.empresa === empresa);
}

function getTotalPending() {
  return syncQueue.accounts.reduce((sum, acc) => sum + Number(acc.pendingOrders || 0), 0);
}

function getQueueSnapshot() {
  return {
    status: syncQueue.status,
    mode: syncQueue.mode,
    paused: syncQueue.paused,
    pausedAt: syncQueue.pausedAt,
    pausedReason: syncQueue.pausedReason,
    attempt: syncQueue.attempt,
    maxAttempts: syncQueue.maxAttempts,
    backoffMs: syncQueue.backoffMs,
    nextRetryAt: syncQueue.nextRetryAt,
    lastError: syncQueue.lastError,
    startedAt: syncQueue.startedAt,
    updatedAt: syncQueue.updatedAt,
    lastIncrementalAt: syncQueue.lastIncrementalAt,
    lastFullReconcileAt: syncQueue.lastFullReconcileAt,
    incrementalIntervalMs: syncQueue.incrementalIntervalMs,
    fullReconcileIntervalMs: syncQueue.fullReconcileIntervalMs,
    currentTask: syncQueue.currentTask ? { ...syncQueue.currentTask } : null,
    pendingTotal: getTotalPending(),
    accounts: syncQueue.accounts.map(acc => ({
      empresa: acc.empresa,
      requiredMarkers: [...acc.requiredMarkers],
      status: acc.status,
      foundOrders: acc.foundOrders,
      changedOrders: acc.changedOrders,
      activeOrders: acc.activeOrders,
      pendingOrders: acc.pendingOrders,
      processedOrders: acc.processedOrders,
      pendingOrderIds: [...acc.pendingOrderIds],
      lastSyncAt: acc.lastSyncAt,
      lastSince: acc.lastSince,
      lastError: acc.lastError
    }))
  };
}

function computeBackoffMs(attempt) {
  const exp = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exp));
}

function ensureNotPaused() {
  if (!syncQueue.paused) return;
  const error = new Error(syncQueue.pausedReason || 'Fila de consultas pausada pelo usuário');
  error.code = 'QUEUE_PAUSED';
  error.retryable = false;
  throw error;
}

function interruptibleDelay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancelActiveDelay = null;
      if (syncQueue.paused) {
        try { ensureNotPaused(); } catch (err) { reject(err); return; }
      }
      resolve();
    }, ms);
    cancelActiveDelay = () => {
      clearTimeout(timer);
      cancelActiveDelay = null;
      try { ensureNotPaused(); } catch (err) { reject(err); }
    };
  });
}

function pauseQueue(reason = 'Fila pausada pelo usuário') {
  syncQueue.paused = true;
  syncQueue.pausedAt = new Date().toISOString();
  syncQueue.pausedReason = String(reason || 'Fila pausada pelo usuário').trim() || 'Fila pausada pelo usuário';
  syncQueue.status = 'paused';
  syncQueue.nextRetryAt = null;
  syncQueue.backoffMs = null;
  syncQueue.currentTask = null;
  syncQueue.updatedAt = syncQueue.pausedAt;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  for (const acc of syncQueue.accounts) {
    if (['searching', 'enriching', 'retrying', 'pending'].includes(acc.status)) {
      acc.status = 'paused';
    }
  }
  reconciliationState = {
    status: 'paused',
    pending: getTotalPending(),
    message: syncQueue.pausedReason
  };
  if (cancelActiveDelay) cancelActiveDelay();
  return getQueueSnapshot();
}

function resumeQueue({ triggerNow = true } = {}) {
  syncQueue.paused = false;
  syncQueue.pausedAt = null;
  syncQueue.pausedReason = null;
  syncQueue.attempt = 0;
  syncQueue.lastError = null;
  syncQueue.nextRetryAt = null;
  syncQueue.backoffMs = null;
  syncQueue.updatedAt = new Date().toISOString();
  for (const acc of syncQueue.accounts) {
    if (['paused', 'retrying', 'failed'].includes(acc.status)) {
      acc.status = 'pending';
      acc.lastError = null;
    }
  }
  syncQueue.status = updating ? 'running' : 'idle';
  reconciliationState = {
    status: updating ? 'updating' : 'ok',
    pending: getTotalPending(),
    message: 'Fila retomada'
  };
  if (triggerNow && !updating && process.env.READ_ONLY_PREVIEW !== '1') {
    updateData({ mode: 'auto' }).catch(error => console.error(`Retomada da fila: ${error.message}`));
  }
  return getQueueSnapshot();
}

function tinyError(root, context) {
  if (root?.status === 'OK') return null;
  const code = Number(root?.codigo_erro || 0);
  const message = (root?.erros || []).map(x => x.erro).filter(Boolean).join('; ') || `Falha na API Tiny (${context})`;
  if (code === 20 || /não retornou registros/i.test(message)) return 'EMPTY';
  return new Error(`${context}: ${message}`);
}

async function tinyPost(endpoint, token, params = {}) {
  ensureNotPaused();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, formato: 'JSON', ...params }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Tiny HTTP ${response.status}`);
  return response.json();
}

async function searchOrdersByQuery(account, extraParams = {}, options = {}) {
  const isIncremental = options.mode === 'incremental' && Boolean(options.dataAtualizacao);
  const date = options.date || apiDate();
  const found = [];
  let page = 1, pages = 1;
  do {
    ensureNotPaused();
    const queryParams = isIncremental
      ? { dataAtualizacao: String(options.dataAtualizacao), pagina: String(page), ...extraParams }
      : { dataInicial: date, dataFinal: date, pagina: String(page), ...extraParams };
    const json = await tinyPost(PESQUISA_ENDPOINT, account.token, queryParams);
    const root = json?.retorno || {}, error = tinyError(root, `${account.empresa} pesquisa`);
    if (error === 'EMPTY') return found;
    if (error) throw error;
    found.push(...(root.pedidos || []).map(x => x.pedido || x).filter(Boolean));
    pages = Number(root.numero_paginas || 1);
    page += 1;
  } while (page <= pages);
  return found;
}

async function searchOrders(account, options = {}) {
  ensureNotPaused();
  if (!account.token) {
    const error = new Error(`Token Tiny não configurado para ${account.empresa}`);
    error.code = 'CONFIG_ERROR';
    throw error;
  }
  if (Array.isArray(account.requiredMarkers) && account.requiredMarkers.length > 0) {
    const byId = new Map();
    for (const marker of account.requiredMarkers) {
      const orders = await searchOrdersByQuery(account, { marcador: marker }, options);
      for (const order of orders) {
        const key = String(order.id || order.numero || '');
        if (key && !byId.has(key)) byId.set(key, order);
      }
    }
    return [...byId.values()];
  }
  return searchOrdersByQuery(account, {}, options);
}

async function getOrder(account, summary) {
  ensureNotPaused();
  const json = await tinyPost(OBTER_ENDPOINT, account.token, { id: String(summary.id) });
  const root = json?.retorno || {}, error = tinyError(root, `${account.empresa} pedido ${summary.id}`);
  if (error === 'EMPTY') return { ...summary, _tinyDetail: false };
  if (error) throw error;
  const detail = root.pedido || summary;
  return { ...detail, valor: detail.valor || detail.total_pedido || detail.totalVenda || 0, _tinyDetail: true };
}

function buildPayload(all) {
  const today = brDate(), snapshots = all.filter(s => s.dataDate === today).sort((a, b) => new Date(a.at) - new Date(b.at));
  const names = [...new Set(snapshots.flatMap(s => Object.keys(s.channels || {})))];
  const series = names.map(canal => {
    let previous = 0;
    return {
      channel: canal,
      hours: snapshots.map(s => {
        const current = num(s.channels[canal]), value = Math.max(0, current - previous);
        previous = current;
        return { hour: s.slot || slotKey(s.at), value };
      })
    };
  });
  const latest = snapshots.at(-1) || {};
  const dataDate = latest.dataDate || today;
  const totalGmv = Object.values(latest.channels || {}).reduce((sum, value) => sum + num(value), 0);
  const totalOrders = Object.values(latest.orders || {}).reduce((sum, value) => sum + num(value), 0);
  let previousGmv = null, previousOrders = null;
  const snapshotHistory = snapshots.map((snapshot, index) => {
    const gmv = Object.values(snapshot.channels || {}).reduce((sum, value) => sum + num(value), 0);
    const orderCount = Object.values(snapshot.orders || {}).reduce((sum, value) => sum + num(value), 0);
    const item = {
      at: snapshot.at,
      slot: snapshot.slot || slotKey(snapshot.at),
      gmv,
      orders: orderCount,
      isBaseline: index === 0,
      deltaGmv: index === 0 ? null : Math.max(0, gmv - previousGmv),
      deltaOrders: index === 0 ? null : Math.max(0, orderCount - previousOrders)
    };
    previousGmv = gmv;
    previousOrders = orderCount;
    return item;
  });
  return {
    updatedAt: latest.at || null,
    dataDate,
    target: getDailyTargetValue(dataDate),
    series,
    currentChannels: latest.channels || {},
    previousChannels: snapshots.at(-2)?.channels || {},
    snapshotHistory,
    snapshots: snapshots.length,
    source: SOURCE_LABEL,
    accounts: latest.accounts || [],
    business: latest.business || [],
    analytics: latest.analytics || [],
    metrics: { totalGmv, totalOrders, ticket: totalOrders ? totalGmv / totalOrders : 0 }
  };
}

function hasFullDetail(order) {
  return order?._tinyDetail === true || Array.isArray(order?.itens) || Object.prototype.hasOwnProperty.call(order || {}, 'total_pedido');
}

function hasUsableCache(account, cachedOrder) {
  if (!hasFullDetail(cachedOrder)) return false;
  if (Array.isArray(account.requiredMarkers) && account.requiredMarkers.length > 0) {
    return shouldIncludeOrder(cachedOrder, account.empresa);
  }
  return true;
}

function mergeCurrentOrder(summary, detail) {
  const order = { ...summary, ...(detail || {}) };
  for (const field of ['id', 'numero', 'situacao', 'valor', 'total_pedido', 'data_pedido', 'data_prevista']) {
    if (summary?.[field] !== undefined && summary[field] !== null && summary[field] !== '') order[field] = summary[field];
  }
  if (!sellerName(order) && sellerName(summary)) order.nome_vendedor = sellerName(summary);
  return order;
}

async function enrichAccount(account, cache, summaries, { forceRefresh = false } = {}) {
  const qAcc = getAccountQueueEntry(account.empresa);
  const pending = summaries.filter(summary => forceRefresh || !hasUsableCache(account, cache[`${account.empresa}:${summary.id}`]));
  if (qAcc) {
    qAcc.status = pending.length ? 'enriching' : 'completed';
    qAcc.foundOrders = summaries.length;
    qAcc.pendingOrders = pending.length;
    qAcc.processedOrders = summaries.length - pending.length;
    qAcc.pendingOrderIds = pending.slice(0, 50).map(s => String(s.numero || s.id));
  }
  reconciliationState = {
    status: 'updating',
    pending: getTotalPending(),
    message: pending.length
      ? `Conferindo pedidos de ${account.empresa} (${pending.length} pendente(s))`
      : `Conferindo pedidos de ${account.empresa}`
  };

  let cacheDirty = false;
  for (let i = 0; i < pending.length; i++) {
    ensureNotPaused();
    const summary = pending[i];
    syncQueue.currentTask = {
      empresa: account.empresa,
      stage: 'detalhe',
      pedidoId: String(summary.numero || summary.id)
    };
    syncQueue.updatedAt = new Date().toISOString();
    try {
      const detail = await getOrder(account, summary);
      if (hasFullDetail(detail)) {
        cache[`${account.empresa}:${summary.id}`] = detail;
        cacheDirty = true;
        if (qAcc) {
          qAcc.processedOrders += 1;
          qAcc.pendingOrders = Math.max(0, qAcc.pendingOrders - 1);
          qAcc.pendingOrderIds = pending.slice(i + 1, i + 51).map(s => String(s.numero || s.id));
        }
        reconciliationState.pending = getTotalPending();
      }
      if (i < pending.length - 1) {
        await interruptibleDelay(DETAIL_DELAY_MS);
      }
    } catch (error) {
      if (cacheDirty) writeJson(DETAIL_CACHE, cache);
      if (error.code === 'QUEUE_PAUSED') throw error;
      if (!/Excedido o número de acessos/i.test(error.message)) throw error;
      break;
    }
  }
  if (cacheDirty) writeJson(DETAIL_CACHE, cache);

  ensureNotPaused();
  const unresolved = summaries.filter(summary => countableSale(summary) && !hasFullDetail(cache[`${account.empresa}:${summary.id}`]));
  if (unresolved.length) {
    if (qAcc) {
      qAcc.pendingOrders = unresolved.length;
      qAcc.pendingOrderIds = unresolved.slice(0, 50).map(s => String(s.numero || s.id));
    }
    const error = new Error(`Reconciliação pendente em ${account.empresa}: ${unresolved.length} pedido(s) aguardando detalhe da API`);
    error.code = 'RECONCILIATION_PENDING';
    error.pending = unresolved.length;
    error.empresa = account.empresa;
    throw error;
  }

  if (qAcc) {
    qAcc.status = 'completed';
    qAcc.pendingOrders = 0;
    qAcc.pendingOrderIds = [];
    qAcc.lastError = null;
  }

  return summaries
    .map(summary => {
      const detail = cache[`${account.empresa}:${summary.id}`];
      return { order: mergeCurrentOrder(summary, detail), detailed: hasFullDetail(detail) };
    })
    .filter(item => !cancelled(item.order) && shouldIncludeOrder(item.order, account.empresa));
}

async function updateData({ mode: requestedMode = 'auto' } = {}) {
  ensureNotPaused();
  if (updating) return updating;

  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  const today = brDate();
  const dailyState = readDailyState(today);
  if (cycleDate !== today) {
    cycleDate = today;
    activeCycleMode = null;
    cycleCompletedByEmpresa.clear();
  }

  let effectiveMode;
  if (cycleCompletedByEmpresa.size > 0 && activeCycleMode && (requestedMode === 'auto' || requestedMode === activeCycleMode)) {
    effectiveMode = activeCycleMode;
  } else {
    effectiveMode = resolveSyncMode(requestedMode, dailyState, Date.now(), today);
    if (effectiveMode !== activeCycleMode) {
      cycleCompletedByEmpresa.clear();
      activeCycleMode = effectiveMode;
    }
  }

  syncQueue.status = 'running';
  syncQueue.mode = effectiveMode;
  syncQueue.startedAt = new Date().toISOString();
  syncQueue.updatedAt = syncQueue.startedAt;
  syncQueue.nextRetryAt = null;
  syncQueue.backoffMs = null;

  for (const acc of syncQueue.accounts) {
    if (!cycleCompletedByEmpresa.has(acc.empresa)) {
      acc.status = 'pending';
    }
  }

  reconciliationState = {
    status: 'updating',
    pending: getTotalPending(),
    message: effectiveMode === 'incremental'
      ? 'Sincronizando alterações recentes (janela 3 min)'
      : 'Conferindo todos os pedidos do dia'
  };

  updating = (async () => {
    const cache = readDetailCache();
    let activeAccount = null;

    try {
      for (const account of accounts) {
        ensureNotPaused();
        activeAccount = account;
        const qAcc = getAccountQueueEntry(account.empresa);

        if (cycleCompletedByEmpresa.has(account.empresa)) {
          if (qAcc) qAcc.status = 'completed';
          continue;
        }

        const accountWatermark = dailyState.watermarks?.[account.empresa] || null;
        const accountMode = (effectiveMode === 'incremental' && accountWatermark) ? 'incremental' : (effectiveMode === 'bootstrap' ? 'bootstrap' : 'full');
        const queryStartedIso = new Date().toISOString();
        let dataAtualizacao = null;

        if (accountMode === 'incremental') {
          const sinceDate = computeIncrementalSinceDate({
            watermarkIso: accountWatermark,
            nowMs: Date.parse(queryStartedIso),
            windowSec: INCREMENTAL_WINDOW_SEC,
            overlapSec: INCREMENTAL_OVERLAP_SEC
          });
          dataAtualizacao = formatTinyDateTimeBrt(sinceDate);
        }

        if (qAcc) {
          qAcc.status = 'searching';
          qAcc.lastError = null;
          qAcc.lastSince = dataAtualizacao;
        }
        syncQueue.currentTask = {
          empresa: account.empresa,
          stage: 'pesquisa',
          mode: accountMode,
          dataAtualizacao,
          pedidoId: null
        };
        syncQueue.updatedAt = new Date().toISOString();

        const rawSummaries = await searchOrders(account, {
          mode: accountMode === 'incremental' ? 'incremental' : 'full',
          dataAtualizacao
        });

        const existingAccountOrders = (
          dailyState.ordersByAccount[account.empresa] &&
          typeof dailyState.ordersByAccount[account.empresa] === 'object'
        )
          ? { ...dailyState.ordersByAccount[account.empresa] }
          : {};

        if (accountMode === 'incremental') {
          // Descarta pedidos de dias anteriores antes mesmo de consultar pedido.obter.php
          for (const summary of rawSummaries) {
            const key = String(summary.id || summary.numero || '');
            if (key && !isOrderFromDate(summary, today)) {
              delete existingAccountOrders[key];
            }
          }
          const relevantSummaries = rawSummaries.filter(s => isOrderFromDate(s, today));
          if (qAcc) qAcc.changedOrders = relevantSummaries.length;

          await enrichAccount(account, cache, relevantSummaries, { forceRefresh: true });

          for (const summary of relevantSummaries) {
            const key = String(summary.id || summary.numero || '');
            if (!key) continue;
            const detail = cache[`${account.empresa}:${summary.id}`];
            const merged = mergeCurrentOrder(summary, detail);
            const detailed = hasFullDetail(detail);
            if (isOrderFromDate(merged, today) && !cancelled(merged) && shouldIncludeOrder(merged, account.empresa)) {
              existingAccountOrders[key] = { order: merged, detailed };
            } else {
              delete existingAccountOrders[key];
            }
          }

          dailyState.ordersByAccount[account.empresa] = existingAccountOrders;
        } else {
          const todaySummaries = rawSummaries.filter(s => isOrderFromDate(s, today));
          if (qAcc) qAcc.changedOrders = todaySummaries.length;

          await enrichAccount(account, cache, todaySummaries, { forceRefresh: false });

          const nextAccountOrders = {};
          for (const summary of todaySummaries) {
            const key = String(summary.id || summary.numero || '');
            if (!key) continue;
            const detail = cache[`${account.empresa}:${summary.id}`];
            const merged = mergeCurrentOrder(summary, detail);
            const detailed = hasFullDetail(detail);
            if (isOrderFromDate(merged, today) && !cancelled(merged) && shouldIncludeOrder(merged, account.empresa)) {
              nextAccountOrders[key] = { order: merged, detailed };
            }
          }
          dailyState.ordersByAccount[account.empresa] = nextAccountOrders;
        }

        dailyState.watermarks[account.empresa] = queryStartedIso;
        dailyState.lastSinceByAccount[account.empresa] = dataAtualizacao;
        writeDailyState(dailyState);

        if (qAcc) {
          qAcc.lastSyncAt = queryStartedIso;
          qAcc.lastSince = dataAtualizacao;
          qAcc.activeOrders = Object.keys(dailyState.ordersByAccount[account.empresa] || {}).length;
        }

        cycleCompletedByEmpresa.set(account.empresa, true);
      }
    } catch (error) {
      if (activeAccount) {
        const qAcc = getAccountQueueEntry(activeAccount.empresa);
        if (qAcc) {
          qAcc.lastError = error.message;
          qAcc.status = error.code === 'QUEUE_PAUSED' ? 'paused' : 'retrying';
        }
      }
      throw error;
    }

    const now = new Date().toISOString();
    const currentDay = brDate(now);
    const slot = slotKey(now);

    if (effectiveMode === 'bootstrap' || effectiveMode === 'full') {
      dailyState.bootstrapped = true;
      dailyState.lastFullReconcileAt = now;
      syncQueue.lastFullReconcileAt = now;
    }
    dailyState.lastIncrementalAt = now;
    syncQueue.lastIncrementalAt = now;
    writeDailyState(dailyState);

    const channels = {}, orders = {}, business = [], analytics = [], accountStatus = [];
    for (const account of accounts) {
      const accountMap = dailyState.ordersByAccount[account.empresa] || {};
      const items = Object.values(accountMap).filter(
        item => item?.order && isOrderFromDate(item.order, currentDay) && !cancelled(item.order) && shouldIncludeOrder(item.order, account.empresa)
      );
      accountStatus.push({ empresa: account.empresa, pedidos: items.length });
      const company = {};
      for (const item of items) {
        const canal = channel(item.order, account.empresa), gmv = orderValue(item.order);
        analytics.push(analyticRow(item.order, account.empresa, item.detailed));
        if (!countableSale(item.order)) continue;
        channels[canal] = (channels[canal] || 0) + gmv;
        orders[canal] = (orders[canal] || 0) + 1;
        company[canal] = (company[canal] || 0) + gmv;
      }
      for (const [canal, gmv] of Object.entries(company)) {
        business.push({
          empresa: account.empresa,
          canal,
          gmv,
          pedidos: items.filter(x => countableSale(x.order) && channel(x.order, account.empresa) === canal).length
        });
      }
    }
    analytics.sort((a, b) => b.valor - a.valor);

    let snapshots = readJson(SNAPSHOTS, []).filter(s => s.dataDate === currentDay);
    const snapshot = { at: now, dataDate: currentDay, slot, channels, orders, business, analytics, accounts: accountStatus };
    const existing = snapshots.findIndex(s => (s.slot || slotKey(s.at)) === slot);
    if (existing >= 0) snapshots[existing] = snapshot; else snapshots.push(snapshot);
    snapshots = snapshots.sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-48);
    for (let i = 0; i < snapshots.length - 1; i++) {
      if (snapshots[i].analytics) delete snapshots[i].analytics;
    }
    writeJson(SNAPSHOTS, snapshots);

    cycleCompletedByEmpresa.clear();
    activeCycleMode = null;
    syncQueue.status = 'idle';
    syncQueue.mode = 'incremental';
    syncQueue.attempt = 0;
    syncQueue.lastError = null;
    syncQueue.backoffMs = null;
    syncQueue.nextRetryAt = null;
    syncQueue.currentTask = null;
    syncQueue.updatedAt = now;
    reconciliationState = { status: 'ok', pending: 0, message: 'Carga reconciliada sem pendências' };
    return buildPayload(snapshots);
  })();

  try {
    return await updating;
  } catch (error) {
    syncQueue.currentTask = null;
    syncQueue.updatedAt = new Date().toISOString();

    if (error.code === 'QUEUE_PAUSED' || syncQueue.paused) {
      syncQueue.status = 'paused';
      syncQueue.backoffMs = null;
      syncQueue.nextRetryAt = null;
      reconciliationState = {
        status: 'paused',
        pending: getTotalPending(),
        message: syncQueue.pausedReason || error.message
      };
      throw error;
    }

    syncQueue.attempt += 1;
    syncQueue.lastError = error.message;

    if (syncQueue.attempt <= RETRY_MAX_ATTEMPTS) {
      const delayMs = computeBackoffMs(syncQueue.attempt);
      const nextRetryIso = new Date(Date.now() + delayMs).toISOString();
      syncQueue.status = 'waiting_retry';
      syncQueue.backoffMs = delayMs;
      syncQueue.nextRetryAt = nextRetryIso;
      reconciliationState = {
        status: 'retrying',
        pending: Number(error.pending || getTotalPending() || 0),
        attempt: syncQueue.attempt,
        maxAttempts: RETRY_MAX_ATTEMPTS,
        backoffMs: delayMs,
        nextRetryAt: nextRetryIso,
        message: `${error.message} (retry #${syncQueue.attempt} em ${Math.max(1, Math.round(delayMs / 1000))}s)`
      };
      queueRecovery(delayMs);
    } else {
      syncQueue.status = 'failed';
      syncQueue.backoffMs = null;
      syncQueue.nextRetryAt = null;
      for (const acc of syncQueue.accounts) {
        if (acc.status === 'retrying') acc.status = 'failed';
      }
      reconciliationState = {
        status: 'failed',
        pending: Number(error.pending || getTotalPending() || 0),
        attempt: syncQueue.attempt,
        maxAttempts: RETRY_MAX_ATTEMPTS,
        message: `Limite de tentativas atingido (${RETRY_MAX_ATTEMPTS}): ${error.message}`
      };
    }
    throw error;
  } finally {
    updating = null;
  }
}

function queueRecovery(delayMs = RETRY_BASE_MS) {
  if (recoveryTimer || syncQueue.paused) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (syncQueue.paused) return;
    try {
      await updateData({ mode: activeCycleMode || 'auto' });
      console.log('Reconciliação automática concluída');
    } catch (error) {
      console.error(`Reconciliação automática: ${error.message}`);
    }
  }, Math.max(10, Number(delayMs || RETRY_BASE_MS)));
  recoveryTimer.unref?.();
}

function schedule() {
  const delay = Math.max(2000, INCREMENTAL_INTERVAL_MS);
  setTimeout(async () => {
    if (!syncQueue.paused && process.env.READ_ONLY_PREVIEW !== '1') {
      try {
        await updateData({ mode: 'auto' });
        console.log(`Snapshot Tiny atualizado (${syncQueue.mode}): ${brHour(new Date())}`);
      } catch (error) {
        console.error(`Atualização Tiny: ${error.message}`);
      }
    }
    schedule();
  }, delay);
}

function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      if (raw.length < 16384) raw += String(chunk);
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function checkQueueControlAuth(req) {
  const required = process.env.QUEUE_CONTROL_TOKEN;
  if (!required) return true;
  return req.headers['x-queue-token'] === required;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serve(req, res) {
  const url = new URL(req.url, 'http://localhost'),
    file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)),
    target = path.resolve(PUBLIC, file);
  if (!target.startsWith(path.resolve(PUBLIC))) return json(res, 403, { error: 'Acesso negado' });
  fs.readFile(target, (error, data) => {
    if (error) return json(res, 404, { error: 'Não encontrado' });
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png'
    }[path.extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/queue' && req.method === 'GET') {
    return json(res, 200, {
      ...getQueueSnapshot(),
      updating: Boolean(updating),
      reconciliation: reconciliationState
    });
  }

  if (url.pathname === '/api/queue/pause' && req.method === 'POST') {
    if (process.env.READ_ONLY_PREVIEW === '1') {
      return json(res, 409, { error: 'Prévia local protegida: controle de fila desativado' });
    }
    if (!checkQueueControlAuth(req)) {
      return json(res, 403, { error: 'Token de controle de fila inválido' });
    }
    const body = await readRequestBody(req);
    const queue = pauseQueue(body.reason);
    return json(res, 200, { ok: true, queue, reconciliation: reconciliationState });
  }

  if (url.pathname === '/api/queue/resume' && req.method === 'POST') {
    if (process.env.READ_ONLY_PREVIEW === '1') {
      return json(res, 409, { error: 'Prévia local protegida: controle de fila desativado' });
    }
    if (!checkQueueControlAuth(req)) {
      return json(res, 403, { error: 'Token de controle de fila inválido' });
    }
    const body = await readRequestBody(req);
    const triggerNow = body.triggerNow !== false;
    const queue = resumeQueue({ triggerNow });
    return json(res, 200, { ok: true, queue, reconciliation: reconciliationState });
  }

  if (url.pathname === '/api/update-data') {
    if (process.env.READ_ONLY_PREVIEW === '1') {
      return json(res, 409, { error: 'Prévia local protegida: atualização da API desativada' });
    }
    if (syncQueue.paused) {
      return json(res, 409, {
        error: 'Fila pausada: retome a fila antes de atualizar os dados',
        reconciliation: reconciliationState,
        queue: getQueueSnapshot()
      });
    }
    const body = req.method === 'POST' ? await readRequestBody(req) : {};
    const requestedMode = url.searchParams.get('mode') || body.mode || 'auto';
    try {
      return json(res, 200, {
        ...await updateData({ mode: requestedMode }),
        reconciliation: reconciliationState,
        queue: getQueueSnapshot()
      });
    } catch (error) {
      console.error(error);
      const statusCode = error.code === 'QUEUE_PAUSED' ? 409 : 500;
      return json(res, statusCode, {
        error: error.message,
        reconciliation: reconciliationState,
        queue: getQueueSnapshot()
      });
    }
  }

  if (url.pathname === '/api/data') {
    return json(res, 200, {
      ...buildPayload(readJson(SNAPSHOTS, [])),
      updating: Boolean(updating),
      reconciliation: reconciliationState,
      queue: getQueueSnapshot()
    });
  }

  serve(req, res);
}).listen(PORT, () => {
  console.log(`Black Friday BI Tiny: http://localhost:${PORT}`);
  if (process.env.DISABLE_AUTO_UPDATE !== '1') schedule();
});
