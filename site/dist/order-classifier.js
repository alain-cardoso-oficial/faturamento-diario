(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ORDER_CLASSIFIER = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    COMPANY_CONFIGS,
    KNOWN_COMPANIES,
    normalizeText,
    getCompanyConfig,
    buildAccounts,
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

