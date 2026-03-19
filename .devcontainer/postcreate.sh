#!/usr/bin/env bash
set -euo pipefail

ensure_owned_dir() {
  local dir="$1"
  sudo mkdir -p "$dir"
  sudo chown -R vscode:vscode "$dir"
}

ensure_owned_dir /home/vscode/.codex
ensure_owned_dir /home/vscode/.codex/rules
ensure_owned_dir /home/vscode/.config/gh
ensure_owned_dir /home/vscode/.local/share/pnpm

export PNPM_HOME="${PNPM_HOME:-/home/vscode/.local/share/pnpm}"
export PATH="${PNPM_HOME}:${PATH}"
export CI="${CI:-1}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

PNPM_PACKAGE_MANAGER="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).packageManager")"

mkdir -p "${PNPM_HOME}"
corepack enable
corepack install --global "${PNPM_PACKAGE_MANAGER}"
pnpm config set global-bin-dir "${PNPM_HOME}"
pnpm config set update-notifier false
pnpm install --force --reporter=append-only
pnpm add -g @openai/codex docpup@0.1.9
.devcontainer/scripts/sync-dotfiles.sh

echo ""
echo "skillpup devcontainer is ready."
echo "Run 'just skills' to fetch the repo support skills."
echo "Run 'just docs' to refresh the local doc indices."
