#!/usr/bin/env bash
# Выкатка Ложи на свой сервер (Ubuntu/Debian с systemd и nginx):
#   DEPLOY_HOST=user@your-server ./deploy/deploy.sh
# Копирует код в /var/www/lozha и перезапускает сервис lozha. Данные (/var/lib/lozha) не трогает.
# Первичная настройка сервера — в README, раздел «Свой сервер».
set -euo pipefail

: "${DEPLOY_HOST:?Укажи сервер: DEPLOY_HOST=user@host ./deploy/deploy.sh}"
APP_DIR="${APP_DIR:-/var/www/lozha}"
cd "$(dirname "$0")/.."

rsync -az --delete \
  --exclude node_modules --exclude data --exclude bin --exclude .git --exclude .DS_Store \
  ./ "$DEPLOY_HOST:$APP_DIR/"

ssh "$DEPLOY_HOST" "
  set -e
  cd '$APP_DIR'
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent
  sudo systemctl restart lozha
  sleep 2
  systemctl is-active lozha
"
echo "Готово"
