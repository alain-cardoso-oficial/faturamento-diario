# REQ-003 — Fila de Atualização Incremental em Tempo Real via `dataAtualizacao` (3 Min) + Reconciliação de Segurança

- **ID:** REQ-003
- **Classificação:** Melhoria de arquitetura, performance e regra de sincronização (*performance/reliability improvement* / *integration*)
- **Modo solicitado:** `Full implementation` (Implementação autorizada pelo usuário)
- **Status atual:** `UNDER TESTING` (implementação concluída em código, testes e documentação; aguardando validação final em runtime Node 20+ e autorização para commit/push)
- **Data da revisão:** 2026-11-13
- **Branch Git:** `main` (commit base observado: `ce8bf9c`)

---

## 1. Request Intake e Escopo (`request-intake`)

### 1.1 Problema e Objetivo de Negócio
Reduzir drasticamente a carga de requisições à API do Tiny ERP — que atualmente reconsulta todos os pedidos do dia inteiro a cada ciclo de 30 minutos — implantando uma **fila de atualização incremental em tempo real** a cada **3 minutos** via parâmetro `dataAtualizacao` (`dd/mm/yyyy hh:mm:ss` em `America/Sao_Paulo`), processando somente os pedidos criados ou alterados desde o último sync bem-sucedido, mantendo uma **reconciliação completa automática de segurança** e preservando a evolução em **faixas de 30 minutos** no gráfico.

### 1.2 Comportamento Atual (Verificado no Código-Fonte)
- **Agendamento e consulta ([server.js](../../server.js#L231-L271), [L624-L637](../../server.js#L624-L637)):**
  - `schedule()` dispara `updateData()` apenas nos minutos `:00` e `:30`.
  - `searchOrdersByQuery()` consulta todos os pedidos do dia (`dataInicial=hoje`, `dataFinal=hoje`) em todas as 4 contas (`Oficial`, `Prioriza`, `OFICIALSP`, `OFICIALSP2`).
- **Cache e detecção de alteração ([server.js](../../server.js#L335-L432)):**
  - `hasUsableCache()` bloqueia reconsulta a `pedido.obter.php` para pedidos já presentes em `data/tiny-order-cache.json`, impedindo atualizar `valor`, `itens`, `ecommerce` ou `marcadores` alterados posteriormente.
- **Estado, snapshots e UI ([server.js](../../server.js#L509-L538), [site/dist/app.js](../../site/dist/app.js#L66-L82), [L176](../../site/dist/app.js#L176), [site/dist/index.html](../../site/dist/index.html#L82)):**
  - `updateData()` recalcula todo o dia do zero a partir da lista completa retornada no ciclo e grava o array `analytics` inteiro dentro de cada slot de 30 min em `data/hourly-snapshots.json` (`.slice(-48)`).
  - O frontend já consulta `/api/data` a cada **15 segundos** (`setInterval(..., 15000)`).

### 1.3 Decisões Confirmadas pelo Solicitante
1. **Cadência incremental:** Execução automática a cada **3 minutos** (`180s`).
2. **Cursor temporal (`watermark`):** Pesquisar a partir do **último sync bem-sucedido** (cobrindo automaticamente períodos de pausa, falha ou retry exponencial sem perder alterações).
3. **Filtro de data do pedido:** Manter contabilizados **somente pedidos do dia atual** (`data_pedido === hoje` em `America/Sao_Paulo`), descartando pedidos antigos eventualmente retornados por `dataAtualizacao`.
4. **Reconciliação de segurança:** Manter uma **reconciliação completa automática** periódica de segurança (ex.: a cada 60 minutos, configurável) além da carga inicial (*bootstrap*) do dia e disparo manual.
5. **Gráfico principal:** Manter o gráfico `GMV POR ATUALIZAÇÃO (30 MIN)` agrupado na **evolução de 30 minutos** (`:00` e `:30`), com a barra da faixa corrente atualizando em tempo real.

### 1.4 Escopo e Exclusões
- **Incluído:**
  - Persistência do estado vivo consolidado do dia (`data/daily-orders-state.json`) separado da série histórica de 30 min (`data/hourly-snapshots.json`), com `watermarks` individuais por empresa.
  - Ciclo incremental a cada 3 minutos via `dataAtualizacao` (`dd/mm/yyyy hh:mm:ss` em `America/Sao_Paulo`), com sobreposição de segurança configurável (`30s`).
  - Carga base (*bootstrap*) na inicialização sem estado do dia ou virada `00:00` BRT + reconciliação completa automática de segurança (padrão `60 min`, configurável) e opção manual completa (`?mode=full`).
  - Enfileiramento seletivo em `syncQueue` apenas dos pedidos retornados pela janela incremental (com reconsulta forçada de `pedido.obter.php` para atualizar o cache), aplicação de `upsert`/remoção no estado diário e recálculo em tempo real.
  - Adequação de indicadores na UI (modo incremental 3 min, última varredura incremental, botão/opção de reconciliação completa e histórico de fila), atualização de `.gitignore`, `README.md` e suíte `node --test`.
- **Fora de escopo:**
  - Módulo D-1 `raio-x/` (BigQuery).
  - Alteração da tabela de metas diárias (`REQ-001`) ou das regras de classificação Fulfillment (`REQ-002`).
  - Commit, push ou deploy em produção na VPS sem autorização específica.

### 1.5 Premissas e Dependências
- **Premissas (`A`):**
  - `A-01`: O fuso esperado pela API Tiny v2 para `dataAtualizacao` é `America/Sao_Paulo` (GMT-3), formatado explicitamente como `dd/mm/yyyy hh:mm:ss`.
  - `A-02`: Sobreposição de segurança padrão de `30` segundos (`TINY_INCREMENTAL_OVERLAP_SEC = 30`) é aplicada sobre o watermark (`queryStartedAt` do último sync bem-sucedido da conta) para proteger contra arredondamento de segundo ou latência de indexação no Tiny; pedidos duplicados na sobreposição são deduplicados de forma idempotente pelo ID.
  - `A-03`: Intervalo padrão proposto para a reconciliação completa automática de segurança é `60 minutos` (`TINY_FULL_RECONCILE_INTERVAL_MS = 3600000`), mantendo o ciclo incremental de `3 minutos` (`TINY_INCREMENTAL_INTERVAL_MS = 180000`).
  - `A-04`: Em caso de virada de dia (`00:00` em `America/Sao_Paulo`), o estado diário e os watermarks do dia anterior são reiniciados automaticamente e o próximo ciclo executa `bootstrap` completo do novo dia.
- **Dependências:** API Tiny ERP v2 (`pedidos.pesquisa.php` com `dataAtualizacao` e `marcador`, e `pedido.obter.php`).

---

## 2. Requisitos e Regras de Negócio (`requirements-engineering`)

### 2.1 Requisitos Funcionais (`FR`)
- **FR-001 (Estado diário persistido e `bootstrap`):** Persistir o mapa consolidado de pedidos do dia corrente e o último `watermark` bem-sucedido por empresa (`data/daily-orders-state.json`). Se não houver estado válido para `dataDate === hoje` (primeiro start, cache limpo ou virada de meia-noite BRT), executar carga completa (`bootstrap`).
- **FR-002 (Ciclo incremental a cada 3 minutos):** Agendar automaticamente o ciclo incremental a cada 3 minutos (`TINY_INCREMENTAL_INTERVAL_MS = 180000`), respeitando pausa da fila (`syncQueue.paused`) e evitando sobreposição com execução já ativa.
- **FR-003 (Consulta com `dataAtualizacao` por conta e watermark):** Para cada empresa, consultar `pedidos.pesquisa.php` usando `dataAtualizacao` formatado em `dd/mm/yyyy hh:mm:ss` (`America/Sao_Paulo`), calculado a partir de `Math.min(watermarkEmpresa - overlapMs, now - 3min)` (usando o início do ciclo bem-sucedido anterior como referência segura), preservando o filtro `marcador` em `OFICIALSP` e `OFICIALSP2`.
- **FR-004 (Filtro estrito do dia atual):** Ao processar os pedidos retornados pela janela incremental, descartar imediatamente qualquer pedido cuja `data_pedido` não pertença ao dia corrente em `America/Sao_Paulo` (salvo se o ID constar no estado ativo do dia, caso em que deve ser removido).
- **FR-005 (Fila seletiva e refresh de detalhe alterado):** Enfileirar em `syncQueue` para chamada `pedido.obter.php` **somente** os pedidos retornados na janela incremental, ignorando o bypass de cache (`forceRefresh`) para garantir captura de alterações de `valor`, `itens`, `frete`, `desconto`, `situacao`, `ecommerce` e `marcadores`.
- **FR-006 (Aplicação de delta: upsert e remoção):**
  - Se o pedido detalhado passar a `Cancelado`/`Excluído`, sair da data de hoje ou deixar de atender `shouldIncludeOrder(order, empresa)`, removê-lo do estado ativo do dia.
  - Caso contrário, fazer upsert do pedido no estado ativo do dia e atualizar `data/tiny-order-cache.json` ao final do lote (ou em interrupção parcial).
- **FR-007 (Atualização em tempo real mantendo barras de 30 min):** Recalcular `channels`, `orders`, `business`, `analytics`, `accounts` e `metrics` a partir do estado diário atualizado e fazer upsert somente no slot de 30 min corrente (`slotKey(now)`) em `data/hourly-snapshots.json`, mantendo intactos todos os slots anteriores e sem armazenar cópias redundantes de `analytics` nos slots históricos passados.
- **FR-008 (Reconciliação completa automática de segurança e manual):**
  - Executar automaticamente uma reconciliação completa (`mode: 'full'`) a cada `TINY_FULL_RECONCILE_INTERVAL_MS` (padrão 60 min), removendo eventuais pedidos fisicamente ausentes/desmarcados e garantindo consistência total.
  - Permitir disparo manual via `Atualizar dados` (incremental por padrão) e `GET/POST /api/update-data?mode=full` (ou botão auxiliar na barra/fila para força total).
- **FR-009 (Observabilidade na fila e UI):** Expor no `GET /api/queue` e no painel da UI o modo do ciclo (`bootstrap`, `incremental`, `full`), timestamp do último sync por empresa, quantidade de pedidos alterados enfileirados e status da próxima reconciliação completa; atualizar legendas (`AUTO 3 MIN • TEMPO REAL`, mantendo título `GMV POR ATUALIZAÇÃO (30 MIN)`).

### 2.2 Requisitos Não Funcionais (`NFR`)
- **NFR-001 (Timezone determinístico):** Formatar `dataAtualizacao` e comparar `data_pedido` sempre em `America/Sao_Paulo`.
- **NFR-002 (Eficiência de API):** Ciclos incrementais sem alterações (`EMPTY`) devem executar `0` chamadas a `pedido.obter.php`.
- **NFR-003 (Eficiência de I/O em disco):** Eliminar gravação síncrona de `tiny-order-cache.json` a cada pedido dentro do loop quando em modo normal (gravar em lote/lotes e em falha/pausa), e remover duplicação histórica de `analytics` em slots fechados de `hourly-snapshots.json`.
- **NFR-004 (Retrocompatibilidade):** Manter compatibilidade integral com os contratos de `/api/data`, `/api/queue*` e leitura de `data/hourly-snapshots.json` existentes.
- **NFR-005 (Testabilidade):** Tornar intervalos, janela, overlap e relógio/datas injetáveis ou configuráveis via env vars para execução rápida em `node --test`.

### 2.3 Regras de Negócio (`BR`)

| ID | Regra / Condição | Comportamento Esperado | Camada |
|---|---|---|---|
| **BR-001** | Início do dia sem estado consolidado para `hoje` (`America/Sao_Paulo`) | Executa `bootstrap` completo do dia antes de ativar o ciclo incremental de 3 min | Backend |
| **BR-002** | Ciclo incremental a cada 3 min com `watermark` por conta | Consulta `dataAtualizacao = fmtBRT(Math.min(watermark - overlap, now - 3min))`; o novo `watermark` só avança após conclusão sem erro da respectiva empresa (usando o timestamp capturado no início da pesquisa daquela empresa) | Backend |
| **BR-003** | Pedido retornado por `dataAtualizacao` com `data_pedido !== hoje` | Não entra em `dailyOrdersState`, `analytics` nem no GMV (e é removido se já existisse antes no estado do dia) | Backend |
| **BR-004** | Pedido retornado por `dataAtualizacao` já presente em cache | Reconsulta `pedido.obter.php` (`forceRefresh`) para atualizar valores, situação, `ecommerce` e marcadores | Backend |
| **BR-005** | Mudança para `Cancelado`/`Excluído` ou perda de marcador (`OFICIALSP`/`OFICIALSP2`) | Remove o pedido do estado ativo do dia e subtrai seu valor do canal e GMV total | Backend |
| **BR-006** | Mudança `Em aberto` ↔ `Aprovado`/`Faturado` | Atualiza linha em `analytics` e inclui/remove da soma de GMV (`countableSale`) | Backend |
| **BR-007** | Reconciliação completa periódica (`full`) | A cada 60 min (ou sob demanda `?mode=full`), reconfere todas as empresas para o dia atual e remove divergências residuais | Backend |
| **BR-008** | Fila pausada (`paused = true`) | Suspende tanto o loop incremental de 3 min quanto a reconciliação completa até `POST /api/queue/resume`; ao retomar, o `watermark` anterior garante captura de tudo que mudou durante a pausa | Backend |

### 2.4 Critérios de Aceitação (`AC`)
- **AC-001 (Bootstrap + Incremental 3 min):** No primeiro ciclo do dia, carrega todo o dia; no ciclo seguinte após 3 minutos, envia apenas `dataAtualizacao` no formato `dd/mm/yyyy hh:mm:ss` (BRT) referente ao `watermark - overlap`.
- **AC-002 (Ciclo vazio):** Sem alterações na janela, realiza 0 chamadas a `pedido.obter.php` e preserva totais e Tabela Analítica.
- **AC-003 (Delta positivo e alteração de pedido existente):** Novo pedido ou pedido que muda de `Em aberto` para `Aprovado` ou altera valor dentro da janela é reconsultado em `pedido.obter.php` e atualiza exatamente o GMV e o slot de 30 min corrente.
- **AC-004 (Cancelamento e perda de marcador):** Pedido de hoje alterado para `Cancelado` ou sem marcador Fulfillment na janela incremental é removido da Tabela Analítica e subtraído do GMV.
- **AC-005 (Isolamento de dias anteriores):** Pedido de `data_pedido` anterior a hoje retornado por `dataAtualizacao` é descartado e não soma no GMV do dia.
- **AC-006 (Pausa / Retry com recuperação pelo watermark):** Se a fila ficar pausada ou em retry por 10 minutos, ao retomar/recuperar a consulta `dataAtualizacao` retrocede até o último `watermark` bem-sucedido e captura todos os pedidos alterados nos 10 minutos.
- **AC-007 (Reconciliação completa de segurança + virada de dia):** Após atingir o intervalo de reconciliação completa (ou `?mode=full`), corrige eventual pedido ausente na consulta incremental; na virada de `00:00` BRT, reinicia o estado e faz novo `bootstrap`.

---

## 3. Análise de Impacto Arquitetural (`architecture-impact-analysis`)

### 3.1 Matriz de Impacto

| Componente | Caminho | Tipo de Mudança | Risco | Estratégia de Validação |
|---|---|---|---|---|
| Motor incremental, watermarks, estado diário e schedulers | [server.js](../../server.js) | Modificado | **Alto** | Testes unitários e integração HTTP com mock Tiny cobrindo bootstrap, `dataAtualizacao`, `watermark` pós-pausa/retry, cancelamento, pedido antigo e reconciliação completa |
| Persistência de estado vivo do dia | Novo runtime: `data/daily-orders-state.json` | Criado em runtime (ignorado no Git) | Médio | Verificar persistência atômica e recuperação pós-restart sem perder o dia |
| Série histórica de 30 min | `data/hourly-snapshots.json` | Otimizado (compatível) | Baixo | Garantir preservação dos slots de 30 min e compatibilidade com `buildPayload()` |
| `.gitignore` | [.gitignore](../../.gitignore) | Modificado (ignorar `data/*.json` ou `data/daily-orders-state.json`) | Baixo | Verificar `git status` |
| Frontend HTML e JS | [site/dist/index.html](../../site/dist/index.html), [site/dist/app.js](../../site/dist/app.js) | Modificado | Baixo | Testes em VM (`tests/`) para exibição de modo/watermark na fila e legendas |
| Suíte de testes | Novo: `tests/incremental-sync.test.js` + existentes | Criado | Baixo | Execução integral de `npm test` (`node --test`) em Node 20+ |
| Documentação | [README.md](../../README.md), [REQ-003](../../docs/requests/REQ-003-fila-incremental-data-atualizacao.md) | Modificado | Baixo | Revisão de parâmetros, endpoints e links |
| Cockpit D-1 / Deploy / Nginx | `raio-x/*`, `deploy/*` | Sem alteração | N/A | `deploy/backup-data.sh` já inclui toda a pasta `data/` |

### 3.2 Decisões Arquiteturais Relevantes (ADRs Resumidos)
1. **Watermark por conta capturado antes da pesquisa (`queryStartedAt - overlap`):**
   - *Por quê:* Se um pedido for alterado enquanto a paginação/enriquecimento está em curso, avançar o watermark para o horário de *fim* poderia pular esse pedido; gravar `queryStartedAt - overlap` (ex.: `-30s`) por conta apenas quando a conta conclui garante consistência entre contas mesmo se uma falhar e entrar em retry exponencial.
2. **Separação entre Estado Vivo Diário (`data/daily-orders-state.json`) e Série de 30 min (`data/hourly-snapshots.json`):**
   - *Por quê:* Em atualizações a cada 3 minutos, recalcular todo o dia exige ter os pedidos já consolidados do dia em memória/disco sem rebaixar centenas de pedidos no Tiny; manter `analytics` apenas no estado vivo/último snapshot evita reescrever arrays grandes em 48 slots a cada 3 min e mantém intacto o gráfico de 30 minutos.
3. **Combinação `dataInicial`/`dataFinal` + `dataAtualizacao` vs filtro local de `data_pedido`:**
   - *Por quê:* Em algumas contas movimentadas, muitos pedidos de dias anteriores são faturados no dia corrente. Enviar `dataAtualizacao` e validar/filtrar `data_pedido === hoje` no backend garante precisão absoluta mesmo que a API Tiny retorne registros antigos editados hoje. *(Durante testes reais, recomenda-se observar se enviar `dataInicial=hoje&dataFinal=hoje` junto com `dataAtualizacao` funciona como filtro `AND` no Tiny para economizar paginação ainda mais — caso contrário, consultar somente com `dataAtualizacao` + filtro local `data_pedido === hoje` já resolve com segurança).*

---

## 4. Plano de Implementação (`implementation-planning`)

Sequência ordenada para execução após autorização explícita:

| Task | Requisitos | Arquivos / Módulos | Descrição e Critério de Conclusão | Dependência |
|---|---|---|---|---|
| **TASK-001** | `FR-001`, `NFR-003` | [.gitignore](../../.gitignore), [server.js](../../server.js) | Ignorar `data/daily-orders-state.json`; criar persistência atômica para estado vivo do dia (`ordersByKey`, `watermarks`, `lastFullReconcileAt`, `dataDate`) e função `formatTinyDateTimeBRT`. | — |
| **TASK-002** | `FR-002`, `FR-003`, `BR-001`, `BR-002`, `NFR-001`, `NFR-002` | [server.js](../../server.js) | Implementar `searchOrders` com suporte a modo `bootstrap`/`full` (`dataInicial`/`dataFinal`) e modo `incremental` (`dataAtualizacao` a partir de `watermark - overlap` por conta), mantendo suporte a `marcador` em `OFICIALSP`/`OFICIALSP2`. | `TASK-001` |
| **TASK-003** | `FR-004`–`FR-006`, `BR-003`–`BR-006`, `NFR-003` | [server.js](../../server.js) | Implementar fila incremental de detalhe com `forceRefresh` para pedidos retornados em `dataAtualizacao`, filtro estrito de `data_pedido === hoje`, upsert/remoção em `daily-orders-state.json`, gravação em lote do cache e recálculo com upsert no slot de 30 min corrente (`hourly-snapshots.json`). | `TASK-002` |
| **TASK-004** | `FR-002`, `FR-007`, `FR-008`, `BR-007`, `BR-008` | [server.js](../../server.js) | Substituir scheduler de 30 min por loop incremental de 3 min (`TINY_INCREMENTAL_INTERVAL_MS`) + reconciliação completa automática de segurança (`TINY_FULL_RECONCILE_INTERVAL_MS`, padrão 60 min) + `?mode=full` em `/api/update-data`, preservando `syncQueue`, retry exponencial e pausa/retomada com recuperação pelo `watermark`. | `TASK-003` |
| **TASK-005** | `FR-009` | [site/dist/index.html](../../site/dist/index.html), [site/dist/app.js](../../site/dist/app.js), [site/dist/analytics-tab.css](../../site/dist/analytics-tab.css) | Exibir modo de execução (`Incremental 3 min` / `Reconciliação completa`), `lastSyncAt` por conta no painel da fila, botão opcional de reconciliação completa e atualizar rodapé para `AUTO 3 MIN • TEMPO REAL` mantendo título do gráfico em `30 MIN`. | `TASK-004` |
| **TASK-006** | QA (`AC-001`–`AC-007`) | `tests/incremental-sync.test.js` (novo) + existentes | Implementar testes automatizados com mock Tiny cobrindo bootstrap, ciclo incremental sem alterações (0 detalhes), novo/alterado, cancelamento, pedido de dia anterior, pausa/retry com watermark, reconciliação completa e virada de dia BRT. | `TASK-001`–`TASK-005` |
| **TASK-007** | `documentation-as-code` | [README.md](../../README.md), [REQ-003](../../docs/requests/REQ-003-fila-incremental-data-atualizacao.md) | Documentar variáveis de ambiente da fila incremental, fluxo em 2 camadas (3 min incremental + 60 min reconciliação completa) e registrar resultados finais. | `TASK-006` |

- **Estratégia Git recomendada:** Criar branch dedicada após autorização (ou implementar localmente antes de commit/push autorizado).
- **Plano de rollback:** Reverter commit (`git revert <commit>`) e recarregar PM2; `data/hourly-snapshots.json` e `data/tiny-order-cache.json` permanecem retrocompatíveis.

---

## 5. Validação de Qualidade e Prontidão (`quality-assurance` & `release-management`)

### 5.1 Resumo das Alterações Implementadas
- **[site/dist/order-classifier.js](../../site/dist/order-classifier.js):** Adicionadas as funções puras `formatTinyDateTimeBrt`, `computeIncrementalSinceDate`, `normalizeOrderDateIso` e `isOrderFromDate`.
- **[server.js](../../server.js):**
  - Adicionada persistência atômica do estado consolidado do dia (`data/daily-orders-state.json`, configurável via `DAILY_STATE_FILE`) com `watermarks`, `lastSinceByAccount`, `ordersByAccount`, `lastIncrementalAt` e `lastFullReconcileAt`.
  - Implementado `resolveSyncMode` alternando automaticamente entre `bootstrap` (1ª carga do dia ou virada de meia-noite BRT), `incremental` (a cada 3 min via `dataAtualizacao` com `watermark - overlap` de `30s`) e `full` (reconciliação completa automática a cada `60 min` ou manual via `?mode=full`).
  - Na janela incremental, pedidos de dias anteriores (`!isOrderFromDate(summary, today)`) são descartados antes da chamada `pedido.obter.php`; pedidos do dia corrente alterados passam por `forceRefresh: true` para atualizar `valor`, `situacao`, `ecommerce` e `marcadores`, aplicando `upsert` ou `delete` no estado consolidado do dia.
  - Gravação em lote de `data/tiny-order-cache.json` ao final de cada conta (ou em interrupção/pausa) e deduplicação de `analytics` em slots históricos fechados de `data/hourly-snapshots.json`, mantendo a evolução do gráfico em slots de 30 minutos (`:00` e `:30`).
- **[site/dist/index.html](../../site/dist/index.html) e [site/dist/app.js](../../site/dist/app.js):**
  - Exibição do modo de sincronização (`Incremental 3 min`, `Reconciliação completa`, `Bootstrap inicial`), indicador `Desde: dd/mm/yyyy hh:mm:ss` e total de pedidos ativos por conta no painel da fila, botão **Reconciliação completa** (`#queueFullSyncBtn` -> `/api/update-data?mode=full`) e rodapé atualizado para `AUTO 3 MIN • TEMPO REAL`.
- **[tests/incremental-sync.test.js](../../tests/incremental-sync.test.js):**
  - Criados os testes `TC-301` a `TC-305` validando formatação `dd/mm/yyyy hh:mm:ss` em `America/Sao_Paulo`, cálculo de `watermark` pós-pausa/retry, filtro estrito do dia atual, bootstrap seguido de ciclo incremental vazio (`0` chamadas a `pedido.obter.php`), delta incremental (alteração de valor, cancelamento, novo pedido e descarte de pedido de dia anterior) e reconciliação completa (`?mode=full`).

### 5.2 Evidências de Verificação Executadas
- **Verificação estrutural e balanceamento léxico (`PowerShell`):** `PASSED` (`server.js`, `site/dist/order-classifier.js`, `site/dist/app.js`, `tests/incremental-sync.test.js` com chaves e parênteses 100% balanceados).
- **Execução de `npm test` (`node --test`):** `BLOCKED` na estação Windows atual por ausência do binário `node` no `PATH` local (mesma restrição ambiental documentada em `REQ-001` e `REQ-002`; pronto para execução imediata em ambiente com Node.js 20+).
