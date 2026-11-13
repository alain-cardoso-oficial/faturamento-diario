# REQ-001 — Ajuste da Meta Diária da Aplicação (Novembro/2026)

- **ID:** REQ-001
- **Classificação:** Alteração de regra de negócio (*business-rule change*)
- **Modo solicitado:** Implement (`Implement`)
- **Status atual:** `UNDER TESTING` (implementado localmente; suíte Node.js `npm test` bloqueada localmente por ausência de `node` no ambiente)
- **Data da revisão:** 2026-11-13
- **Branch Git:** `main` (alterações locais não commitadas)

---

## 1. Request Intake e Escopo (`request-intake`)

- **Objetivo de negócio:** Substituir a meta diária única fixa (`R$ 671.585`, referente apenas a `11/11/2026`) pela tabela oficial de 30 metas diárias para o período de `01/11/2026` a `30/11/2026`.
- **Comportamento anterior (verificado em fonte):**
  - [site/dist/index.html](../../site/dist/index.html) exibia estaticamente `<b>R$ 671.585</b>` e `<small id="targetGap">Faltam R$ 671.585 para a meta</small>`.
  - [site/dist/app.js](../../site/dist/app.js) fixava `const target=671585` dentro de `render()` e não atualizava o valor da meta em `renderEmpty()`.
  - [server.js](../../server.js) calculava `dataDate` no fuso `America/Sao_Paulo`, mas não retornava a meta diária nos endpoints `/api/data` e `/api/update-data`.
  - O módulo [raio-x](../../raio-x/server-v2.js) (cockpit BigQuery D-1) não utiliza meta diária.
- **Escopo incluído:**
  - Cadastro centralizado das 30 metas de `01/11/2026` a `30/11/2026`.
  - Exposição da meta diária (`target`) em `buildPayload` / `/api/data` / `/api/update-data` (`server.js`).
  - Renderização dinâmica do card **ATINGIMENTO DA META** (`site/dist/index.html` e `site/dist/app.js`), incluindo estado vazio, superação da meta, virada de dia à meia-noite (`America/Sao_Paulo`), importação de CSV e datas sem meta cadastrada.
  - Suíte de testes automatizados (`tests/daily-targets.test.js`) e atualização do [README.md](../../README.md).
- **Fora de escopo:**
  - Painel `raio-x/` (BigQuery D-1).
  - Alteração nas regras de consolidação de pedidos/canais do Tiny ERP.
  - Interface administrativa ou persistência em banco de dados para edição de metas.
  - Operações de commit, push ou deploy em produção na VPS.
- **Premissas registradas:**
  - `A-01`: A virada de dia segue sempre o fuso `America/Sao_Paulo` (`TZ = 'America/Sao_Paulo'`).
  - `A-02`: Para datas fora de `01/11/2026`–`30/11/2026`, não há fallback implícito; a aplicação retorna `null` e exibe `Sem meta` para evitar números incorretos ou divisão por zero.
  - `A-03`: Em importação manual de CSV offline (`#fileInput`), caso o servidor não tenha respondido ainda, aplica-se a meta do dia corrente em `America/Sao_Paulo`.

---

## 2. Requisitos e Regras de Negócio (`requirements-engineering`)

### Requisitos Funcionais (`FR`)
- **FR-001:** Armazenar os 30 valores diários de meta para novembro/2026 em fonte única de verdade ([site/dist/daily-targets.js](../../site/dist/daily-targets.js)).
- **FR-002:** Resolver a meta diária com base na data de referência (`YYYY-MM-DD`, `DD/MM/YYYY` ou `Date`) no fuso `America/Sao_Paulo`.
- **FR-003:** Expor o campo `target` (`number | null`) nos payloads de `/api/data` e `/api/update-data` em [server.js](../../server.js).
- **FR-004:** Atualizar dinamicamente no card **ATINGIMENTO DA META** o valor da meta (`#targetAmount`), percentual atingido (`#targetValue`), barra (`#targetProgress`) e texto de diferença (`#targetGap`).
- **FR-005:** No estado sem snapshots (`renderEmpty()`), exibir a meta do dia em `#targetAmount`, `0.0%` em `#targetValue`, barra zerada e `Aguardando primeira carga do dia` em `#targetGap`.
- **FR-006:** Quando `target` for `null` ou `<= 0`, exibir `Sem meta` em `#targetAmount`, `—` em `#targetValue`, barra `0%` e `Sem meta cadastrada para DD/MM/AAAA` em `#targetGap`.
- **FR-007:** Atualizar a meta exibida na virada da meia-noite (`America/Sao_Paulo`) via polling `/api/data` ou importação CSV.

### Requisitos Não Funcionais (`NFR`)
- **NFR-001:** Compartilhar a mesma tabela e lógica de resolução entre backend e frontend sem duplicação.
- **NFR-002:** Manter retrocompatibilidade do JSON de `/api/data` e `/api/update-data`, sem adicionar novas dependências npm.
- **NFR-003:** Remover o valor fixo legado `671585` do HTML estático e do cálculo hardcoded no frontend.

### Regras de Negócio (`BR`)
- **BR-001 (Tabela oficial — Novembro/2026, soma total R$ 6.500.006):**

| Data | Dia | Meta (BRL) |
|---|---|---:|
| 01/11/2026 | Domingo | 82.613 |
| 02/11/2026 | Segunda-feira | 139.942 |
| 03/11/2026 | Terça-feira | 262.832 |
| 04/11/2026 | Quarta-feira | 252.939 |
| 05/11/2026 | Quinta-feira | 251.419 |
| 06/11/2026 | Sexta-feira | 210.552 |
| 07/11/2026 | Sábado | 114.005 |
| 08/11/2026 | Domingo | 118.019 |
| 09/11/2026 | Segunda-feira | 234.051 |
| 10/11/2026 | Terça-feira | 262.832 |
| 11/11/2026 | Quarta-feira | 671.585 |
| 12/11/2026 | Quinta-feira | 251.419 |
| 13/11/2026 | Sexta-feira | 210.552 |
| 14/11/2026 | Sábado | 114.005 |
| 15/11/2026 | Domingo | 82.613 |
| 16/11/2026 | Segunda-feira | 234.051 |
| 17/11/2026 | Terça-feira | 262.832 |
| 18/11/2026 | Quarta-feira | 252.939 |
| 19/11/2026 | Quinta-feira | 251.419 |
| 20/11/2026 | Sexta-feira | 147.387 |
| 21/11/2026 | Sábado | 114.005 |
| 22/11/2026 | Domingo | 118.019 |
| 23/11/2026 | Segunda-feira | 234.051 |
| 24/11/2026 | Terça-feira | 262.832 |
| 25/11/2026 | Quarta-feira | 252.939 |
| 26/11/2026 | Quinta-feira | 251.419 |
| 27/11/2026 | Sexta-feira | 392.660 |
| 28/11/2026 | Sábado | 114.005 |
| 29/11/2026 | Domingo | 118.019 |
| 30/11/2026 | Segunda-feira | 234.051 |

- **BR-002:** Fuso oficial `America/Sao_Paulo` para determinação da data corrente.
- **BR-003:** Datas fora do intervalo cadastrado retornam `null` (sem meta).

---

## 3. Análise de Impacto Arquitetural (`architecture-impact-analysis`)

| Componente | Caminho | Tipo de mudança | Risco | Observação |
|---|---|---|---|---|
| Módulo compartilhado de metas | [site/dist/daily-targets.js](../../site/dist/daily-targets.js) | Criado | Baixo | UMD (`module.exports` + `window.DAILY_TARGETS`); fonte única |
| Backend HTTP / API | [server.js](../../server.js) | Modificado | Baixo | `brDate` usa `brDateIso`; `buildPayload` adiciona `target` |
| HTML do dashboard | [site/dist/index.html](../../site/dist/index.html) | Modificado | Baixo | Remove `R$ 671.585` fixo; adiciona `#targetAmount` e `daily-targets.js` |
| Frontend JS do dashboard | [site/dist/app.js](../../site/dist/app.js) | Modificado | Médio | `resolveTarget()`, `renderTargetCard()`, `activeDataDate` e `serverTarget` |
| Manifesto npm | [package.json](../../package.json) | Modificado | Baixo | Adiciona script `"test": "node --test"` (sem novas deps) |
| Suíte de testes | [tests/daily-targets.test.js](../../tests/daily-targets.test.js) | Criado | Baixo | Testes unitários, VM frontend e smoke test HTTP |
| Cockpit Raio X | `raio-x/*` | Sem alteração | N/A | Não utiliza meta diária |
| Snapshots e cache | `data/hourly-snapshots.json`, `data/tiny-order-cache.json` | Sem alteração | N/A | Schema preservado |
| Deploy / VPS | `.github/workflows/deploy.yml`, `deploy/update.sh`, `ecosystem.config.cjs` | Sem alteração | Baixo | Deploy padrão fará `git pull` + `pm2 reload bi-vendas` |

---

## 4. Plano de Implementação (`implementation-planning`)

- `TASK-001` (`FR-001`, `FR-002`, `BR-001`–`BR-003`, `NFR-001`): Criar `site/dist/daily-targets.js`. — **Concluída**
- `TASK-002` (`FR-003`, `NFR-002`): Atualizar `server.js` para usar `brDateIso` e retornar `target` em `buildPayload`. — **Concluída**
- `TASK-003` (`FR-004`–`FR-007`, `NFR-003`): Atualizar `site/dist/index.html` e `site/dist/app.js`. — **Concluída**
- `TASK-004` (QA): Criar `tests/daily-targets.test.js` e adicionar `"test": "node --test"` em `package.json`. — **Concluída**
- `TASK-005` (`documentation-as-code`, `release-management`): Atualizar `README.md` e registrar `REQ-001`. — **Concluída**

---

## 5. Garantia da Qualidade (`quality-assurance`)

| Caso / Verificação | Requisitos / Regras | Ambiente | Resultado | Evidência |
|---|---|---|---|---|
| Conferência exata 30/30 contra JSON do usuário e dias da semana `pt-BR` | `FR-001`, `BR-001` | PowerShell local (sandbox) | `PASSED` | `30/30` entradas validadas em `site/dist/daily-targets.js` e `tests/daily-targets.test.js` (soma `6500006`) |
| Verificação de remoção de `671585` / `671.585` no HTML e `app.js` | `NFR-003` | PowerShell local (sandbox) | `PASSED` | `index.html contains 671585/671.585: False`; `app.js contains 671585/671.585: False` |
| Validação de sintaxe JSON de `package.json` | `NFR-002` | PowerShell local (sandbox) | `PASSED` | `ConvertFrom-Json` OK (`scripts.test = node --test`) |
| `npm test` (`node --test` — `TC-001` a `TC-008`) | `FR-001`–`FR-007`, `BR-001`–`BR-003` | Local (sandbox) | `BLOCKED` | `node` não instalado/disponível no ambiente local (`node -v` falhou com `CommandNotFoundException`) |
| Verificação visual em navegador real com `server.js` ativo | `FR-004`–`FR-007` | Local / VPS | `NOT EXECUTED` | Depende da execução de `node server.js` e abertura no navegador |

---

## 6. Prontidão para Release e Handover (`release-management`)

- **Decisão de prontidão:** `NOT READY` enquanto `npm test` (`node --test`) não for executado em ambiente com Node.js 20+ (ex.: máquina de desenvolvimento com Node ou ambiente de homologação/CI antes do deploy).
- **Pré-requisitos para avançar para `READY FOR RELEASE`:**
  1. Executar `npm test` em ambiente com Node.js 20+ e confirmar aprovação dos 8 cenários (`TC-001`–`TC-008`).
  2. (Opcional recomendado) Subir `node server.js` localmente ou validar visualmente o card **ATINGIMENTO DA META** após deploy autorizado.
  3. Autorizar explicitamente commit e push para `main` (o push em `main` aciona `.github/workflows/deploy.yml`, que executa `git pull origin main`, `npm ci --omit=dev` e `pm2 reload bi-vendas` na VPS).
- **Plano de rollback:** Reverter o commit em `main` (`git revert <commit>`) e executar `deploy/update.sh` (ou push para acionar `.github/workflows/deploy.yml`). Sem migrações destrutivas ou alterações de schema em `data/`.
- **Riscos residuais:**
  - A partir de `01/12/2026`, o card exibirá `Sem meta` até que um novo cronograma mensal seja cadastrado em `site/dist/daily-targets.js`.
  - A suíte `tests/daily-targets.test.js` foi verificada estaticamente e por inspeção, mas aguarda execução real em Node.js 20+.

