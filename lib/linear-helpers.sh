#!/usr/bin/env bash
# linear-helpers.sh — Linear MCP wrappers used by /push-to-linear, /sync-status.
#
# These functions assume the Linear MCP server is configured for Claude Code
# and that tool calls happen through the agent. Bash callers (e.g. setup
# scripts) can use the JSON-printing variants which read API_KEY from
# $LINEAR_API_KEY as a fallback.
#
# Source this file: `source "${FORGE_DIR}/lib/linear-helpers.sh"`

set -euo pipefail

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
_log()  { printf '\033[1;36m[linear]\033[0m %s\n' "$*" >&2; }
_warn() { printf '\033[1;33m[linear]\033[0m %s\n' "$*" >&2; }
_err()  { printf '\033[1;31m[linear]\033[0m %s\n' "$*" >&2; }

# ──────────────────────────────────────────────
# linear_check_mcp
# Verifies that the Linear MCP server is registered with Claude Code.
# Returns 0 if available, 1 otherwise.
# ──────────────────────────────────────────────
linear_check_mcp() {
  if ! command -v claude >/dev/null 2>&1; then
    _err "claude CLI not found on PATH"
    return 1
  fi

  if ! claude mcp list 2>/dev/null | grep -qi 'linear'; then
    _warn "Linear MCP server not registered. Run: claude mcp add linear ..."
    return 1
  fi

  _log "Linear MCP server registered"
  return 0
}

# ──────────────────────────────────────────────
# linear_api_call ENDPOINT_PATH METHOD [BODY_JSON]
# Low-level wrapper for direct Linear API access (fallback when MCP isn't
# configured). Requires LINEAR_API_KEY in env.
# ──────────────────────────────────────────────
linear_api_call() {
  local endpoint="${1:?endpoint required}"
  local method="${2:-GET}"
  local body="${3:-}"

  if [[ -z "${LINEAR_API_KEY:-}" ]]; then
    _err "LINEAR_API_KEY not set"
    return 1
  fi

  local args=(-sS -X "${method}" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    -H "Content-Type: application/json" \
    "https://api.linear.app${endpoint}")

  if [[ -n "${body}" ]]; then
    args+=(-d "${body}")
  fi

  curl "${args[@]}"
}

# ──────────────────────────────────────────────
# linear_create_project NAME [DESCRIPTION]
# Echoes the new project's id to stdout.
# ──────────────────────────────────────────────
linear_create_project() {
  local name="${1:?name required}"
  local description="${2:-}"

  local payload
  payload=$(jq -n --arg name "${name}" --arg description "${description}" \
    '{query: "mutation($name: String!, $description: String!) { projectCreate(input: {name: $name, description: $description}) { project { id name } } }",
      variables: {name: $name, description: $description}}')

  linear_api_call /graphql POST "${payload}" | jq -r '.data.projectCreate.project.id'
}

# ──────────────────────────────────────────────
# linear_create_cycle TEAM_ID NAME [STARTS_AT] [ENDS_AT]
# Echoes the new cycle's id.
# ──────────────────────────────────────────────
linear_create_cycle() {
  local team_id="${1:?team_id required}"
  local name="${2:?name required}"
  local starts_at="${3:-}"
  local ends_at="${4:-}"

  local payload
  payload=$(jq -n \
    --arg team "${team_id}" \
    --arg name "${name}" \
    --arg startsAt "${starts_at}" \
    --arg endsAt "${ends_at}" \
    '{query: "mutation($input: CycleCreateInput!) { cycleCreate(input: $input) { cycle { id name } } }",
      variables: {input: {teamId: $team, name: $name, startsAt: $startsAt, endsAt: $endsAt}}}')

  linear_api_call /graphql POST "${payload}" | jq -r '.data.cycleCreate.cycle.id'
}

# ──────────────────────────────────────────────
# linear_create_issue PROJECT_ID TITLE BODY PRIORITY ESTIMATE [CYCLE_ID]
# Priority: 1 (urgent), 2 (high), 3 (medium), 4 (low)
# Estimate: numeric (e.g. 1=S, 3=M, 5=L)
# Echoes the new issue's id.
# ──────────────────────────────────────────────
linear_create_issue() {
  local project_id="${1:?project_id required}"
  local title="${2:?title required}"
  local body="${3:-}"
  local priority="${4:-3}"
  local estimate="${5:-3}"
  local cycle_id="${6:-}"

  local payload
  payload=$(jq -n \
    --arg project "${project_id}" \
    --arg title "${title}" \
    --arg body "${body}" \
    --argjson priority "${priority}" \
    --argjson estimate "${estimate}" \
    --arg cycle "${cycle_id}" \
    '{query: "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }",
      variables: {input: {projectId: $project, title: $title, description: $body, priority: $priority, estimate: $estimate, cycleId: ($cycle | select(. != ""))}}}')

  linear_api_call /graphql POST "${payload}" | jq -r '.data.issueCreate.issue.id'
}

# ──────────────────────────────────────────────
# linear_set_blocks ISSUE_ID BLOCKER_IDS...
# Sets "blocked by" relations from BLOCKER_IDS to ISSUE_ID.
# ──────────────────────────────────────────────
linear_set_blocks() {
  local issue_id="${1:?issue_id required}"
  shift

  local blocker
  for blocker in "$@"; do
    local payload
    payload=$(jq -n \
      --arg issue "${issue_id}" \
      --arg blocker "${blocker}" \
      '{query: "mutation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: {issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks}) { success } }",
        variables: {issueId: $blocker, relatedIssueId: $issue}}')

    linear_api_call /graphql POST "${payload}" >/dev/null
  done
}

# ──────────────────────────────────────────────
# linear_get_issue_status ISSUE_ID
# Echoes the current status name (e.g. "Todo", "In Progress").
# ──────────────────────────────────────────────
linear_get_issue_status() {
  local issue_id="${1:?issue_id required}"

  local payload
  payload=$(jq -n --arg id "${issue_id}" \
    '{query: "query($id: String!) { issue(id: $id) { state { name } } }", variables: {id: $id}}')

  linear_api_call /graphql POST "${payload}" | jq -r '.data.issue.state.name'
}

# ──────────────────────────────────────────────
# linear_link_github PROJECT_ID GITHUB_REPO_SLUG
# Connects a Linear project to a GitHub repo for native sync.
# Note: Linear's GraphQL API for this is limited. In practice this is
# configured via the Linear UI; this function prints a manual instruction.
# ──────────────────────────────────────────────
linear_link_github() {
  local project_id="${1:?project_id required}"
  local repo="${2:?repo (owner/name) required}"

  cat <<EOF >&2
[linear] Manual step required:
  1. Open Linear → Settings → Integrations → GitHub
  2. Connect repo: ${repo}
  3. Map to project: ${project_id}
  4. Enable: branch-name auto-link, PR-status sync

Once linked, branches like 'feat/{ID}-slug' auto-attach to the issue,
and PRs move issues through Todo → In Progress → In Review → Done.
EOF
}
