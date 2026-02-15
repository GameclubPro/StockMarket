#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

SKIP_PUSH="${SKIP_PUSH:-0}"

if [ -n "$(git status --porcelain)" ]; then
  git add .
  MSG=${1:-"deploy: update $(date +%F-%H%M)"}
  git commit -m "$MSG"
else
  echo "No changes to commit."
fi

if [ "$SKIP_PUSH" = "1" ]; then
  echo "Skip push: SKIP_PUSH=1"
  exit 0
fi

if ! getent hosts github.com >/dev/null 2>&1; then
  echo "DNS error: cannot resolve github.com"
  echo "Check internet/DNS and try again, or run: SKIP_PUSH=1 ./deploy-local.sh"
  exit 1
fi

git push
