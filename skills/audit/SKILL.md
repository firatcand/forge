---
name: audit
description: Fan out N read-only subagents to audit the codebase for safe simplification (dead code, duplication, over-exports, complexity, dependency bloat, stale docs), then assemble a filtered work-order of findings. READ-ONLY — never edits source. The work-order is the deliverable.
tools: Bash(*), Read, Write, Task
---

# /audit

> READ-ONLY. This skill produces a **work-order** of audit findings — it NEVER
> edits, creates, or deletes source. The only file it writes is the work-order
> under `.forge/audits/<ts>/`. No self-loop.

The user-facing audit driver. One invocation = one audit pass:

1. `audit plan` (read-only) → parse the per-(scope × dimension) prompts.
2. Fan out one **read-only** Task subagent per prompt; each returns findings JSON.
3. Assemble all findings → `audit collect` → filtered, validated work-order.
4. Present the work-order (counts + path) and the read-only guarantee.
5. Offer the next step (NOT built here): turning approved findings into issues.

## Preconditions

- A git repo (scope auto-discovery ranks tracked dirs; a non-git repo falls back
  to scope `["**"]` with a warning).
- `.forge/settings.yaml` is OPTIONAL — when absent, audit uses defaults and warns
  (no preflight globs, verify unconfigured). Scope/protected come from config +
  auto-discovery; you never hardcode paths.

## Step 1 — Plan the audit (read-only, writes nothing)

```bash
forge orchestrate audit plan --json
```

Parse `data`:
- `prompts[]` — each `{ scope, dimension, prompt }`. The `prompt` is a complete,
  self-contained read-only audit instruction (it already embeds the scope glob,
  the dimension focus, the protected globs to avoid, the finding schema, the
  6-way classification rubric, the per-agent cap, and the read-only mandate).
- `scope`, `dimensions`, `protected_globs` — the resolved sets.
- `verify_configured` — when `false`, surface the warning: findings are
  UNVERIFIABLE without a `verify:` gate; the audit must be paired with one.
- `warnings[]` — scope-fallback / settings-absent notices to relay.

Optional overrides: `--scope a/**,b/**` and `--dimensions dead-code,duplication`.

If `prompts.length === 0`, print "No audit scope discoverable." and exit 0.

## Step 2 — Fan out one read-only subagent per prompt

For each `prompts[i]`, spawn a Task subagent:

- `prompt`: `prompts[i].prompt` verbatim (do NOT rewrite it — it carries the
  guardrails and the read-only mandate).
- `subagent_type`: a read-capable general subagent (e.g. `general-purpose`).
- Make explicit in the dispatch that the subagent MUST NOT edit any file and
  MUST return ONLY a JSON array of findings.

Each subagent returns a JSON array of findings. Collect them all. A subagent that
returns nothing or malformed output is not fatal — `collect` validates and drops
bad findings individually; just append whatever valid JSON arrays you got.

**Suggest-don't-force / no self-loop.** One pass per invocation. The skill does
not re-spawn itself or loop on its own findings.

## Step 3 — Assemble + collect (writes ONLY the work-order)

Write the merged findings array to a temp file, then:

```bash
forge orchestrate audit collect --findings-file "${TMP_FINDINGS}" --json
```

`collect` enforces, IN CODE, that every kept finding is repo-relative, in-scope,
and not protected — it DROPS (with reasons) any absolute path, `../` traversal,
symlink escape, out-of-scope, or protected-glob match, and any finding that fails
schema validation. It writes ONLY `.forge/audits/<ts>/work-order.{json,md}` and
guards that directory against a symlinked-parent escape first.

Parse `data`:
- `work_order_path` — the JSON work-order path.
- `summary` — per-classification counts.
- `dropped` — `{ count, reasons }` for the filtered-out findings.
- `verify_configured`, `warnings[]`.

## Step 4 — Present the work-order

Show the user:
- The per-classification summary (delete-safe / de-export-safe / simplify-safe /
  needs-tests-first / risky / do-not-touch counts).
- How many findings were dropped and why (the filter is the read-only/scope
  safety net).
- The work-order path (`work-order.md` is the human-readable sibling).
- The read-only guarantee: no source was touched; the work-order is the only
  artifact written.
- If `verify_configured` is false: the unverifiable-findings warning.

## Step 5 — Offer to file issues (FORGE-180)

The audit produces a work-order, not changes. After the human reviews it, OFFER
(do NOT auto-run) to file one tracker issue per finding:

```bash
forge orchestrate audit create-issues --work-order <path-to-work-order.json> --json
```

This verb is **RENDER-ONLY** — it mutates nothing. It reads the configured
`tracker.type` and emits one issue SPEC per finding:
`{ title, body, labels: ['audit', '<classification>'], finding_ref }` (and an
`umbrella_spec` if `--umbrella <title>` is given). It refuses with
`NO_TRACKER_CONFIGURED` when no tracker is configured.

**The skill files the specs out-of-band** (this is why classification→label is
applied here, not in a payload — audit issues are NOT forge roadmap tasks, so
they must NOT go through `createIssue`/`forgeTaskId`, which `reconcile`/`gc`
would treat as managed tasks). For each spec, file an issue via the host tool for
`tracker_type`, applying every label:

- **github** → `gh issue create --title <title> --body <body> --label audit --label <classification>` (create the label first if missing).
- **linear** → Linear MCP create-issue + attach the labels.
- **notion** → Notion MCP create-page + set the classification as a property.

If `--umbrella` was used, file the umbrella spec first and (optionally) reference
it from each child. **Filing is NOT idempotent** — render + file once per
work-order; re-running files duplicates.

## What the skill must NOT do

- Never edit, create, move, or delete source files. The work-order is the only
  output.
- Never bypass `audit collect` to write findings directly — the filter is
  code-enforced for a reason (scope + protected + traversal safety).
- Never loop on its own findings or auto-apply anything.

## Exit codes

- `0` — audit pass complete (work-order written, or no scope discoverable).
- `1` — preconditions / verb failure (e.g. findings file unreadable).
