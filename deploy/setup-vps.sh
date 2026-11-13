#!/usr/bin/env bash
# ==============================================================================
# Script de Implantação e Configuração Automatizada - bi-vendas.oficialwebshop.com.br
# Executar como root ou com sudo na VPS (Ubuntu/Debian)
# ==============================================================================

set -euo pipefail

DOMAIN="bi-vendas.oficialwebshop.com.br"
APP_DIR="/var/www/faturamento-diario"
NGINX_AVAILABLE="/etc/nginx/sites-available/$DOMAIN"
NGINX_ENABLED="/etc/nginx/sites-enabled/$DOMAIN"

echo "=== [1/6] Atualizando pacotes do sistema e dependências ==="
apt-get update -y
apt-get install -y curl git ufw nginx certbot python3-certbot-nginx

# Instalar Node.js 20 LTS se não existir
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
    echo "Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Instalar PM2 globalmente
if ! command -v pm2 >/dev/null 2>&1; then
    echo "Instalando PM2..."
    npm install -g pm2
fi

echo "=== [2/6] Preparando diretório da aplicação em $APP_DIR ==="
mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/logs"

# Se o repositório estiver sendo implantado aqui, certifique-se das permissões
chown -R "$USER:$USER" "$APP_DIR" || true

cd "$APP_DIR"

if [ -f "package.json" ]; then
    echo "Instalando dependências do projeto..."
    npm ci --omit=dev
fi

# Alerta sobre variáveis de ambiente
if [ ! -f ".env.local" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env.local
        echo "AVISO: Arquivo .env.local criado a partir de .env.example. EDITE-O COM SEUS TOKENS REAIS!"
    else
        touch .env.local
        echo "TINY_OFICIAL_TOKEN=" >> .env.local
        echo "TINY_PRIORIZA_TOKEN=" >> .env.local
        echo "TINY_OFICIALSP_TOKEN=" >> .env.local
        echo "TINY_OFICIALSP2_TOKEN=" >> .env.local
    fi
fi

echo "=== [3/6] Configurando PM2 ==="
if [ -f "ecosystem.config.cjs" ]; then
    pm2 start ecosystem.config.cjs
    pm2 save
    env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" || true
else
    echo "Iniciando processo direto via PM2..."
    pm2 start server.js --name "bi-vendas"
    pm2 save
fi

echo "=== [4/6] Configurando Firewall UFW ==="
ufw allow 'Nginx Full' || true
ufw allow OpenSSH || true
ufw --force enable || true

echo "=== [5/6] Configurando VirtualHost Nginx ==="
if [ -f "$APP_DIR/deploy/nginx/bi-vendas.oficialwebshop.com.br.conf" ]; then
    cp "$APP_DIR/deploy/nginx/bi-vendas.oficialwebshop.com.br.conf" "$NGINX_AVAILABLE"
else
    cat << 'EOF' > "$NGINX_AVAILABLE"
server {
    listen 80;
    listen [::]:80;
    server_name bi-vendas.oficialwebshop.com.br;

    access_log /var/log/nginx/bi-vendas.access.log;
    error_log /var/log/nginx/bi-vendas.error.log;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_send_timeout 180s;
        proxy_read_timeout 180s;
        send_timeout 180s;
        proxy_buffering off;
    }
}
EOF
fi

ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
nginx -t && systemctl reload nginx

echo "=== [6/6] Emitindo Certificado SSL com Certbot ==="
echo "Certifique-se de que o DNS bi-vendas.oficialwebshop.com.br já aponta para o IP desta VPS."
read -p "Deseja emitir o certificado SSL Let's Encrypt agora? (s/n): " RUN_SSL
if [ "$RUN_SSL" = "s" ] || [ "$RUN_SSL" = "S" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m admin@oficialwebshop.com.br
    systemctl reload nginx
    echo "SSL configurado com sucesso!"
fi

echo "=========================================================="
echo " Implantação concluída com sucesso!"
echo " URL: https://$DOMAIN"
echo " Status da aplicação: pm2 status"
echo " Logs em tempo real:  pm2 logs bi-vendas"
echo "=========================================================="

