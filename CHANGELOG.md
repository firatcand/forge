# Changelog

All notable changes to forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and forge adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`forge orchestrate` v2 CLI verb suite** (FORGE-96 / P2.5-T05) — replaces the v0.2.x flat surface with the read-only / mutating split per spec/ORCHESTRATOR.md §CLI surface (rewritten 2026-05-17):
  - **Read-only** (no lease, no tracker mutation): `phases [--ready --phase implement|review|ship --blocked-by --limit]`, `status`, `questions`, `doctor [--scope spec-code]`, `attach`, `spec-diff`, `run list [--active]`.
  - **User-approved mutating**: `claim`, `dispatch`, `heartbeat`, `question` (worker writer; accepts `--decision-key`, `--question`, `--options-file`, optional `--drift-event-id`, `--routing-hint apply-decision|amend-roadmap`), `answer`, `event` (worker; `--type drift --data <json>`), `complete`, `cancel`, `gc`, `run start`.
  - Every verb returns a stable JSON envelope on `--json`: `{ ok, data? | error: { code, message, retriable, details? } }`.
  - Verb-table dispatcher (`Map<string, VerbHandler | Map<string, VerbHandler>>`) so `run start | list` routes correctly; `--help` walks the registry so the read/mutate classification table cannot drift from the implementation (guarded by a unit test).
  - Centralized zod arg schemas at `src/schemas/cli-args.ts` (one per verb plus shared primitives: `TaskIdSchema`, UUIDv7 schemas for run/claim/attempt/question, `DecisionKeySchema`, `PhaseSchema`, `RoutingHintSchema`).
  - All 6 pre-existing verb files migrated from flat `src/cli/orchestrate-*.ts` into `src/cli/orchestrate/{verb}.ts` via `git mv` so blame follows.
- **`src/orchestrator/overlap.ts`** (FORGE-79 / P2-T19, absorbed into FORGE-96) — pure file-glob overlap classifier consumed by `phases --ready` to tag candidates as `no-overlap`/`soft-overlap`/`hard-overlap` against the active-attempts set. Tasks without declared `write_globs` default to worst-case-assume-overlap-on-hard-lock-only. `DEFAULT_HARD_LOCK_GLOBS` matches the spec list (`package.json`, lockfiles, `tsconfig.json`, `plans/phases.yaml`, `src/index.ts`, `migrations/**`, `prisma/schema.prisma`).
- **`TaskSchema.status` + `TaskSchema.write_globs`** — optional fields on phases.yaml task entries (`TASK_STATUSES = active|paused|done|deferred-v0.5|dropped`) so the loader stops silently dropping production data and so the overlap library can read declared globs from the task graph.
- **3-task e2e fixture + integration test** (`test/fixtures/orchestrator/3-task-phases.yaml`, `test/integration/cli/orchestrate/e2e.test.ts`) — spawns `dist/bin/forge.cjs` as a subprocess and drives the full v2 lifecycle (`run start` → `phases --ready` → `claim` → `dispatch` → `heartbeat` → `question` → `cancel | complete`) against three fixture tasks. `FORGE_NOOP_TRACKER=1` keeps the test hermetic.
- **`/push-to-tracker` skill** — canonical, tracker-agnostic push. Reads `.forge/settings.yaml` `tracker.type` (linear | github | notion) and dispatches to the matching `Tracker` adapter (FORGE-23). Writes canonical `tracker_project_id` / `tracker_url` (top-level) and `tracker_issue_id` (per task) into `phases.yaml`.
- **`tracker-syncer` subagent** — replaces `linear-syncer`. Documents per-tracker dispatch (Linear MCP / `GitHubTracker` / Notion MCP) over the shared `Tracker` interface from FORGE-14.
- **`docs/trackers/` directory** — split out the Linear deep-dive (now `docs/trackers/linear.md`) and added an index `README.md` plus short stubs for `github.md` and `notion.md`.

### Removed

- **`forge orchestrate next | suggest-next | session-check | intent-detect`** (FORGE-96) — dropped from the v2 surface per spec/ORCHESTRATOR.md §CLI surface (simplified 2026-05-17). No deprecation alias; sole-user decision. Replacements:
  - Listing ready tasks → `forge orchestrate phases --ready`.
  - Session re-grounding → `forge orchestrate status` (or the `/status-check` skill).
  - "I had an idea" intent → user explicitly invokes `/amend-roadmap` (no automatic detection).
- **Legacy `linear_*` keys in `plans/phases.yaml`** — `linear_project_id`, `linear_team_id`, per-phase `linear_milestone_id`, per-task `linear_id`, and top-level `github_repo` are gone from the schema. The canonical tracker-agnostic keys (`tracker_project_id`, `tracker_url`, per-phase `tracker_milestone_id`, per-task `tracker_issue_id`) are now the only supported names. Tracker-specific config (Linear `team_id`, GitHub `repo`, Notion `database_id`) lives only in `.forge/settings.yaml::tracker.config`, no longer duplicated into `phases.yaml`. Originally scheduled for v0.4.0; accelerated because there are no external adopters with stored legacy keys.

### Deprecated

- **`/push-to-linear`** is now an alias for `/push-to-tracker` and prints a deprecation warning before forwarding.

### Changed

- **`LinearTracker.claim` + `releaseClaim`** (FORGE-76):
  - Claim label prefix migrated `claimed:agent-*` → `forge:claimed-by:*` (hard cut, matches `GitHubTracker` per FORGE-77).
  - Verify-on-readback now enforces our label is present on reread; previously a recheck that returned only another agent's label (or no labels) could return `{ ok: true }` (false positive). Now returns `{ ok: false, reason: 'version_conflict', detail: 'claim-label-missing-on-recheck' }`.
  - `releaseClaim` is now strict-scope — removes only `forge:claimed-by:<runId>` (the caller's exact label), not all claim labels on the issue. Includes stale-cached-id retry (evict + refresh + retry once on `VALIDATION`).
  - Legacy `claimed:agent-*` labels left on issues by pre-FORGE-76 forge are now invisible to claim logic. Tracker-side stale-claim reconciliation lands in FORGE-22 (`forge orchestrate gc`).
- **`/sync-status`** — preflight and body generalized to read `tracker.type` first; uses `tracker-syncer` subagent.
- **`/pickup-task`** — step 1 reads "Query the configured tracker (via Tracker interface)" instead of "Query Linear (via MCP)". Behavior unchanged for v0.3.x (still uses Linear MCP today); full behavioral generalization is a follow-up once FORGE-16/17 adapters land.
- **`/decompose`** — final-print message updated from `/push-to-linear unlocked` to `/push-to-tracker unlocked`.
- **`docs/LINEAR-INTEGRATION.md`** → **`docs/trackers/linear.md`** (verbatim move; old path deleted). Internal links updated.
- **`templates/phases.template.yaml`** and **`examples/time-logger/plans/phases.yaml`** — now use only the canonical `tracker_*` keys.

### Notes

- The scaffolded `CLAUDE.md` template (per-project) does not yet exist in `templates/`. When it lands in a future ticket, it should adopt `/push-to-tracker` as the canonical name; until then this CHANGELOG entry is the source of truth.

## [1.0.0] — 2026-05-07

Initial public release.

### Added

- **21 skills** covering the full product lifecycle:
  - Ideation: `/forge`, `/draft-prd`, `/draft-spec`, `/draft-design`, `/ingest-spec`, `/decompose`
  - Setup: `/setup-repo`, `/push-to-linear`, `/sync-status`
  - Per-task loop: `/pickup-task`, `/plan-task`, `/implement`, `/investigate`, `/fix`
  - Quality gates: `/review`, `/qa`, `/codex`, `/ship`
  - Compound: `/learn`, `/phase-gate`, `/retro`
- **12 subagents**: product-decomposer, linear-syncer, frontend-dev, backend-dev, db-architect, qa-engineer, code-reviewer, security-auditor, phase-gatekeeper, learning-curator, devops-engineer, design-reviewer
- **13 templates**: BRIEF, PRD, SPEC, DESIGN, phases.yaml, CLAUDE.project, CRITICAL, learning, retro, plus 4 GitHub Actions workflows
- **8 enforced principles** (see ETHOS.md): Boil the Lake, Iron Law of Investigation, Confusion Protocol, Test-or-die, Compound Learning, Multi-model Second Opinion, Plan Mode Mandatory, 12-Factor Env Discipline
- **Linear ↔ GitHub native sync** via branch-name and PR-title conventions
- **Git worktree-based parallelism** for multiple Claude Code sessions on one repo
- **`@inherit` pattern** for brand-book / design-system reuse across projects
- **`forge` CLI** with `init`, `templates`, `upgrade`, `version` subcommands
- **`setup.sh`** installer that symlinks skills/agents into `~/.claude/`
- **time-logger example** demonstrating end-to-end lifecycle (BRIEF → PRD → SPEC → phases.yaml)

### Notes

- Stack-agnostic: Next.js, Django, Rails, Go, anything.
- macOS-targeted; Linux compatibility likely but not yet validated.
- Codex CLI integration assumes Codex is installed and authenticated separately.
