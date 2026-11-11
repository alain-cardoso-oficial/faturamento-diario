# Black Friday Oficial 2026 — Hora a Hora

Dashboard conectado diretamente às APIs de pedidos do Tiny das operações Oficial e Prioriza.

## Como iniciar

Clique duas vezes em `iniciar-dashboard.cmd` ou execute `npm start`.

O servidor pesquisa somente os pedidos do dia nos dois ambientes, consulta o detalhe de cada pedido, exclui cancelados, normaliza o canal e registra um snapshot acumulado a cada meia hora. O gráfico calcula o movimento de cada janela pela diferença entre snapshots.

Os tokens ficam apenas em `.env.local`, ignorado pelo Git. O histórico local fica em `data/hourly-snapshots.json` e também é ignorado.

O botão **Atualizar dados** força uma leitura imediata. O servidor atualiza automaticamente nos minutos `00` e `30`, enquanto o front consulta o resultado local a cada minuto.

## Implantação na VPS (Domínio: `bi-vendas.oficialwebshop.com.br`)

Para implantar na VPS sob o domínio `bi-vendas.oficialwebshop.com.br`:

1. **Apontamento de DNS:** Crie uma entrada de DNS do tipo **A** para o subdomínio `bi-vendas.oficialwebshop.com.br` apontando para o IP público da VPS.
2. **Clonar ou Enviar o Projeto:** Clone o repositório em `/var/www/faturamento-diario`.
3. **Variáveis de Ambiente:** Copie `.env.example` para `.env.local` e preencha com os tokens do Tiny (`TINY_OFICIAL_TOKEN` e `TINY_PRIORIZA_TOKEN`).
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
