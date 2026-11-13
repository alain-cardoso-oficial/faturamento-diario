# Black Friday Oficial 2026 — Hora a Hora

Dashboard conectado diretamente às APIs de pedidos do Tiny das operações **Oficial**, **Prioriza**, **OFICIALSP** e **OFICIALSP2**.

## Como iniciar

Clique duas vezes em `iniciar-dashboard.cmd` ou execute `npm start`.

O servidor pesquisa somente os pedidos do dia nos quatro ambientes, consulta o detalhe de cada pedido, exclui pedidos cancelados, excluídos e em aberto da soma de GMV, aplica as regras de filtragem e classificação de canal/Fulfillment ([`site/dist/order-classifier.js`](site/dist/order-classifier.js)) e registra um snapshot acumulado a cada meia hora. O gráfico calcula o movimento de cada janela pela diferença entre snapshots.

Os tokens ficam em `.env.local` ou `.env`, ambos ignorados pelo Git. O histórico local fica em `data/hourly-snapshots.json` e o cache de detalhes em `data/tiny-order-cache.json` (também ignorados pelo Git).

O botão **Atualizar dados** força uma leitura imediata. O servidor atualiza automaticamente nos minutos `00` e `30`, enquanto o front consulta o resultado local a cada 15 segundos.

## Regras de Fulfillment e Multiempresa

Centralizadas em [`site/dist/order-classifier.js`](site/dist/order-classifier.js):

- **OFICIALSP (`TINY_OFICIALSP_TOKEN`):** captura apenas pedidos com os marcadores `Magalu Fulfillment` (somado ao canal `MagaLu`) e `Shopee Fulfillment` (somado ao canal `Shopee`). Demais pedidos são descartados para evitar duplicidade.
- **OFICIALSP2 (`TINY_OFICIALSP2_TOKEN`):** captura apenas pedidos com o marcador `Fulfillment` (somado ao canal `Meli`). Demais pedidos são descartados.
- **Oficial (`TINY_OFICIAL_TOKEN`):** captura todos os pedidos do dia; pedidos com `"nomeEcommerce": "Amazon FBA Classic"` são somados ao canal `Amazon` e marcados como `Fulfillment`.
- **Prioriza (`TINY_PRIORIZA_TOKEN`):** captura todos os pedidos do dia conforme regras de canal padrão.
- **Tabela Analítica:** exibe a coluna **Modalidade** (`Fulfillment` + origem do marcador/`Amazon FBA Classic` vs `Padrão`) e permite filtrar por empresa (`Oficial`, `Prioriza`, `OFICIALSP`, `OFICIALSP2`), por modalidade (`Todas`, `Somente Fulfillment`, `Somente Padrão`) ou buscar pelo termo `fulfillment`.

## Fila de Consultas, Retry Exponencial e Pausa

Em caso de falha nas consultas à API Tiny (`pedidos.pesquisa.php` ou `pedido.obter.php`), o servidor aplica **retry exponencial** automático (base padrão `5s`, fator `2x`, teto `5 min`, até `6` tentativas, configuráveis por `TINY_RETRY_BASE_MS`, `TINY_RETRY_MAX_MS` e `TINY_RETRY_MAX_ATTEMPTS`):

- `GET /api/queue`: retorna o estado atual da fila (`status`, `paused`, `attempt`, `backoffMs`, `nextRetryAt`, `lastError` e progresso por empresa).
- `POST /api/queue/pause`: pausa a fila atual, cancela timers de retry pendentes e suspende disparos automáticos até retomada.
- `POST /api/queue/resume`: retoma a fila pausada e reinicia a sincronização.
- Na interface do painel, o botão **Fila** na barra superior exibe o estado em tempo real e permite inspecionar e pausar/retomar a fila.

## Meta diária

As metas diárias de GMV da operação para novembro de 2026 (`01/11/2026` a `30/11/2026`) ficam centralizadas em [`site/dist/daily-targets.js`](site/dist/daily-targets.js).

- A resolução da data usa sempre o fuso horário `America/Sao_Paulo`.
- O backend (`server.js`) expõe o campo `target` nos payloads de `/api/data` e `/api/update-data` com base em `dataDate`.
- O painel (`site/dist/app.js`) consome `target` da API e usa o mesmo módulo compartilhado no carregamento inicial ou na importação manual de CSV.
- Datas sem meta cadastrada retornam `null` e exibem o estado `Sem meta` no card **ATINGIMENTO DA META**.

## Testes

Com Node.js 20+ instalado:

```bash
npm test
```

Executa [`tests/daily-targets.test.js`](tests/daily-targets.test.js) e [`tests/fulfillment-queue.test.js`](tests/fulfillment-queue.test.js) via `node --test` (cobertura da tabela de metas de novembro/2026, regras de Fulfillment para `OFICIALSP`, `OFICIALSP2` e `Amazon FBA Classic`, Tabela Analítica, fila com retry exponencial e pausa/retomada).

## Implantação na VPS (Domínio: `bi-vendas.oficialwebshop.com.br`)

Para implantar na VPS sob o domínio `bi-vendas.oficialwebshop.com.br`:

1. **Apontamento de DNS:** Crie uma entrada de DNS do tipo **A** para o subdomínio `bi-vendas.oficialwebshop.com.br` apontando para o IP público da VPS.
2. **Clonar ou Enviar o Projeto:** Clone o repositório em `/var/www/faturamento-diario`.
3. **Variáveis de Ambiente:** Copie `.env.example` para `.env.local` (ou `.env`) e preencha com os tokens do Tiny (`TINY_OFICIAL_TOKEN`, `TINY_PRIORIZA_TOKEN`, `TINY_OFICIALSP_TOKEN` e `TINY_OFICIALSP2_TOKEN`).
4. **Instalação e PM2:**
   ```bash
   npm ci --omit=dev
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```
5. **Configurar Proxy Reverso Nginx & SSL:**
   Copie a configuração de [deploy/nginx/bi-vendas.oficialwebshop.com.br.conf](file:///c:/Users/Alain/Documents/GitHub/faturamento-diario/deploy/nginx/bi-vendas.oficialwebshop.com.br.conf) para `/etc/nginx/sites-available/bi-vendas.oficialwebshop.com.br`, crie o link simbólico em `/etc/nginx/sites-enabled/` e ative o certificado SSL via Certbot:
   ```bash
   sudo certbot --nginx -d bi-vendas.oficialwebshop.com.br
   ```

*(Alternativamente, utilize o script automatizado `bash deploy/setup-vps.sh` disponível no repositório).*
