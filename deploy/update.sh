#!/usr/bin/env bash
# ==============================================================================
# Script de Atualização Contínua (Deploy Rápido) na VPS
# Execução: bash deploy/update.sh
# ==============================================================================

set -euo pipefail

echo "==> [1/4] Puxando atualizações do Git..."
git pull origin main

echo "==> [2/4] Verificando e instalando dependências..."
npm ci --omit=dev

echo "==> [3/4] Recarregando o processo no PM2..."
pm2 reload bi-vendas || pm2 restart ecosystem.config.cjs

echo "==> [4/4] Verificando status..."
pm2 status bi-vendas

echo "--------------------------------------------------------"
echo " Deploy concluído com sucesso!"
echo " Acompanhe os logs com: pm2 logs bi-vendas --lines 30"
echo "--------------------------------------------------------"

