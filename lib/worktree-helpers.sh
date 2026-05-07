#!/usr/bin/env bash
# worktree-helpers.sh — git worktree wrappers used by /pickup-task.
#
# Layout:
#   ~/repos/{project}/                      ← main checkout (dev branch)
#   ~/repos/{project}-worktrees/{TICKET}/   ← per-task worktrees
#
# Source this file: `source "${FORGE_DIR}/lib/worktree-helpers.sh"`

set -euo pipefail

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
_log()  { printf '\033[1;32m[worktree]\033[0m %s\n' "$*" >&2; }
_warn() { printf '\033[1;33m[worktree]\033[0m %s\n' "$*" >&2; }
_err()  { printf '\033[1;31m[worktree]\033[0m %s\n' "$*" >&2; }

# ──────────────────────────────────────────────
# worktree_path PROJECT TICKET_ID
# Echoes the canonical worktree path for a ticket.
# ──────────────────────────────────────────────
worktree_path() {
  local project="${1:?project required}"
  local ticket="${2:?ticket required}"
  echo "../${project}-worktrees/${ticket}"
}

# ──────────────────────────────────────────────
# worktree_create TICKET_ID BRANCH [BASE_BRANCH=dev]
# Creates a new worktree at ../${project}-worktrees/${TICKET_ID} on
# branch BRANCH, branched from BASE_BRANCH. Idempotent.
# ──────────────────────────────────────────────
worktree_create() {
  local ticket="${1:?ticket required}"
  local branch="${2:?branch required}"
  local base="${3:-dev}"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    _err "not inside a git repo"
    return 1
  fi

  local project
  project=$(basename "$(git rev-parse --show-toplevel)")
  local target
  target=$(worktree_path "${project}" "${ticket}")

  if [[ -d "${target}" ]]; then
    _warn "worktree already exists at ${target}"
    return 0
  fi

  # Ensure base branch exists locally
  if ! git rev-parse --verify "${base}" >/dev/null 2>&1; then
    _err "base branch '${base}' does not exist locally"
    return 1
  fi

  _log "Creating worktree: ${target} (branch ${branch} from ${base})"
  git worktree add "${target}" -b "${branch}" "${base}"
  _log "✓ worktree ready: cd ${target}"
}

# ──────────────────────────────────────────────
# worktree_list
# Lists all worktrees with their branch and HEAD.
# ──────────────────────────────────────────────
worktree_list() {
  git worktree list --porcelain | awk '
    /^worktree / {wt=$2}
    /^branch / {br=$2}
    /^HEAD / {hd=substr($2, 1, 8)}
    /^$/ {if (wt) printf "  %-40s  %-30s  %s\n", wt, br, hd; wt=""; br=""; hd=""}
    END {if (wt) printf "  %-40s  %-30s  %s\n", wt, br, hd}
  '
}

# ──────────────────────────────────────────────
# worktree_remove TICKET_ID
# Removes the worktree for a ticket. Refuses if uncommitted changes exist.
# ──────────────────────────────────────────────
worktree_remove() {
  local ticket="${1:?ticket required}"

  local project
  project=$(basename "$(git rev-parse --show-toplevel)")
  local target
  target=$(worktree_path "${project}" "${ticket}")

  if [[ ! -d "${target}" ]]; then
    _warn "worktree does not exist: ${target}"
    return 0
  fi

  _log "Removing worktree: ${target}"
  git worktree remove "${target}"
  _log "✓ removed"
}

# ──────────────────────────────────────────────
# worktree_cleanup
# Removes worktrees whose branch has been deleted upstream or merged.
# Dry-run by default; pass --apply to actually remove.
# ──────────────────────────────────────────────
worktree_cleanup() {
  local apply="${1:-}"

  git worktree prune

  local removed=0
  while IFS= read -r line; do
    local wt branch
    wt=$(echo "${line}" | awk '{print $1}')
    branch=$(echo "${line}" | sed -n 's/.*\[\(.*\)\].*/\1/p')

    [[ -z "${branch}" ]] && continue
    [[ "${wt}" == "$(git rev-parse --show-toplevel)" ]] && continue

    # If branch is gone upstream
    if ! git ls-remote --exit-code --heads origin "${branch}" >/dev/null 2>&1; then
      if [[ "${apply}" == "--apply" ]]; then
        _log "Removing ${wt} (branch ${branch} gone upstream)"
        git worktree remove "${wt}" --force
        git branch -D "${branch}" 2>/dev/null || true
      else
        _warn "[dry-run] would remove: ${wt} (branch ${branch} gone)"
      fi
      removed=$((removed + 1))
    fi
  done < <(git worktree list)

  if [[ "${apply}" != "--apply" && ${removed} -gt 0 ]]; then
    echo "Run with --apply to actually remove" >&2
  fi
}
