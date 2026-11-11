#!/usr/bin/env bash
# ==============================================================================
# Script de Backup dos Snapshots e Cache de Pedidos
# Pode ser agendado no crontab da VPS (ex: diariamente às 23:55)
# Exemplo cron: 55 23 * * * /bin/bash /var/www/faturamento-diario/deploy/backup-data.sh
# ==============================================================================

set -euo pipefail

BACKUP_DIR="/var/backups/bi-vendas"
DATE=$(date +%Y-%m-%d_%H%M%S)
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$BACKUP_DIR"

if [ -d "$APP_DIR/data" ]; then
    tar -czf "$BACKUP_DIR/data-backup-$DATE.tar.gz" -C "$APP_DIR" data/
    echo "Backup criado: $BACKUP_DIR/data-backup-$DATE.tar.gz"

    # Manter apenas os últimos 30 dias de backup
    find "$BACKUP_DIR" -type f -name "data-backup-*.tar.gz" -mtime +30 -delete
else
    echo "Diretório de dados $APP_DIR/data não encontrado."
fi

