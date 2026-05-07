#!/usr/bin/env bash
# validators.sh — spec + phases.yaml validation used by /ingest-spec, /decompose.
#
# Source: `source "${FORGE_DIR}/lib/validators.sh"`

set -euo pipefail

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
_log()  { printf '\033[1;34m[validate]\033[0m %s\n' "$*" >&2; }
_warn() { printf '\033[1;33m[validate]\033[0m %s\n' "$*" >&2; }
_err()  { printf '\033[1;31m[validate]\033[0m %s\n' "$*" >&2; }

# ──────────────────────────────────────────────
# validate_spec_section FILE SECTION_HEADER
# Verifies the file contains a non-empty section under the given header.
# Returns 0 if section exists with content, 1 otherwise.
# ──────────────────────────────────────────────
validate_spec_section() {
  local file="${1:?file required}"
  local header="${2:?header required}"

  if [[ ! -f "${file}" ]]; then
    _err "${file}: file does not exist"
    return 1
  fi

  # Find the section and check it contains content beyond the header
  awk -v hdr="## ${header}" '
    BEGIN { found=0; content=0 }
    $0 == hdr { found=1; next }
    found && /^## / { exit }
    found && /[^[:space:]]/ && !/^<!--/ { content=1 }
    END { exit (found && content) ? 0 : 1 }
  ' "${file}"

  local rc=$?
  if [[ ${rc} -ne 0 ]]; then
    _err "${file}: missing or empty section '${header}'"
  fi
  return ${rc}
}

# ──────────────────────────────────────────────
# validate_brief PATH
# Validates spec/BRIEF.md against required sections.
# ──────────────────────────────────────────────
validate_brief() {
  local file="${1:?path required}"
  local sections=(
    "The pain"
    "The user"
    "The unfair advantage"
    "The smallest valuable thing"
    "Non-goals"
    "North-star metric"
    "Kill criteria"
  )

  local failed=0
  local s
  for s in "${sections[@]}"; do
    validate_spec_section "${file}" "${s}" || failed=$((failed + 1))
  done

  if [[ ${failed} -eq 0 ]]; then
    _log "✓ BRIEF.md complete"
  fi
  return ${failed}
}

# ──────────────────────────────────────────────
# validate_prd PATH
# ──────────────────────────────────────────────
validate_prd() {
  local file="${1:?path required}"
  local sections=(
    "Problem"
    "Target user"
    "Acceptance Criteria (the MVP)"
    "Explicit non-goals"
    "Success metrics"
    "Constraints"
  )

  local failed=0
  local s
  for s in "${sections[@]}"; do
    validate_spec_section "${file}" "${s}" || failed=$((failed + 1))
  done

  if [[ ${failed} -eq 0 ]]; then
    _log "✓ PRD.md complete"
  fi
  return ${failed}
}

# ──────────────────────────────────────────────
# validate_spec PATH
# ──────────────────────────────────────────────
validate_spec() {
  local file="${1:?path required}"
  local sections=(
    "Stack"
    "Data model"
    "Key flows"
    "Security model"
    "Environment variables"
  )

  local failed=0
  local s
  for s in "${sections[@]}"; do
    validate_spec_section "${file}" "${s}" || failed=$((failed + 1))
  done

  if [[ ${failed} -eq 0 ]]; then
    _log "✓ SPEC.md complete"
  fi
  return ${failed}
}

# ──────────────────────────────────────────────
# validate_phases_yaml PATH
# Validates structure + DAG. Requires `yq`.
#
# Checks:
#   - top-level fields: project, phases
#   - each phase has id, name, goal, gate_criteria, tasks
#   - each task has id, title, type, priority, depends_on, estimate, owner_type, acceptance
#   - no XL estimates
#   - dependency graph is a DAG (no cycles)
# ──────────────────────────────────────────────
validate_phases_yaml() {
  local file="${1:?path required}"

  if [[ ! -f "${file}" ]]; then
    _err "${file}: does not exist"
    return 1
  fi

  if ! command -v yq >/dev/null 2>&1; then
    _err "yq required (https://github.com/mikefarah/yq)"
    return 1
  fi

  local failed=0

  # Top-level fields
  for field in project phases; do
    if [[ "$(yq ".${field}" "${file}")" == "null" ]]; then
      _err "missing top-level field: ${field}"
      failed=$((failed + 1))
    fi
  done

  # Phase fields
  local phase_count
  phase_count=$(yq '.phases | length' "${file}")
  local i
  for ((i = 0; i < phase_count; i++)); do
    for field in id name goal gate_criteria tasks; do
      if [[ "$(yq ".phases[${i}].${field}" "${file}")" == "null" ]]; then
        _err "phase ${i}: missing field '${field}'"
        failed=$((failed + 1))
      fi
    done
  done

  # Task fields + XL check + collect ids/deps for DAG check
  local all_ids=()
  local all_deps=()

  for ((i = 0; i < phase_count; i++)); do
    local task_count
    task_count=$(yq ".phases[${i}].tasks | length" "${file}")
    local j
    for ((j = 0; j < task_count; j++)); do
      local prefix=".phases[${i}].tasks[${j}]"

      for field in id title type priority depends_on estimate owner_type acceptance; do
        if [[ "$(yq "${prefix}.${field}" "${file}")" == "null" ]]; then
          _err "task ${prefix}: missing field '${field}'"
          failed=$((failed + 1))
        fi
      done

      local estimate
      estimate=$(yq "${prefix}.estimate" "${file}")
      if [[ "${estimate}" == "XL" ]]; then
        _err "task $(yq "${prefix}.id" "${file}"): XL estimates are not allowed — split it"
        failed=$((failed + 1))
      fi

      local task_id
      task_id=$(yq "${prefix}.id" "${file}")
      all_ids+=("${task_id}")

      local dep_count
      dep_count=$(yq "${prefix}.depends_on | length // 0" "${file}")
      local k
      for ((k = 0; k < dep_count; k++)); do
        local dep
        dep=$(yq "${prefix}.depends_on[${k}]" "${file}")
        all_deps+=("${task_id}:${dep}")
      done
    done
  done

  # DAG cycle check via Kahn's algorithm
  if [[ ${#all_deps[@]} -gt 0 ]]; then
    if ! _check_dag "${all_ids[@]}" "--" "${all_deps[@]}"; then
      _err "dependency graph contains a cycle"
      failed=$((failed + 1))
    fi
  fi

  if [[ ${failed} -eq 0 ]]; then
    _log "✓ phases.yaml valid (DAG, all required fields present, no XL)"
  fi
  return ${failed}
}

# ──────────────────────────────────────────────
# _check_dag NODES... -- EDGES (each as "from:to" meaning from depends on to)
# Returns 0 if DAG, 1 if cycle detected.
# ──────────────────────────────────────────────
_check_dag() {
  local sep=0
  local -a nodes=()
  local -a edges=()
  local arg
  for arg in "$@"; do
    if [[ "${arg}" == "--" ]]; then sep=1; continue; fi
    if [[ ${sep} -eq 0 ]]; then nodes+=("${arg}"); else edges+=("${arg}"); fi
  done

  # Use Python for the cycle check — simpler than pure bash for graphs.
  python3 - "${nodes[@]}" "${#nodes[@]}" "${edges[@]}" <<'PY'
import sys
from collections import defaultdict

argv = sys.argv[1:]
n = int(argv[len(argv) - 1 - len([a for a in argv if ':' in a])])
# Reconstruct: nodes are the first n args, then count, then edges.
# Simpler: split by ':' to find edges.
nodes = []
edges = []
i = 0
while i < len(argv):
    a = argv[i]
    if a.isdigit() and i + 1 < len(argv) and ':' in argv[i + 1]:
        i += 1
        while i < len(argv):
            edges.append(argv[i])
            i += 1
        break
    else:
        nodes.append(a)
        i += 1

graph = defaultdict(list)
in_degree = {n: 0 for n in nodes}
for e in edges:
    if ':' not in e: continue
    src, dst = e.split(':', 1)
    if src in in_degree and dst in in_degree:
        graph[dst].append(src)  # dependency: src depends on dst, so dst → src
        in_degree[src] += 1

queue = [n for n, d in in_degree.items() if d == 0]
visited = 0
while queue:
    node = queue.pop()
    visited += 1
    for nxt in graph[node]:
        in_degree[nxt] -= 1
        if in_degree[nxt] == 0:
            queue.append(nxt)

sys.exit(0 if visited == len(nodes) else 1)
PY
}
