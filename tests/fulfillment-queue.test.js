const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const classifier = require(path.join(ROOT, 'site', 'dist', 'order-classifier.js'));

test('TC-201: buildAccounts e classificação Fulfillment para OFICIALSP, OFICIALSP2, Oficial e Prioriza', () => {
  const accounts = classifier.buildAccounts({
    TINY_OFICIAL_TOKEN: 'tok_of',
    TINY_PRIORIZA_TOKEN: 'tok_pr',
    TINY_OFICIALSP_TOKEN: 'tok_sp1',
    TINY_OFICIALSP2_TOKEN: 'tok_sp2'
  });

  assert.equal(accounts.length, 4);
  assert.deepEqual(accounts.map(a => a.empresa), ['Oficial', 'Prioriza', 'OFICIALSP', 'OFICIALSP2']);
  assert.deepEqual(accounts[2].requiredMarkers, ['Magalu Fulfillment', 'Shopee Fulfillment']);
  assert.deepEqual(accounts[3].requiredMarkers, ['Fulfillment']);

  // BR-001: OFICIALSP + Magalu Fulfillment -> MagaLu + Fulfillment
  const spMagalu = {
    id: '101',
    numero: '5001',
    situacao: 'Aprovado',
    valor: '250.00',
    marcadores: [{ marcador: { descricao: 'Magalu Fulfillment' } }]
  };
  assert.equal(classifier.shouldIncludeOrder(spMagalu, 'OFICIALSP'), true);
  assert.equal(classifier.channel(spMagalu, 'OFICIALSP'), 'MagaLu');
  const rowMagalu = classifier.analyticRow(spMagalu, 'OFICIALSP', true);
  assert.equal(rowMagalu.fulfillment, true);
  assert.equal(rowMagalu.fulfillmentOrigem, 'Magalu Fulfillment');
  assert.equal(rowMagalu.modalidade, 'Fulfillment');
  assert.equal(rowMagalu.contabilizado, true);

  // BR-002: OFICIALSP + Shopee Fulfillment -> Shopee + Fulfillment
  const spShopee = {
    id: '102',
    numero: '5002',
    situacao: 'Faturado',
    valor: '150.00',
    marcadores: [{ marcador: { descricao: '  shopee fulfillment ' } }]
  };
  assert.equal(classifier.shouldIncludeOrder(spShopee, 'OFICIALSP'), true);
  assert.equal(classifier.channel(spShopee, 'OFICIALSP'), 'Shopee');
  const rowShopee = classifier.analyticRow(spShopee, 'OFICIALSP', true);
  assert.equal(rowShopee.fulfillment, true);
  assert.equal(rowShopee.fulfillmentOrigem, 'Shopee Fulfillment');

  // BR-004: OFICIALSP sem os marcadores exigidos -> descartado
  const spOther = {
    id: '103',
    numero: '5003',
    situacao: 'Aprovado',
    valor: '999.00',
    ecommerce: { nomeEcommerce: 'Shopee' },
    marcadores: [{ marcador: { descricao: 'Shopee coleta' } }]
  };
  assert.equal(classifier.shouldIncludeOrder(spOther, 'OFICIALSP'), false);

  // BR-003: OFICIALSP2 + Fulfillment -> Meli (mesmo sem menção a Meli em outros campos)
  const sp2Meli = {
    id: '201',
    numero: '6001',
    situacao: 'Faturado',
    valor: '400.00',
    obs: 'Observação interna qualquer',
    marcadores: [{ marcador: { descricao: 'Fulfillment' } }]
  };
  assert.equal(classifier.shouldIncludeOrder(sp2Meli, 'OFICIALSP2'), true);
  assert.equal(classifier.channel(sp2Meli, 'OFICIALSP2'), 'Meli');
  const rowMeli = classifier.analyticRow(sp2Meli, 'OFICIALSP2', true);
  assert.equal(rowMeli.fulfillment, true);
  assert.equal(rowMeli.fulfillmentOrigem, 'Fulfillment');

  // BR-004: OFICIALSP2 sem marcador Fulfillment -> descartado
  const sp2Other = {
    id: '202',
    numero: '6002',
    situacao: 'Faturado',
    valor: '300.00',
    ecommerce: { nomeEcommerce: 'Mercado Livre' },
    marcadores: [{ marcador: { descricao: 'MercadoEnvios Coleta' } }]
  };
  assert.equal(classifier.shouldIncludeOrder(sp2Other, 'OFICIALSP2'), false);

  // BR-005 & BR-006: Oficial com Amazon FBA Classic vs Amazon comum
  const ofAmazonFba = {
    id: '301',
    numero: '7001',
    situacao: 'Enviado',
    valor: '520.00',
    ecommerce: { nomeEcommerce: 'Amazon FBA Classic' }
  };
  assert.equal(classifier.shouldIncludeOrder(ofAmazonFba, 'Oficial'), true);
  assert.equal(classifier.channel(ofAmazonFba, 'Oficial'), 'Amazon');
  const rowAmazonFba = classifier.analyticRow(ofAmazonFba, 'Oficial', true);
  assert.equal(rowAmazonFba.fulfillment, true);
  assert.equal(rowAmazonFba.fulfillmentOrigem, 'Amazon FBA Classic');
  assert.equal(rowAmazonFba.modalidade, 'Fulfillment');

  const ofAmazonStd = {
    id: '302',
    numero: '7002',
    situacao: 'Enviado',
    valor: '180.00',
    ecommerce: { nomeEcommerce: 'Amazon' }
  };
  const rowAmazonStd = classifier.analyticRow(ofAmazonStd, 'Oficial', true);
  assert.equal(rowAmazonStd.canal, 'Amazon');
  assert.equal(rowAmazonStd.fulfillment, false);
  assert.equal(rowAmazonStd.modalidade, 'Padrão');
});

test('TC-202: fronteira de situação (Em aberto vs Cancelado) em pedidos Fulfillment', () => {
  const openOrder = {
    id: '401',
    numero: '8001',
    situacao: 'Em aberto',
    valor: '310.00',
    marcadores: [{ marcador: { descricao: 'Magalu Fulfillment' } }]
  };
  const rowOpen = classifier.analyticRow(openOrder, 'OFICIALSP', true);
  assert.equal(rowOpen.fulfillment, true);
  assert.equal(rowOpen.contabilizado, false);

  const cancelledOrder = {
    ...openOrder,
    situacao: 'Cancelado'
  };
  assert.equal(classifier.cancelled(cancelledOrder), true);
  assert.equal(classifier.countableSale(cancelledOrder), false);
});

test('TC-203: frontend renderiza coluna Modalidade, filtros de empresa/Fulfillment, retrocompatibilidade e painel de fila', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'index.html'), 'utf8');
  assert.match(html, /<script src="order-classifier\.js"><\/script>/);
  assert.match(html, /<th>Modalidade<\/th>/);
  assert.match(html, /id="analyticFulfillment"/);
  assert.match(html, /id="queuePanel"/);
  assert.match(html, /OFICIALSP2/);

  const targetsCode = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'daily-targets.js'), 'utf8');
  const classifierCode = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'order-classifier.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'app.js'), 'utf8');

  const elements = new Map();
  const makeEl = () => ({
    textContent: '',
    innerHTML: '',
    value: 'all',
    hidden: true,
    className: '',
    style: {},
    dataset: {},
    classList: {
      classes: new Set(),
      toggle(cls, force) {
        const next = force === undefined ? !this.classes.has(cls) : Boolean(force);
        if (next) this.classes.add(cls); else this.classes.delete(cls);
      },
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); }
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
    '#analyticSearch', '#analyticCompany', '#analyticChannel', '#analyticFulfillment',
    '#analyticOrders', '#analyticGmv', '#analyticComplete', '#analyticsRows',
    '#updateStatus', '#statusLabel', '#channelFilter', '#refreshBtn', '#fileInput', '#liveClock',
    '#queueToggleBtn', '#queueBadge', '#queuePanel', '#queueSummaryText', '#queueRefreshBtn',
    '#queuePauseResumeBtn', '#queueAccounts'
  ]) {
    elements.set(id, makeEl());
  }
  elements.get('#analyticSearch').value = '';

  let currentPayload = {
    updatedAt: '2026-11-13T15:00:00.000Z',
    dataDate: '2026-11-13',
    target: 210552,
    series: [{ channel: 'MagaLu', hours: [{ hour: '12:00', value: 1000 }] }],
    currentChannels: { MagaLu: 1000 },
    previousChannels: {},
    snapshotHistory: [{ at: '2026-11-13T15:00:00.000Z', slot: '12:00', gmv: 1000, orders: 2, isBaseline: true, deltaGmv: null }],
    snapshots: 1,
    analytics: [
      {
        empresa: 'OFICIALSP',
        pedido: '9001',
        canal: 'MagaLu',
        ecommerce: 'Magalu Marketplace',
        fulfillment: true,
        fulfillmentOrigem: 'Magalu Fulfillment',
        situacao: 'Aprovado',
        valor: 600,
        detalhe: 'Completo',
        contabilizado: true
      },
      {
        empresa: 'Oficial',
        pedido: '9002',
        canal: 'Amazon',
        ecommerce: 'Amazon FBA Classic',
        fulfillment: true,
        fulfillmentOrigem: 'Amazon FBA Classic',
        situacao: 'Faturado',
        valor: 400,
        detalhe: 'Completo',
        contabilizado: true
      },
      {
        // Snapshot legado sem campo fulfillment
        empresa: 'Prioriza',
        pedido: '9003',
        canal: 'Shopee',
        ecommerce: 'Shopee',
        situacao: 'Aprovado',
        valor: 200,
        detalhe: 'Completo',
        contabilizado: true
      }
    ],
    metrics: { totalGmv: 1200, totalOrders: 3, ticket: 400 },
    reconciliation: { status: 'retrying', pending: 2, message: 'Retry #1' },
    queue: {
      status: 'waiting_retry',
      paused: false,
      attempt: 1,
      maxAttempts: 6,
      backoffMs: 5000,
      pendingTotal: 2,
      lastError: 'Excedido o número de acessos',
      accounts: [
        { empresa: 'Oficial', status: 'completed', foundOrders: 5, processedOrders: 5, pendingOrders: 0, requiredMarkers: [] },
        { empresa: 'OFICIALSP', status: 'retrying', foundOrders: 2, processedOrders: 0, pendingOrders: 2, requiredMarkers: ['Magalu Fulfillment', 'Shopee Fulfillment'], lastError: 'Excedido o número de acessos' }
      ]
    }
  };

  let lastQueueAction = null;
  const sandbox = {
    window: {},
    Intl,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    confirm: () => true,
    document: {
      querySelector: sel => elements.get(sel) || makeEl(),
      querySelectorAll: () => []
    },
    fetch: async (url, opts) => {
      if (url === '/api/queue/pause' || url === '/api/queue/resume') {
        lastQueueAction = { url, opts };
        const paused = url === '/api/queue/pause';
        currentPayload.queue.paused = paused;
        currentPayload.queue.status = paused ? 'paused' : 'idle';
        currentPayload.reconciliation.status = paused ? 'paused' : 'ok';
        return {
          ok: true,
          json: async () => ({ ok: true, queue: currentPayload.queue, reconciliation: currentPayload.reconciliation })
        };
      }
      return {
        ok: true,
        json: async () => currentPayload
      };
    },
    setInterval: () => 0,
    setTimeout: () => 0
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(targetsCode, sandbox);
  vm.runInContext(classifierCode, sandbox);
  vm.runInContext(appCode, sandbox);

  await sandbox.loadBigQuery(false);

  // Verifica renderização da coluna Modalidade e badge da fila
  assert.match(elements.get('#analyticsRows').innerHTML, /Fulfillment • Magalu Fulfillment/);
  assert.match(elements.get('#analyticsRows').innerHTML, /Fulfillment • Amazon FBA Classic/);
  assert.match(elements.get('#analyticsRows').innerHTML, /Padrão/);
  assert.equal(elements.get('#queueBadge').textContent, 'RETRY #1');

  // Filtra somente Fulfillment
  elements.get('#analyticFulfillment').value = 'fulfillment';
  sandbox.renderAnalytics();
  assert.match(elements.get('#analyticsRows').innerHTML, /9001/);
  assert.match(elements.get('#analyticsRows').innerHTML, /9002/);
  assert.doesNotMatch(elements.get('#analyticsRows').innerHTML, /9003/);

  // Filtra somente Padrão (retrocompatibilidade de linha sem campo fulfillment)
  elements.get('#analyticFulfillment').value = 'padrao';
  sandbox.renderAnalytics();
  assert.match(elements.get('#analyticsRows').innerHTML, /9003/);
  assert.doesNotMatch(elements.get('#analyticsRows').innerHTML, /9001/);

  // Pausa e retoma a fila via UI
  await sandbox.toggleQueuePause();
  assert.equal(lastQueueAction.url, '/api/queue/pause');
  assert.equal(elements.get('#queueBadge').textContent, 'PAUSADA');

  await sandbox.toggleQueuePause();
  assert.equal(lastQueueAction.url, '/api/queue/resume');
});

test('TC-204: integração HTTP de server.js com filtro de marcadores, retry exponencial e pausa/retomada de fila', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-req002-'));
  const snapshotsFile = path.join(tmpDir, 'snapshots.json');
  const cacheFile = path.join(tmpDir, 'cache.json');

  let sp2FailCount = 0;
  const searchCalls = [];

  const mockTiny = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('token');
      const marcador = params.get('marcador') || '';

      if (req.url === '/pesquisa') {
        searchCalls.push({ token, marcador });
        if (token === 'tok_sp2' && sp2FailCount < 1) {
          sp2FailCount += 1;
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ retorno: { status: 'Erro', erros: [{ erro: 'Excedido o número de acessos' }] } }));
          return;
        }
        const byToken = {
          tok_of: [{ pedido: { id: '1', numero: '1001', situacao: 'Aprovado', valor: '400.00' } }],
          tok_pr: [],
          'tok_sp1:Magalu Fulfillment': [
            { pedido: { id: '2', numero: '2001', situacao: 'Aprovado', valor: '300.00' } },
            { pedido: { id: '3', numero: '2002', situacao: 'Aprovado', valor: '999.00' } } // será descartado no detalhe por não ter marcador
          ],
          'tok_sp1:Shopee Fulfillment': [
            { pedido: { id: '4', numero: '2003', situacao: 'Faturado', valor: '150.00' } }
          ],
          'tok_sp2:Fulfillment': [
            { pedido: { id: '5', numero: '3001', situacao: 'Faturado', valor: '250.00' } }
          ]
        };
        const key = marcador ? `${token}:${marcador}` : token;
        const pedidos = byToken[key] || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          retorno: pedidos.length
            ? { status: 'OK', numero_paginas: 1, pedidos }
            : { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
        }));
        return;
      }

      if (req.url === '/obter') {
        const id = params.get('id');
        const details = {
          '1': { id: '1', numero: '1001', situacao: 'Aprovado', total_pedido: '400.00', ecommerce: { nomeEcommerce: 'Amazon FBA Classic' }, marcadores: [] },
          '2': { id: '2', numero: '2001', situacao: 'Aprovado', total_pedido: '300.00', ecommerce: { nomeEcommerce: 'Magalu' }, marcadores: [{ marcador: { descricao: 'Magalu Fulfillment' } }] },
          '3': { id: '3', numero: '2002', situacao: 'Aprovado', total_pedido: '999.00', ecommerce: { nomeEcommerce: 'Magalu' }, marcadores: [{ marcador: { descricao: 'Outro Marcador' } }] },
          '4': { id: '4', numero: '2003', situacao: 'Faturado', total_pedido: '150.00', ecommerce: { nomeEcommerce: 'Shopee' }, marcadores: [{ marcador: { descricao: 'Shopee Fulfillment' } }] },
          '5': { id: '5', numero: '3001', situacao: 'Faturado', total_pedido: '250.00', ecommerce: { nomeEcommerce: 'Mercado Livre' }, marcadores: [{ marcador: { descricao: 'Fulfillment' } }] }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ retorno: { status: 'OK', pedido: details[id] } }));
      }
    });
  });

  await new Promise(resolve => mockTiny.listen(0, '127.0.0.1', resolve));
  const tinyPort = mockTiny.address().port;
  const appPort = 18788;

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      DISABLE_AUTO_UPDATE: '1',
      SNAPSHOTS_FILE: snapshotsFile,
      DETAIL_CACHE_FILE: cacheFile,
      TINY_PESQUISA_ENDPOINT: `http://127.0.0.1:${tinyPort}/pesquisa`,
      TINY_OBTER_ENDPOINT: `http://127.0.0.1:${tinyPort}/obter`,
      TINY_OFICIAL_TOKEN: 'tok_of',
      TINY_PRIORIZA_TOKEN: 'tok_pr',
      TINY_OFICIALSP_TOKEN: 'tok_sp1',
      TINY_OFICIALSP2_TOKEN: 'tok_sp2',
      TINY_DETAIL_DELAY_MS: '5',
      TINY_RETRY_BASE_MS: '60',
      TINY_RETRY_MAX_MS: '500',
      TINY_RETRY_MAX_ATTEMPTS: '4'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout ao iniciar server.js')), 5000);
      child.stdout.on('data', chunk => {
        if (String(chunk).includes(`:${appPort}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', code => {
        clearTimeout(timer);
        reject(new Error(`server.js encerrou (${code})`));
      });
    });

    // 1ª chamada falha em OFICIALSP2 (HTTP 429) e agenda retry exponencial #1
    const firstUpdate = await fetch(`http://127.0.0.1:${appPort}/api/update-data`);
    assert.equal(firstUpdate.status, 500);
    const firstBody = await firstUpdate.json();
    assert.equal(firstBody.queue.status, 'waiting_retry');
    assert.equal(firstBody.queue.attempt, 1);
    assert.equal(firstBody.queue.backoffMs, 60);

    // Aguarda retry automático concluir com sucesso
    await new Promise(resolve => setTimeout(resolve, 220));

    const dataRes = await fetch(`http://127.0.0.1:${appPort}/api/data`);
    assert.equal(dataRes.status, 200);
    const dataBody = await dataRes.json();
    assert.equal(dataBody.queue.status, 'idle');
    assert.equal(dataBody.currentChannels.Amazon, 400);
    assert.equal(dataBody.currentChannels.MagaLu, 300); // pedido 2002 (999) sem marcador foi descartado!
    assert.equal(dataBody.currentChannels.Shopee, 150);
    assert.equal(dataBody.currentChannels.Meli, 250);
    assert.equal(dataBody.metrics.totalGmv, 1100);
    assert.equal(dataBody.analytics.length, 4);
    assert.ok(dataBody.analytics.every(row => row.fulfillment === true));

    // Testa pausa e bloqueio de atualização manual enquanto pausada
    const pauseRes = await fetch(`http://127.0.0.1:${appPort}/api/queue/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Teste de manutenção' })
    });
    assert.equal(pauseRes.status, 200);
    const pauseBody = await pauseRes.json();
    assert.equal(pauseBody.queue.paused, true);
    assert.equal(pauseBody.queue.status, 'paused');

    const blockedUpdate = await fetch(`http://127.0.0.1:${appPort}/api/update-data`);
    assert.equal(blockedUpdate.status, 409);

    const resumeRes = await fetch(`http://127.0.0.1:${appPort}/api/queue/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerNow: false })
    });
    assert.equal(resumeRes.status, 200);
    const resumeBody = await resumeRes.json();
    assert.equal(resumeBody.queue.paused, false);
  } finally {
    child.kill();
    mockTiny.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

