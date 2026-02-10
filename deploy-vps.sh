#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# Build artifacts can change locally after previous deploy steps.
# Revert only known generated files to avoid pull conflicts.
git restore --worktree tg-mini/tsconfig.app.tsbuildinfo tg-mini/tsconfig.node.tsbuildinfo >/dev/null 2>&1 || true

git pull --ff-only

cd "$ROOT_DIR/server"

npm install
npx prisma migrate deploy
npx prisma generate
npm run build
if ! npm run webhook:set; then
  echo "WARNING: webhook:set failed. Continuing deploy."
fi

pm2 restart tg-mini-api --update-env

cd "$ROOT_DIR/tg-mini"

npm install
npm run build
