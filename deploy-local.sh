#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [ -n "$(git status --porcelain)" ]; then
  git add .
  MSG=${1:-"deploy: update $(date +%F-%H%M)"}
  git commit -m "$MSG"
else
  echo "No changes to commit."
fi

git push
