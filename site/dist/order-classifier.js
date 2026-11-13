(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ORDER_CLASSIFIER = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TZ = 'America/Sao_Paulo';

  const COMPANY_CONFIGS = Object.freeze([
    Object.freeze({
      empresa: 'Oficial',
      envKey: 'TINY_OFICIAL_TOKEN',
      requiredMarkers: Object.freeze([])
    }),
    Object.freeze({
      empresa: 'Prioriza',
      envKey: 'TINY_PRIORIZA_TOKEN',
      requiredMarkers: Object.freeze([])
    }),
    Object.freeze({
      empresa: 'OFICIALSP',
      envKey: 'TINY_OFICIALSP_TOKEN',
      requiredMarkers: Object.freeze(['Magalu Fulfillment', 'Shopee Fulfillment'])
    }),
    Object.freeze({
      empresa: 'OFICIALSP2',
      envKey: 'TINY_OFICIALSP2_TOKEN',
      requiredMarkers: Object.freeze(['Fulfillment'])
    })
  ]);

  const KNOWN_COMPANIES = Object.freeze(COMPANY_CONFIGS.map(c => c.empresa));

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }

  function getCompanyConfig(empresa) {
    const key = normalizeText(empresa);
    return COMPANY_CONFIGS.find(c => normalizeText(c.empresa) === key) || null;
  }

  function buildAccounts(env = {}) {
    return COMPANY_CONFIGS.map(cfg => ({
      empresa: cfg.empresa,
      envKey: cfg.envKey,
      token: env && env[cfg.envKey] ? String(env[cfg.envKey]).trim() : '',
      requiredMarkers: [...cfg.requiredMarkers]
    }));
  }

  /**
   * Format a Date/timestamp as 'dd/mm/yyyy hh:mm:ss' in America/Sao_Paulo for Tiny dataAtualizacao.
   */
  function formatTinyDateTimeBrt(value = new Date(), timeZone = TZ) {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    }).formatToParts(date);
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    const hour = map.hour === '24' ? '00' : map.hour;
    return `${map.day}/${map.month}/${map.year} ${hour}:${map.minute}:${map.second}`;
  }

  /**
   * Compute the reference Date for Tiny dataAtualizacao using the account watermark (with safety overlap)
   * and a minimum rolling lookback window (default 180s = 3 minutes).
   */
  function computeIncrementalSinceDate({
    watermarkIso,
    nowMs = Date.now(),
    windowSec = 180,
    overlapSec = 30
  } = {}) {
    const windowFloorMs = nowMs - Math.max(1, Number(windowSec || 180)) * 1000;
    const overlapMs = Math.max(0, Number(overlapSec ?? 30)) * 1000;
    if (watermarkIso) {
      const parsed = Date.parse(watermarkIso);
      if (Number.isFinite(parsed)) {
        return new Date(Math.min(parsed - overlapMs, windowFloorMs));
      }
    }
    return new Date(windowFloorMs);
  }

  /**
   * Normalize a DD/MM/YYYY or YYYY-MM-DD date string to YYYY-MM-DD, or null when absent/unrecognized.
   */
  function normalizeOrderDateIso(rawDate) {
    const text = String(rawDate || '').trim();
    if (!text) return null;
    const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    return null;
  }

  /**
   * Check whether an order belongs to the target ISO date (YYYY-MM-DD).
   * Orders without an explicit data_pedido field default to true so synthetic fixtures remain compatible.
   */
  function isOrderFromDate(order, targetIsoDate) {
    const targetIso = normalizeOrderDateIso(targetIsoDate);
    const orderIso = normalizeOrderDateIso(order?.data_pedido || order?.dataPedido);
    if (!orderIso || !targetIso) return true;
    return orderIso === targetIso;
  }

  function num(value) {
    const parsed = Number(String(value ?? 0).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function cancelled(order) {
    return /cancelad|exclu/i.test(String(order?.situacao || ''));
  }

  function countableSale(order) {
    return !cancelled(order) && !/^em aberto$/i.test(String(order?.situacao || '').trim());
  }

  function ecommerceName(order) {
    if (!order) return '';
    if (typeof order.ecommerce === 'string') return order.ecommerce.trim();
    return String(
      order.ecommerce?.nomeEcommerce ||
      order.ecommerce?.canalVenda ||
      order.nome_ecommerce ||
      order.nomeEcommerce ||
      ''
    ).trim();
  }

  function sellerName(order) {
    if (!order) return '';
    return String(
      order.nome_vendedor ||
      order.nomeVendedor ||
      order.vendedor?.nome ||
      order.vendedor?.nomeVendedor ||
      ''
    ).trim();
  }

  function extractMarkers(order) {
    if (!Array.isArray(order?.marcadores)) return [];
    return order.marcadores
      .map(x => String(x?.marcador?.descricao ?? x?.descricao ?? '').trim())
      .filter(Boolean);
  }

  function hasMarker(order, targetMarker) {
    const target = normalizeText(targetMarker);
    if (!target) return false;
    return extractMarkers(order).some(marker => normalizeText(marker) === target);
  }

  /**
   * Evaluate company-specific Fulfillment rules and inclusion eligibility.
   * - OFICIALSP: only orders with 'Magalu Fulfillment' (-> MagaLu) or 'Shopee Fulfillment' (-> Shopee)
   * - OFICIALSP2: only orders with 'Fulfillment' (-> Meli)
   * - Oficial: orders with nomeEcommerce === 'Amazon FBA Classic' are flagged as Fulfillment (-> Amazon); all other orders are included as non-Fulfillment
   * - Prioriza / others: all orders included as non-Fulfillment
   */
  function classifyFulfillment(order, empresa) {
    const companyKey = normalizeText(empresa);

    if (companyKey === 'OFICIALSP') {
      if (hasMarker(order, 'Magalu Fulfillment')) {
        return {
          included: true,
          fulfillment: true,
          fulfillmentOrigem: 'Magalu Fulfillment',
          forcedChannel: 'MagaLu'
        };
      }
      if (hasMarker(order, 'Shopee Fulfillment')) {
        return {
          included: true,
          fulfillment: true,
          fulfillmentOrigem: 'Shopee Fulfillment',
          forcedChannel: 'Shopee'
        };
      }
      return {
        included: false,
        fulfillment: false,
        fulfillmentOrigem: null,
        forcedChannel: null
      };
    }

    if (companyKey === 'OFICIALSP2') {
      if (hasMarker(order, 'Fulfillment')) {
        return {
          included: true,
          fulfillment: true,
          fulfillmentOrigem: 'Fulfillment',
          forcedChannel: 'Meli'
        };
      }
      return {
        included: false,
        fulfillment: false,
        fulfillmentOrigem: null,
        forcedChannel: null
      };
    }

    if (companyKey === 'OFICIAL') {
      if (normalizeText(ecommerceName(order)) === 'AMAZON FBA CLASSIC') {
        return {
          included: true,
          fulfillment: true,
          fulfillmentOrigem: 'Amazon FBA Classic',
          forcedChannel: 'Amazon'
        };
      }
    }

    return {
      included: true,
      fulfillment: false,
      fulfillmentOrigem: null,
      forcedChannel: null
    };
  }

  function shouldIncludeOrder(order, empresa) {
    return classifyFulfillment(order, empresa).included;
  }

  function channel(order, empresa) {
    const ff = classifyFulfillment(order, empresa);
    if (ff.forcedChannel) return ff.forcedChannel;

    const markers = extractMarkers(order).join(' ');
    const seller = normalizeText(sellerName(order));
    if (/^(GABRIEL BARBOSA|CAMILA WALESKO|ANDREIA OTTO|ISABEL LARA)$/.test(seller)) {
      return 'Vendas Diretas';
    }
    const raw = [
      ecommerceName(order),
      order?.intermediador?.nome,
      sellerName(order),
      order?.forma_pagamento,
      order?.obs,
      order?.observacoes,
      order?.obs_interna,
      markers,
      order?.forma_envio
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();

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
    return (
      num(
        order?.valor ||
        order?.total_pedido ||
        order?.totalVenda ||
        order?.total_venda ||
        order?.totalProdutos ||
        order?.total_produtos
      ) ||
      num(order?.totalProdutos || order?.total_produtos) +
        num(order?.frete || order?.valor_frete) -
        num(order?.desconto || order?.valor_desconto)
    );
  }

  function analyticRow(order, empresa, detailed) {
    const ff = classifyFulfillment(order, empresa);
    return {
      empresa,
      pedido: String(order?.numero || order?.id || '—'),
      canal: channel(order, empresa),
      ecommerce: ecommerceName(order) || 'Sem e-commerce',
      modalidade: ff.fulfillment ? 'Fulfillment' : 'Padrão',
      fulfillment: ff.fulfillment,
      fulfillmentOrigem: ff.fulfillmentOrigem,
      situacao: String(order?.situacao || '—'),
      valor: orderValue(order),
      detalhe: detailed ? 'Completo' : 'Pendente',
      contabilizado: countableSale(order)
    };
  }

  return {
    TZ,
    COMPANY_CONFIGS,
    KNOWN_COMPANIES,
    normalizeText,
    getCompanyConfig,
    buildAccounts,
    formatTinyDateTimeBrt,
    computeIncrementalSinceDate,
    normalizeOrderDateIso,
    isOrderFromDate,
    num,
    cancelled,
    countableSale,
    ecommerceName,
    sellerName,
    extractMarkers,
    hasMarker,
    classifyFulfillment,
    shouldIncludeOrder,
    channel,
    orderValue,
    analyticRow
  };
});
