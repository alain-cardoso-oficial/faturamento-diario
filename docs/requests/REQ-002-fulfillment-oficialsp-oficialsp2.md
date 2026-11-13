# REQ-002 — Integração de Empresas OFICIALSP e OFICIALSP2, Rastreamento Fulfillment e Fila com Retry Exponencial

- **ID:** REQ-002
- **Classificação:** Integração multiempresa, alteração de regra de negócio e resiliência operacional (*integration* / *business-rule change* / *reliability*)
- **Modo solicitado:** Implement (`Implement`)
- **Status atual:** `UNDER TESTING` (implementado localmente; execução de `npm test` bloqueada no ambiente local por ausência do binário `node`)
- **Data da revisão:** 2026-11-13
- **Branch Git:** `main` (alterações locais não commitadas)

---

## 1. Request Intake e Escopo (`request-intake`)

- **Objetivo de negócio:**
  1. Integrar as novas contas Tiny ERP `OFICIALSP` (`TINY_OFICIALSP_TOKEN`) e `OFICIALSP2` (`TINY_OFICIALSP2_TOKEN`), capturando exclusivamente os pedidos com marcadores de Fulfillment (`Magalu Fulfillment` → `MagaLu` e `Shopee Fulfillment` → `Shopee` em `OFICIALSP`; `Fulfillment` → `Meli` em `OFICIALSP2`) e descartando os demais para evitar duplicidade.
  2. Identificar na conta `Oficial` os pedidos do canal Amazon cujo `ecommerce.nomeEcommerce` seja `"Amazon FBA Classic"`, somando esses valores no total de cada e-commerce e exibindo a informação **Fulfillment** na **Tabela Analítica** para conferência operacional.
  3. Realizar **retry exponencial** automático em caso de falha nas consultas à API Tiny, permitindo **consultar a fila atual** e **pausar/retomar** o processamento quando necessário.
- **Escopo implementado:**
  - Suporte a `.env` e `.env.local` e inclusão de `.env` no [.gitignore](../../.gitignore).
  - Módulo compartilhado UMD [site/dist/order-classifier.js](../../site/dist/order-classifier.js) com configuração das 4 empresas, extração de marcadores, filtro de inclusão e classificação de canal e modalidade Fulfillment.
  - Coleta filtrada por `marcador` em `pedidos.pesquisa.php` + validação pós-detalhe em `pedido.obter.php` em [server.js](../../server.js) e [enrich-today.js](../../enrich-today.js).
  - Gerenciador de fila `syncQueue` em [server.js](../../server.js) com retry exponencial (`computeBackoffMs`), interrupção limpa em pausa e endpoints `GET /api/queue`, `POST /api/queue/pause` e `POST /api/queue/resume`.
  - Nova coluna `Modalidade` (`Fulfillment` + origem vs `Padrão`), filtro de modalidade (`#analyticFulfillment`), filtro dinâmico de empresas (`#analyticCompany`), busca textual e painel de inspeção/pausa da fila em [site/dist/index.html](../../site/dist/index.html), [site/dist/app.js](../../site/dist/app.js) e [site/dist/analytics-tab.css](../../site/dist/analytics-tab.css).
  - Sincronização de [rebuild-confirmed-snapshots.js](../../rebuild-confirmed-snapshots.js), [README.md](../../README.md), [.env.example](../../.env.example), [deploy/setup-vps.sh](../../deploy/setup-vps.sh) e suíte de testes [tests/fulfillment-queue.test.js](../../tests/fulfillment-queue.test.js).
- **Fora de escopo:**
  - Painel `raio-x/` (BigQuery D-1).
  - Alteração nas metas diárias de novembro/2026 (`REQ-001`) ou nas regras da conta `Prioriza`.
  - Operações de commit, push ou deploy em produção na VPS sem autorização específica.

---

## 2. Requisitos e Regras de Negócio (`requirements-engineering`)

### Requisitos Funcionais (`FR`)
- **FR-001:** Carregar `Oficial` (`TINY_OFICIAL_TOKEN`), `Prioriza` (`TINY_PRIORIZA_TOKEN`), `OFICIALSP` (`TINY_OFICIALSP_TOKEN`) e `OFICIALSP2` (`TINY_OFICIALSP2_TOKEN`) a partir de `.env.local` e `.env`.
- **FR-002:** Capturar de `OFICIALSP` somente pedidos com marcador `Magalu Fulfillment` ou `Shopee Fulfillment`, descartando os demais.
- **FR-003:** Capturar de `OFICIALSP2` somente pedidos com marcador `Fulfillment`, descartando os demais.
- **FR-004:** Identificar em `Oficial` os pedidos com `ecommerce.nomeEcommerce === "Amazon FBA Classic"` como canal `Amazon` e modalidade `Fulfillment`, mantendo os demais pedidos de `Oficial` normalmente.
- **FR-005:** Somar valores e quantidades contabilizáveis (`countableSale`) aos canais canônicos (`MagaLu`, `Shopee`, `Meli`, `Amazon`), compondo o GMV total e o atingimento da meta diária.
- **FR-006:** Expor `modalidade`, `fulfillment` (`boolean`) e `fulfillmentOrigem` (`string | null`) em cada linha de `analytics`.
- **FR-007:** Exibir coluna dedicada `Modalidade` na Tabela Analítica com badge `Fulfillment • <origem>` ou `Padrão`.
- **FR-008:** Permitir filtrar a Tabela Analítica pelas 4 empresas (`#analyticCompany`), por modalidade (`#analyticFulfillment`) e buscar por `"fulfillment"` ou origem em `#analyticSearch`.
- **FR-009:** Atualizar a identificação de fonte (`source`) e sincronizar `enrich-today.js` e `rebuild-confirmed-snapshots.js`.
- **FR-010:** Manter fila observável (`syncQueue`) com estado global e progresso por conta.
- **FR-011:** Executar retry exponencial automático em falhas de consulta (`base * 2^(attempt-1)`, limitado a `RETRY_MAX_MS` e `RETRY_MAX_ATTEMPTS`).
- **FR-012:** Expor consulta da fila atual em `GET /api/queue` (e campo `queue` em `GET /api/data`).
- **FR-013:** Permitir pausar (`POST /api/queue/pause`) e retomar (`POST /api/queue/resume`) a fila via API e painel na interface.

### Regras de Negócio (`BR`)

| ID | Empresa / Escopo | Condição | Resultado |
|---|---|---|---|
| **BR-001** | `OFICIALSP` | Marcador `Magalu Fulfillment` | `canal = 'MagaLu'`, `fulfillment = true`, `fulfillmentOrigem = 'Magalu Fulfillment'` |
| **BR-002** | `OFICIALSP` | Marcador `Shopee Fulfillment` | `canal = 'Shopee'`, `fulfillment = true`, `fulfillmentOrigem = 'Shopee Fulfillment'` |
| **BR-003** | `OFICIALSP2` | Marcador `Fulfillment` | `canal = 'Meli'`, `fulfillment = true`, `fulfillmentOrigem = 'Fulfillment'` |
| **BR-004** | `OFICIALSP` / `OFICIALSP2` | Sem os marcadores exigidos | Pedido descartado (não entra em GMV nem na Tabela Analítica) |
| **BR-005** | `Oficial` | `nomeEcommerce = 'Amazon FBA Classic'` | `canal = 'Amazon'`, `fulfillment = true`, `fulfillmentOrigem = 'Amazon FBA Classic'` |
| **BR-006** | `Oficial` / `Prioriza` | Demais pedidos | Classificação vigente, `fulfillment = false`, `fulfillmentOrigem = null` |
| **BR-007** | Retry Exponencial | Falha na consulta (tentativa $k \le \text{MAX}$) | $\text{backoff} = \min(\text{MAX\_MS}, \text{BASE\_MS} \cdot 2^{k-1})$ |
| **BR-008** | Pausa da Fila | Fila em estado `paused` | Cancela retry ativo, suspende agendador de 30 min e retorna HTTP `409` em `/api/update-data` até retomada |

---

## 3. Análise de Impacto Arquitetural (`architecture-impact-analysis`)

| Componente | Caminho | Tipo de Mudança | Risco | Observação |
|---|---|---|---|---|
| Ambiente e Git | [.gitignore](../../.gitignore), [.env.example](../../.env.example), [deploy/setup-vps.sh](../../deploy/setup-vps.sh) | Modificado | Baixo | `.env` ignorado no Git; 4 tokens documentados com placeholders |
| Classificador compartilhado | [site/dist/order-classifier.js](../../site/dist/order-classifier.js) | Criado | Baixo | UMD (`module.exports` + `window.ORDER_CLASSIFIER`); fonte única |
| Backend HTTP, Coleta e Fila | [server.js](../../server.js) | Modificado | Médio | 4 contas, filtro `marcador`, `syncQueue`, retry exponencial e rotas `/api/queue*` |
| HTML do dashboard | [site/dist/index.html](../../site/dist/index.html) | Modificado | Baixo | Botão/painel da fila, filtro `#analyticFulfillment`, coluna `Modalidade`, script `order-classifier.js` |
| Frontend JS e CSS | [site/dist/app.js](../../site/dist/app.js), [site/dist/analytics-tab.css](../../site/dist/analytics-tab.css) | Modificado | Médio | Renderização de `Modalidade`, filtros, `colspan="8"` e controles de fila/pausa |
| Scripts auxiliares | [enrich-today.js](../../enrich-today.js), [rebuild-confirmed-snapshots.js](../../rebuild-confirmed-snapshots.js) | Modificado | Baixo | Reutilizam `order-classifier.js` e carregam `.env.local` + `.env` |
| Suíte de testes | [tests/fulfillment-queue.test.js](../../tests/fulfillment-queue.test.js) | Criado | Baixo | Testes unitários, VM frontend e integração HTTP com mock Tiny |
| Documentação | [README.md](../../README.md) | Modificado | Baixo | Documenta novas empresas, regras Fulfillment e endpoints de fila |

---

## 4. Plano de Implementação (`implementation-planning`)

- `TASK-001` (`FR-001`, `NFR-001`): Atualizar `.gitignore`, `.env.example` e `deploy/setup-vps.sh`. — **Concluída**
- `TASK-002` (`FR-002`–`FR-006`, `BR-001`–`BR-006`): Criar `site/dist/order-classifier.js`. — **Concluída**
- `TASK-003` (`FR-001`–`FR-006`, `FR-009`): Integrar as 4 contas e filtro por marcadores em `server.js`. — **Concluída**
- `TASK-004` (`FR-010`–`FR-013`, `BR-007`, `BR-008`): Implementar `syncQueue`, retry exponencial e `/api/queue*` em `server.js`. — **Concluída**
- `TASK-005` (`FR-007`–`FR-009`, `FR-012`, `FR-013`): Atualizar `site/dist/index.html`, `site/dist/app.js` e `site/dist/analytics-tab.css`. — **Concluída**
- `TASK-006` (`FR-009`): Atualizar `enrich-today.js` e `rebuild-confirmed-snapshots.js`. — **Concluída**
- `TASK-007` (QA): Criar `tests/fulfillment-queue.test.js`. — **Concluída**
- `TASK-008` (`documentation-as-code`, `release-management`): Atualizar `README.md` e registrar `REQ-002`. — **Concluída**

---

## 5. Garantia da Qualidade (`quality-assurance`)

| Caso / Verificação | Requisitos / Regras | Ambiente | Resultado | Evidência |
|---|---|---|---|---|
| Verificação estática de `.gitignore` (`.env` e `.env.local`) e `.env.example` (4 variáveis com placeholders) | `FR-001`, `NFR-001` | PowerShell local (sandbox) | `PASSED` | `.gitignore` contém `.env` e `.env.local`; `.env.example` contém `TINY_OFICIALSP_TOKEN` e `TINY_OFICIALSP2_TOKEN` |
| Verificação estática das regras `BR-001`–`BR-006` em `site/dist/order-classifier.js` e rotas `/api/queue*` em `server.js` | `FR-002`–`FR-013`, `BR-001`–`BR-008` | PowerShell local (sandbox) | `PASSED` | Presença e integração verificadas em `order-classifier.js`, `server.js`, `index.html` e `app.js` |
| `npm test` (`node --test` — `tests/daily-targets.test.js` + `tests/fulfillment-queue.test.js`, `TC-201` a `TC-204`) | `FR-001`–`FR-013`, `BR-001`–`BR-008` | Local (sandbox) | `BLOCKED` | `node` não instalado/disponível no PATH do ambiente local |
| Validação com chamadas reais às contas Tiny `OFICIALSP` e `OFICIALSP2` | `FR-001`–`FR-005` | Local / VPS | `NOT EXECUTED` | Requer execução com Node.js 20+ e tokens reais no ambiente |

---

## 6. Prontidão para Release e Handover (`release-management`)

- **Decisão de prontidão:** `NOT READY` até execução de `npm test` (`node --test`) em ambiente com Node.js 20+.
- **Pré-requisitos para avançar para `READY FOR RELEASE`:**
  1. Executar `npm test` em máquina/ambiente com Node.js 20+ e confirmar aprovação de `tests/daily-targets.test.js` e `tests/fulfillment-queue.test.js` (`TC-201`–`TC-204`).
  2. Confirmar que `TINY_OFICIALSP_TOKEN` e `TINY_OFICIALSP2_TOKEN` estão presentes em `.env` ou `.env.local` na VPS antes do reload do PM2.
  3. Autorizar explicitamente commit e push para `main` (o push em `main` aciona `.github/workflows/deploy.yml`).
- **Plano de rollback:** Reverter o commit em `main` (`git revert <commit>`) e recarregar o PM2 (`deploy/update.sh`). Snapshots em `data/hourly-snapshots.json` permanecem retrocompatíveis.
