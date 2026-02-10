#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

git pull

cd "$ROOT_DIR/server"

npm install
npx prisma db push --accept-data-loss
npx prisma generate
npm run build
if ! npm run webhook:set; then
  echo "WARNING: webhook:set failed. Continuing deploy."
fi

pm2 restart tg-mini-api --update-env

cd "$ROOT_DIR/tg-mini"

npm install
npm run build
