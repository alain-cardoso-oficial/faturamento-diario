const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const classifier = require(path.join(ROOT, 'site', 'dist', 'order-classifier.js'));
const { brDateIso } = require(path.join(ROOT, 'site', 'dist', 'daily-targets.js'));

function brTodayDdMmYyyy() {
  const [yyyy, mm, dd] = brDateIso().split('-');
  return `${dd}/${mm}/${yyyy}`;
}

test('TC-301: formatação de dataAtualizacao em America/Sao_Paulo e cálculo de watermark com overlap', () => {
  // 2026-11-13T18:05:09.000Z === 13/11/2026 15:05:09 em America/Sao_Paulo (UTC-3)
  const sampleUtc = new Date('2026-11-13T18:05:09.000Z');
  const formatted = classifier.formatTinyDateTimeBrt(sampleUtc);
  assert.equal(formatted, '13/11/2026 15:05:09');
  assert.match(formatted, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);

  const nowMs = Date.parse('2026-11-13T18:10:00.000Z');

  // Sem watermark prévio: usa janela padrão (180s) + overlap (30s) = 210s atrás
  const fallbackSince = classifier.computeIncrementalSinceDate({
    watermarkIso: null,
    nowMs,
    windowSec: 180,
    overlapSec: 30
  });
  assert.equal(classifier.formatTinyDateTimeBrt(fallbackSince), '13/11/2026 15:06:30');

  // Com watermark de 10 minutos atrás (ex.: fila ficou pausada ou em retry): recua até watermark - overlap (30s)
  const pausedWatermark = '2026-11-13T18:00:00.000Z';
  const recoveredSince = classifier.computeIncrementalSinceDate({
    watermarkIso: pausedWatermark,
    nowMs,
    windowSec: 180,
    overlapSec: 30
  });
  assert.equal(classifier.formatTinyDateTimeBrt(recoveredSince), '13/11/2026 14:59:30');
});

test('TC-302: filtro estrito de pedidos do dia atual (isOrderFromDate / normalizeOrderDateIso)', () => {
  assert.equal(classifier.normalizeOrderDateIso('13/11/2026'), '2026-11-13');
  assert.equal(classifier.normalizeOrderDateIso('13/11/2026 14:22:10'), '2026-11-13');
  assert.equal(classifier.normalizeOrderDateIso('2026-11-13'), '2026-11-13');

  assert.equal(classifier.isOrderFromDate({ id: '1', data_pedido: '13/11/2026' }, '2026-11-13'), true);
  assert.equal(classifier.isOrderFromDate({ id: '2', data_pedido: '12/11/2026' }, '2026-11-13'), false);
  // Retrocompatibilidade com fixtures sintéticas sem data_pedido explícita
  assert.equal(classifier.isOrderFromDate({ id: '3' }, '2026-11-13'), true);
});

test('TC-303/304/305: integração HTTP de bootstrap, sync incremental via dataAtualizacao (3 min), descarte de dias anteriores e reconciliação completa', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-req003-'));
  const snapshotsFile = path.join(tmpDir, 'snapshots.json');
  const cacheFile = path.join(tmpDir, 'cache.json');
  const dailyStateFile = path.join(tmpDir, 'daily-orders-state.json');

  const todayBr = brTodayDdMmYyyy();
  const searchLog = [];
  const detailLog = [];
  let phase = 'bootstrap';

  const mockTiny = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('token');
      const marcador = params.get('marcador') || '';
      const dataInicial = params.get('dataInicial');
      const dataFinal = params.get('dataFinal');
      const dataAtualizacao = params.get('dataAtualizacao');

      if (req.url === '/pesquisa') {
        searchLog.push({ phase, token, marcador, dataInicial, dataFinal, dataAtualizacao });

        if (phase === 'bootstrap') {
          const initialByKey = {
            tok_of: [
              { pedido: { id: '10', numero: '1010', data_pedido: todayBr, situacao: 'Aprovado', valor: '200.00' } },
              { pedido: { id: '11', numero: '1011', data_pedido: todayBr, situacao: 'Aprovado', valor: '300.00' } }
            ],
            tok_pr: [],
            'tok_sp1:Magalu Fulfillment': [
              { pedido: { id: '20', numero: '2020', data_pedido: todayBr, situacao: 'Faturado', valor: '150.00' } }
            ],
            'tok_sp1:Shopee Fulfillment': [],
            'tok_sp2:Fulfillment': []
          };
          const key = marcador ? `${token}:${marcador}` : token;
          const pedidos = initialByKey[key] || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: pedidos.length
              ? { status: 'OK', numero_paginas: 1, pedidos }
              : { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
          }));
          return;
        }

        if (phase === 'incremental_empty') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
          }));
          return;
        }

        if (phase === 'incremental_delta') {
          const deltaByKey = {
            tok_of: [
              // Pedido 10 teve valor alterado de 200 para 280
              { pedido: { id: '10', numero: '1010', data_pedido: todayBr, situacao: 'Faturado', valor: '280.00' } },
              // Pedido 11 foi cancelado nos últimos 3 minutos
              { pedido: { id: '11', numero: '1011', data_pedido: todayBr, situacao: 'Cancelado', valor: '300.00' } },
              // Pedido 12 é novo de hoje
              { pedido: { id: '12', numero: '1012', data_pedido: todayBr, situacao: 'Aprovado', valor: '500.00' } },
              // Pedido 99 é de um dia anterior alterado hoje -> deve ser ignorado sem chamar /obter!
              { pedido: { id: '99', numero: '0099', data_pedido: '01/10/2025', situacao: 'Enviado', valor: '9999.00' } }
            ]
          };
          const key = marcador ? `${token}:${marcador}` : token;
          const pedidos = deltaByKey[key] || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: pedidos.length
              ? { status: 'OK', numero_paginas: 1, pedidos }
              : { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
          }));
          return;
        }

        if (phase === 'full_reconcile') {
          const fullByKey = {
            tok_of: [
              { pedido: { id: '10', numero: '1010', data_pedido: todayBr, situacao: 'Faturado', valor: '280.00' } },
              { pedido: { id: '12', numero: '1012', data_pedido: todayBr, situacao: 'Aprovado', valor: '500.00' } }
            ],
            'tok_sp1:Magalu Fulfillment': [
              { pedido: { id: '20', numero: '2020', data_pedido: todayBr, situacao: 'Faturado', valor: '150.00' } }
            ]
          };
          const key = marcador ? `${token}:${marcador}` : token;
          const pedidos = fullByKey[key] || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: pedidos.length
              ? { status: 'OK', numero_paginas: 1, pedidos }
              : { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
          }));
          return;
        }
      }

      if (req.url === '/obter') {
        const id = params.get('id');
        detailLog.push({ phase, token, id });
        const details = {
          '10': {
            id: '10',
            numero: '1010',
            data_pedido: todayBr,
            situacao: phase === 'bootstrap' ? 'Aprovado' : 'Faturado',
            total_pedido: phase === 'bootstrap' ? '200.00' : '280.00',
            ecommerce: { nomeEcommerce: 'Amazon FBA Classic' },
            marcadores: []
          },
          '11': {
            id: '11',
            numero: '1011',
            data_pedido: todayBr,
            situacao: phase === 'bootstrap' ? 'Aprovado' : 'Cancelado',
            total_pedido: '300.00',
            ecommerce: { nomeEcommerce: 'Shopee' },
            marcadores: []
          },
          '12': {
            id: '12',
            numero: '1012',
            data_pedido: todayBr,
            situacao: 'Aprovado',
            total_pedido: '500.00',
            ecommerce: { nomeEcommerce: 'Mercado Livre' },
            marcadores: []
          },
          '20': {
            id: '20',
            numero: '2020',
            data_pedido: todayBr,
            situacao: 'Faturado',
            total_pedido: '150.00',
            ecommerce: { nomeEcommerce: 'Magalu' },
            marcadores: [{ marcador: { descricao: 'Magalu Fulfillment' } }]
          }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ retorno: { status: 'OK', pedido: details[id] } }));
      }
    });
  });

  await new Promise(resolve => mockTiny.listen(0, '127.0.0.1', resolve));
  const tinyPort = mockTiny.address().port;
  const appPort = 18789;

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      DISABLE_AUTO_UPDATE: '1',
      SNAPSHOTS_FILE: snapshotsFile,
      DETAIL_CACHE_FILE: cacheFile,
      DAILY_STATE_FILE: dailyStateFile,
      TINY_PESQUISA_ENDPOINT: `http://127.0.0.1:${tinyPort}/pesquisa`,
      TINY_OBTER_ENDPOINT: `http://127.0.0.1:${tinyPort}/obter`,
      TINY_OFICIAL_TOKEN: 'tok_of',
      TINY_PRIORIZA_TOKEN: 'tok_pr',
      TINY_OFICIALSP_TOKEN: 'tok_sp1',
      TINY_OFICIALSP2_TOKEN: 'tok_sp2',
      TINY_DETAIL_DELAY_MS: '5',
      TINY_FULL_RECONCILE_INTERVAL_MS: '3600000'
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

    // 1. Primeira carga do dia -> Bootstrap completo (usa dataInicial/dataFinal)
    const bootRes = await fetch(`http://127.0.0.1:${appPort}/api/update-data`);
    assert.equal(bootRes.status, 200);
    const bootBody = await bootRes.json();
    assert.equal(bootBody.metrics.totalGmv, 650); // 200 (Amazon) + 300 (Shopee) + 150 (MagaLu)
    assert.equal(bootBody.metrics.totalOrders, 3);
    assert.ok(searchLog.filter(x => x.phase === 'bootstrap').every(x => x.dataInicial && x.dataFinal && !x.dataAtualizacao));

    // 2. Segunda chamada -> Incremental sem alterações (usa dataAtualizacao e faz 0 chamadas a /obter)
    phase = 'incremental_empty';
    const detailCountBeforeEmpty = detailLog.length;
    const emptyIncRes = await fetch(`http://127.0.0.1:${appPort}/api/update-data`);
    assert.equal(emptyIncRes.status, 200);
    const emptyIncBody = await emptyIncRes.json();
    assert.equal(detailLog.length, detailCountBeforeEmpty, 'Zero chamadas a pedido.obter.php quando não há alterações');
    assert.equal(emptyIncBody.metrics.totalGmv, 650, 'Mantém estado consolidado do dia quando janela incremental vem vazia');
    const emptySearches = searchLog.filter(x => x.phase === 'incremental_empty');
    assert.ok(emptySearches.length >= 4);
    assert.ok(emptySearches.every(x => !x.dataInicial && !x.dataFinal && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(x.dataAtualizacao)));

    // 3. Terceira chamada -> Incremental com delta (alteração de valor, cancelamento, novo pedido e pedido de dia anterior)
    phase = 'incremental_delta';
    const deltaRes = await fetch(`http://127.0.0.1:${appPort}/api/update-data`);
    assert.equal(deltaRes.status, 200);
    const deltaBody = await deltaRes.json();
    // Pedido 99 (de 01/10/2025) não deve sequer ter chamado /obter
    assert.equal(detailLog.some(x => x.id === '99'), false);
    // Estado esperado após delta:
    // - Pedido 10 (Amazon): atualizado para 280
    // - Pedido 11 (Shopee): removido por Cancelado
    // - Pedido 12 (Meli): inserido com 500
    // - Pedido 20 (MagaLu Fulfillment em OFICIALSP): preservado com 150
    assert.equal(deltaBody.currentChannels.Amazon, 280);
    assert.equal(deltaBody.currentChannels.Shopee || 0, 0);
    assert.equal(deltaBody.currentChannels.Meli, 500);
    assert.equal(deltaBody.currentChannels.MagaLu, 150);
    assert.equal(deltaBody.metrics.totalGmv, 930);
    assert.equal(deltaBody.metrics.totalOrders, 3);
    // Verifica que o gráfico manteve o slot de 30 minutos atualizado in-place
    assert.equal(deltaBody.snapshotHistory.length, 1);

    // 4. Quarta chamada -> Reconciliação completa explícita (?mode=full)
    phase = 'full_reconcile';
    const fullRes = await fetch(`http://127.0.0.1:${appPort}/api/update-data?mode=full`);
    assert.equal(fullRes.status, 200);
    const fullBody = await fullRes.json();
    const fullSearches = searchLog.filter(x => x.phase === 'full_reconcile');
    assert.ok(fullSearches.length >= 4);
    assert.ok(fullSearches.every(x => x.dataInicial && x.dataFinal && !x.dataAtualizacao));
    assert.equal(fullBody.metrics.totalGmv, 930);
  } finally {
    child.kill();
    mockTiny.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

