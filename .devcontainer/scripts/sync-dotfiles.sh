#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
DOTFILES_ROOT="${REPO_ROOT}/.devcontainer/dotfiles"
DOTFILES_PACKAGE="vscode"
PACKAGE_ROOT="${DOTFILES_ROOT}/${DOTFILES_PACKAGE}"
BACKUP_ROOT="${HOME}/.codex/backup"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"

STOW_MANAGED_PATHS=(
  ".codex/config.toml"
  ".codex/rules"
)

log() {
  echo "sync-dotfiles: $*"
}

fail() {
  echo "sync-dotfiles: $*" >&2
  exit 1
}

backup_existing_path() {
  local relative_path="$1"
  local target_path="${HOME}/${relative_path}"
  local backup_relative="${relative_path#.codex/}"
  local backup_path="${BACKUP_ROOT}/${backup_relative}.${TIMESTAMP}.bak"

  if [[ ! -e "${target_path}" && ! -L "${target_path}" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "${backup_path}")"
  mv "${target_path}" "${backup_path}"
  log "Backed up ${target_path} -> ${backup_path}"
}

is_expected_symlink() {
  local target_path="$1"
  local expected_path="$2"
  local actual_resolved
  local expected_resolved

  [[ -L "${target_path}" ]] || return 1

  actual_resolved="$(readlink -f "${target_path}" 2>/dev/null || true)"
  expected_resolved="$(readlink -f "${expected_path}" 2>/dev/null || true)"

  [[ -n "${actual_resolved}" && -n "${expected_resolved}" && "${actual_resolved}" == "${expected_resolved}" ]]
}

backup_stow_conflict() {
  local relative_path="$1"
  local target_path="${HOME}/${relative_path}"
  local expected_path="${PACKAGE_ROOT}/${relative_path}"

  if [[ ! -e "${target_path}" && ! -L "${target_path}" ]]; then
    return 0
  fi

  if is_expected_symlink "${target_path}" "${expected_path}"; then
    return 0
  fi

  backup_existing_path "${relative_path}"
}

verify_symlink() {
  local relative_path="$1"
  local target_path="${HOME}/${relative_path}"
  local expected_path="${PACKAGE_ROOT}/${relative_path}"

  if ! is_expected_symlink "${target_path}" "${expected_path}"; then
    fail "Expected ${target_path} to symlink to ${expected_path}"
  fi
}

main() {
  command -v stow >/dev/null 2>&1 || fail "GNU Stow is required but not installed."
  [[ -d "${PACKAGE_ROOT}" ]] || fail "Missing dotfiles package directory: ${PACKAGE_ROOT}"

  for relative_path in "${STOW_MANAGED_PATHS[@]}"; do
    [[ -e "${PACKAGE_ROOT}/${relative_path}" || -L "${PACKAGE_ROOT}/${relative_path}" ]] || fail "Managed source is missing: ${PACKAGE_ROOT}/${relative_path}"
  done

  mkdir -p "${HOME}/.codex" "${BACKUP_ROOT}"

  for relative_path in "${STOW_MANAGED_PATHS[@]}"; do
    backup_stow_conflict "${relative_path}"
  done

  stow --restow --target="${HOME}" --dir "${DOTFILES_ROOT}" "${DOTFILES_PACKAGE}"

  for relative_path in "${STOW_MANAGED_PATHS[@]}"; do
    verify_symlink "${relative_path}"
  done

  log "Dotfiles are synced."
}

main "$@"
