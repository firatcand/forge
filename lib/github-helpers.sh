#!/usr/bin/env bash
# github-helpers.sh — gh CLI wrappers used by /setup-repo.
#
# Source this file: `source "${FORGE_DIR}/lib/github-helpers.sh"`

set -euo pipefail

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
_log()  { printf '\033[1;35m[gh]\033[0m %s\n' "$*" >&2; }
_warn() { printf '\033[1;33m[gh]\033[0m %s\n' "$*" >&2; }
_err()  { printf '\033[1;31m[gh]\033[0m %s\n' "$*" >&2; }

# ──────────────────────────────────────────────
# gh_check_auth
# Verifies that gh CLI is installed and authenticated.
# Returns 0 if ready, 1 otherwise.
# ──────────────────────────────────────────────
gh_check_auth() {
  if ! command -v gh >/dev/null 2>&1; then
    _err "gh CLI not installed. https://cli.github.com/"
    return 1
  fi

  if ! gh auth status >/dev/null 2>&1; then
    _err "gh CLI not authenticated. Run: gh auth login"
    return 1
  fi

  _log "gh CLI ready"
}

# ──────────────────────────────────────────────
# gh_create_repo NAME [PRIVACY=private]
# Creates a GitHub repo from current directory and sets origin remote.
# Skips creation if origin remote already configured.
# ──────────────────────────────────────────────
gh_create_repo() {
  local name="${1:?name required}"
  local privacy="${2:-private}"

  if git remote get-url origin >/dev/null 2>&1; then
    _warn "origin remote already configured: $(git remote get-url origin)"
    return 0
  fi

  _log "Creating repo: ${name} (${privacy})"
  gh repo create "${name}" "--${privacy}" --source=. --remote=origin
}

# ──────────────────────────────────────────────
# gh_protect_branch BRANCH [REQUIRE_REVIEWS=1] [REQUIRE_CHECKS_CSV=test]
# Sets branch protection: require PR review, require status checks, no
# direct pushes, no force pushes.
# ──────────────────────────────────────────────
gh_protect_branch() {
  local branch="${1:?branch required}"
  local require_reviews="${2:-1}"
  local require_checks="${3:-test}"

  local repo
  repo=$(gh repo view --json nameWithOwner -q '.nameWithOwner')

  _log "Protecting ${repo}:${branch}"

  local checks_json
  checks_json=$(printf '%s\n' "${require_checks}" | tr ',' '\n' | jq -R . | jq -sc '{strict: true, contexts: .}')

  local payload
  payload=$(jq -n \
    --argjson reviews "${require_reviews}" \
    --argjson checks "${checks_json}" \
    '{required_status_checks: $checks,
      enforce_admins: true,
      required_pull_request_reviews: {required_approving_review_count: $reviews},
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false}')

  gh api -X PUT \
    "repos/${repo}/branches/${branch}/protection" \
    -H "Accept: application/vnd.github+json" \
    --input - <<<"${payload}" >/dev/null

  _log "✓ ${branch} protected"
}

# ──────────────────────────────────────────────
# gh_create_environment NAME [REQUIRE_APPROVAL=false]
# Creates a GitHub Environment. Set REQUIRE_APPROVAL=true to gate deploys.
# ──────────────────────────────────────────────
gh_create_environment() {
  local name="${1:?name required}"
  local require_approval="${2:-false}"

  local repo
  repo=$(gh repo view --json nameWithOwner -q '.nameWithOwner')

  _log "Creating environment: ${name}"

  local reviewers='[]'
  if [[ "${require_approval}" == "true" ]]; then
    local user_id
    user_id=$(gh api user -q '.id')
    reviewers=$(jq -nc --argjson id "${user_id}" '[{type: "User", id: $id}]')
  fi

  local payload
  payload=$(jq -n --argjson reviewers "${reviewers}" \
    '{wait_timer: 0, reviewers: $reviewers, deployment_branch_policy: null}')

  gh api -X PUT \
    "repos/${repo}/environments/${name}" \
    -H "Accept: application/vnd.github+json" \
    --input - <<<"${payload}" >/dev/null

  _log "✓ environment ${name} (approval: ${require_approval})"
}

# ──────────────────────────────────────────────
# gh_set_secret KEY VALUE
# Sets a repo-level GitHub Actions secret. Reads VALUE from arg or stdin.
# ──────────────────────────────────────────────
gh_set_secret() {
  local key="${1:?key required}"
  local value="${2:-}"

  if [[ -z "${value}" ]]; then
    if [[ -t 0 ]]; then
      _err "VALUE not provided (arg or stdin)"
      return 1
    fi
    value=$(cat)
  fi

  printf '%s' "${value}" | gh secret set "${key}"
  _log "✓ secret ${key} set"
}

# ──────────────────────────────────────────────
# gh_set_oauth_token VALUE
# Convenience: sets CLAUDE_CODE_OAUTH_TOKEN as a repo secret.
# ──────────────────────────────────────────────
gh_set_oauth_token() {
  local token="${1:?token required}"
  gh_set_secret CLAUDE_CODE_OAUTH_TOKEN "${token}"
}
