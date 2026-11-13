const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const dailyTargets = require(path.join(ROOT, 'site', 'dist', 'daily-targets.js'));

const EXPECTED_NOV_2026 = [
  { data: '01/11/2026', dia: 'Domingo', meta: 82613 },
  { data: '02/11/2026', dia: 'Segunda-feira', meta: 139942 },
  { data: '03/11/2026', dia: 'Terça-feira', meta: 262832 },
  { data: '04/11/2026', dia: 'Quarta-feira', meta: 252939 },
  { data: '05/11/2026', dia: 'Quinta-feira', meta: 251419 },
  { data: '06/11/2026', dia: 'Sexta-feira', meta: 210552 },
  { data: '07/11/2026', dia: 'Sábado', meta: 114005 },
  { data: '08/11/2026', dia: 'Domingo', meta: 118019 },
  { data: '09/11/2026', dia: 'Segunda-feira', meta: 234051 },
  { data: '10/11/2026', dia: 'Terça-feira', meta: 262832 },
  { data: '11/11/2026', dia: 'Quarta-feira', meta: 671585 },
  { data: '12/11/2026', dia: 'Quinta-feira', meta: 251419 },
  { data: '13/11/2026', dia: 'Sexta-feira', meta: 210552 },
  { data: '14/11/2026', dia: 'Sábado', meta: 114005 },
  { data: '15/11/2026', dia: 'Domingo', meta: 82613 },
  { data: '16/11/2026', dia: 'Segunda-feira', meta: 234051 },
  { data: '17/11/2026', dia: 'Terça-feira', meta: 262832 },
  { data: '18/11/2026', dia: 'Quarta-feira', meta: 252939 },
  { data: '19/11/2026', dia: 'Quinta-feira', meta: 251419 },
  { data: '20/11/2026', dia: 'Sexta-feira', meta: 147387 },
  { data: '21/11/2026', dia: 'Sábado', meta: 114005 },
  { data: '22/11/2026', dia: 'Domingo', meta: 118019 },
  { data: '23/11/2026', dia: 'Segunda-feira', meta: 234051 },
  { data: '24/11/2026', dia: 'Terça-feira', meta: 262832 },
  { data: '25/11/2026', dia: 'Quarta-feira', meta: 252939 },
  { data: '26/11/2026', dia: 'Quinta-feira', meta: 251419 },
  { data: '27/11/2026', dia: 'Sexta-feira', meta: 392660 },
  { data: '28/11/2026', dia: 'Sábado', meta: 114005 },
  { data: '29/11/2026', dia: 'Domingo', meta: 118019 },
  { data: '30/11/2026', dia: 'Segunda-feira', meta: 234051 }
];

const WEEKDAYS_PT = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado'
];

test('TC-001/002/003: cronograma completo de 30 dias corresponde exatamente à tabela oficial', () => {
  assert.equal(dailyTargets.DAILY_TARGETS_SCHEDULE.length, 30);

  const seenDates = new Set();
  for (let i = 0; i < EXPECTED_NOV_2026.length; i++) {
    const expected = EXPECTED_NOV_2026[i];
    const actual = dailyTargets.DAILY_TARGETS_SCHEDULE[i];
    assert.equal(actual.data, expected.data);
    assert.equal(actual.dia, expected.dia);
    assert.equal(actual.meta, expected.meta);
    assert.ok(!seenDates.has(actual.isoDate), `Data duplicada: ${actual.isoDate}`);
    seenDates.add(actual.isoDate);

    const [dd, mm, yyyy] = expected.data.split('/').map(Number);
    const utcDate = new Date(Date.UTC(yyyy, mm - 1, dd, 12, 0, 0));
    assert.equal(WEEKDAYS_PT[utcDate.getUTCDay()], expected.dia);
    assert.equal(dailyTargets.getDailyTargetValue(expected.data), expected.meta);
    assert.equal(dailyTargets.getDailyTargetValue(actual.isoDate), expected.meta);
  }
});

test('TC-004: resolução respeita fuso America/Sao_Paulo na virada de dia UTC', () => {
  const beforeMidnightBrt = new Date('2026-11-14T02:59:59.000Z');
  const afterMidnightBrt = new Date('2026-11-14T03:00:00.000Z');

  assert.equal(dailyTargets.brDateIso(beforeMidnightBrt), '2026-11-13');
  assert.equal(dailyTargets.getDailyTargetValue(beforeMidnightBrt), 210552);

  assert.equal(dailyTargets.brDateIso(afterMidnightBrt), '2026-11-14');
  assert.equal(dailyTargets.getDailyTargetValue(afterMidnightBrt), 114005);
});

test('TC-005: datas fora de novembro/2026 ou inválidas retornam null sem exceção', () => {
  for (const input of ['2026-10-31', '2026-12-01', '31/12/2026', 'invalid', new Date('invalid')]) {
    assert.equal(dailyTargets.getDailyTargetEntry(input), null);
    assert.equal(dailyTargets.getDailyTargetValue(input), null);
  }
});

test('TC-006/007: frontend calcula meta diária, superação, estado vazio e ausência de meta sem hardcoded 671585', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /671\.?585/);
  assert.match(html, /<script src="daily-targets\.js"><\/script>/);
  assert.match(html, /id="targetAmount"/);

  const targetsCode = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'daily-targets.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'app.js'), 'utf8');

  const elements = new Map();
  const makeEl = () => ({
    textContent: '',
    innerHTML: '',
    value: 'all',
    className: '',
    style: {},
    dataset: {},
    classList: {
      toggle() {},
      add() {},
      remove() {}
    },
    addEventListener() {}
  });
  for (const id of [
    '#totalGMV', '#hourGMV', '#currentHour', '#totalDelta', '#hourDelta', '#hourProgress',
    '#leaderName', '#leaderShare', '#leaderIcon', '#leaderProgress',
    '#targetAmount', '#targetValue', '#targetProgress', '#targetGap',
    '#ordersKpi', '#ticketKpi', '#activeKpi', '#activeLabel', '#top3Kpi', '#paceKpi', '#paceLabel',
    '#rankingPage', '#ranking', '#tickerTrack', '#insightText', '#chartTitle', '#chartLegend',
    '#axis', '#hourlyChart', '#peakLabel', '#sparkline', '#lastUpdate', '#toast',
    '#analyticSearch', '#analyticCompany', '#analyticChannel', '#analyticOrders',
    '#analyticGmv', '#analyticComplete', '#analyticsRows', '#updateStatus', '#statusLabel',
    '#channelFilter', '#refreshBtn', '#fileInput', '#liveClock'
  ]) {
    elements.set(id, makeEl());
  }

  let currentPayload = {
    updatedAt: null,
    dataDate: '2026-11-13',
    target: 210552,
    series: [],
    currentChannels: {},
    previousChannels: {},
    snapshotHistory: [],
    snapshots: 0,
    analytics: [],
    metrics: { totalGmv: 0, totalOrders: 0, ticket: 0 },
    reconciliation: { status: 'ok', pending: 0, message: '' }
  };

  const sandbox = {
    window: {},
    Intl,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Error,
    document: {
      querySelector: sel => elements.get(sel) || makeEl(),
      querySelectorAll: () => []
    },
    fetch: async () => ({
      ok: true,
      json: async () => currentPayload
    }),
    setInterval: () => 0,
    setTimeout: () => 0
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(targetsCode, sandbox);
  vm.runInContext(appCode, sandbox);

  await sandbox.loadBigQuery(false);
  assert.match(elements.get('#targetAmount').textContent, /210\.552/);
  assert.equal(elements.get('#targetValue').textContent, '0.0%');
  assert.equal(elements.get('#targetGap').textContent, 'Aguardando primeira carga do dia');

  currentPayload = {
    ...currentPayload,
    updatedAt: '2026-11-13T14:30:00.000Z',
    dataDate: '2026-11-13',
    target: 210552,
    series: [{ channel: 'Meli', hours: [{ hour: '11:00', value: 50000 }, { hour: '11:30', value: 55276 }] }],
    currentChannels: { Meli: 105276 },
    snapshotHistory: [
      { at: '2026-11-13T14:00:00.000Z', slot: '11:00', gmv: 50000, orders: 50, isBaseline: true, deltaGmv: null },
      { at: '2026-11-13T14:30:00.000Z', slot: '11:30', gmv: 105276, orders: 100, isBaseline: false, deltaGmv: 55276 }
    ],
    snapshots: 1,
    metrics: { totalGmv: 105276, totalOrders: 100, ticket: 1052.76 }
  };
  await sandbox.loadBigQuery(false);
  assert.match(elements.get('#targetAmount').textContent, /210\.552/);
  assert.equal(elements.get('#targetValue').textContent, '50.0%');
  assert.equal(elements.get('#targetProgress').style.width, '50%');
  assert.equal(elements.get('#targetGap').textContent, 'Faltam R$ 105.276 para a meta');

  currentPayload = {
    ...currentPayload,
    series: [{ channel: 'Meli', hours: [{ hour: '11:00', value: 50000 }, { hour: '18:00', value: 200000 }] }],
    currentChannels: { Meli: 250000 },
    metrics: { totalGmv: 250000, totalOrders: 200, ticket: 1250 }
  };
  await sandbox.loadBigQuery(false);
  assert.equal(elements.get('#targetValue').textContent, '118.7%');
  assert.equal(elements.get('#targetProgress').style.width, '100%');
  assert.equal(elements.get('#targetGap').textContent, 'Meta superada em R$ 39.448');

  currentPayload = {
    ...currentPayload,
    dataDate: '2026-12-01',
    target: null
  };
  await sandbox.loadBigQuery(false);
  assert.equal(elements.get('#targetAmount').textContent, 'Sem meta');
  assert.equal(elements.get('#targetValue').textContent, '—');
  assert.equal(elements.get('#targetProgress').style.width, '0%');
  assert.equal(elements.get('#targetGap').textContent, 'Sem meta cadastrada para 01/12/2026');
});

test('TC-008: servidor HTTP retorna dataDate e target coerente em /api/data', async () => {
  const port = 18787;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DISABLE_AUTO_UPDATE: '1',
      READ_ONLY_PREVIEW: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout ao iniciar server.js')), 5000);
      child.stdout.on('data', chunk => {
        if (String(chunk).includes(`:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', code => {
        clearTimeout(timer);
        reject(new Error(`server.js encerrou inesperadamente (${code})`));
      });
    });

    const apiRes = await fetch(`http://127.0.0.1:${port}/api/data`);
    assert.equal(apiRes.status, 200);
    const payload = await apiRes.json();
    assert.match(payload.dataDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(payload.target, dailyTargets.getDailyTargetValue(payload.dataDate));

    const scriptRes = await fetch(`http://127.0.0.1:${port}/daily-targets.js`);
    assert.equal(scriptRes.status, 200);
  } finally {
    child.kill();
  }
});
