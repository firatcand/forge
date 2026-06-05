# Changelog

All notable changes to forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and forge adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`forge status` verb** (FORGE-159) — a read-only, top-level command that reports
  a forge-managed project's state in one round-trip: methodology version drift
  (bundled vs on-disk), agent root files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`
  marker presence + user-content byte size), symlink-farm provenance counts
  (forge-owned vs user-owned vs broken under `.claude/`, `.codex/`, `.gemini/`),
  spec placeholder-section counts, `plans/phases.yaml` phase/task counts, and
  tracker/secrets config. Supports `--json` for a machine-parseable `{ ok, data }`
  envelope (same shape as the orchestrate verbs) and a human-readable default.
  Distinct from `forge orchestrate status` (which reports orchestrator run-state).
  Never writes; a non-forge directory returns `managedByForge: false` and exits 0.
  Farm provenance reuses the same ownership check `forge upgrade --remove-agent`
  relies on (`skill-farm.ts`), so "forge-owned" means the same thing whether
  reporting or pruning.
- **`forge orchestrate apply-decision` verb** (FORGE-95) — the mechanical applier
  behind `/update-spec --apply`. Given an **accepted** ephemeral ADR and a
  payload-complete journal at
  `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`, it
  propagates the decision across SPEC §sections + PRD §sections (marker-block
  replacement), `phases.yaml` task fields (`description`/`acceptance`), and
  tracker issue bodies — journaling each mutation so a partial failure is
  resumable with `--resume`. Flags: `--adr <slug> [--yes-all] [--resume]
  [--dry-run]`. On full success it writes a durable rationale (a
  `spec/decisions/INDEX.md` line + a `<slug>.commit-msg.txt` body), deletes the
  ephemeral ADR, and archives the journal. The verb never runs `git` (the
  skill/user commits the message file). Trackers that cannot update issue bodies
  (Notion, until FORGE-117) fail a **preflight** before any local mutation, so
  the repo is never left half-applied. Folds in FORGE-163 (durable decision
  rationale via `spec/decisions/INDEX.md`). The `/update-spec --draft|--apply`
  skill that authors journals is FORGE-93 (still pending) — until then journals
  are authored by hand or fixture.
- **`forge eject` — reversible clean uninstall** (FORGE-158) — one command to
  remove forge from a project. Strips the forge-managed marker block from each
  agent root file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`), preserving your own
  content byte-for-byte; reverses the `.gitignore` block and the
  `.eslintignore` / `.prettierignore` lines; removes the host skill/agent farms
  and the `.forge/` directory. `spec/`, `plans/`, `CRITICAL.md`, and your source
  are left untouched.
  ```
  forge eject                  # dry-run plan (default)
  forge eject --confirm        # apply
  forge eject --confirm --no-backup
  forge eject --restore <dir>  # undo a recent eject
  ```
  Safety: dry-run by default; takes a restorable backup snapshot
  (`.forge.eject-backup-<ISO>/`) before deleting; refuses while an active
  worktree or a non-terminal task state exists, or when a forge-managed file has
  uncommitted git changes. Reversal is driven by a new `.forge/manifest.json`
  (written by `forge init`, refreshed by `forge upgrade`) that records exactly
  what forge wrote — so version-drift orphans and Windows copy-mode farm entries
  are handled. Projects predating the manifest fall back to a best-effort derived
  mode with a warning. Exposed as a top-level verb only (not `forge orchestrate
  eject`) — eject is a project-lifecycle command, not an orchestrator state
  transition.

- **`settings.verify` + real verification runner** (FORGE-168) — a new optional
  `verify` block in `.forge/settings.yaml` lets an adopter declare the commands
  that prove an attempt is good:
  ```yaml
  verify:
    commands:
      - npm test
      - npm run lint
  ```
  Each entry is a shell command string, run via `shell: true` in the repo root
  with the **full** environment (real test suites need `NODE_ENV` / DB creds —
  this is intentionally not routed through the secret-stripping AI-subprocess
  path). Commands run sequentially; all run even if one fails, and the runner
  reports an aggregate pass/fail. **Optional:** unset ⇒ verification is skipped
  with a warning; a present block must declare ≥1 non-empty command. This is the
  real-verification capability `forge orchestrate complete` previously deferred
  (it self-attests); consumed next by the gc `reverify_verdict` executor.
- **Release automation** (FORGE-157) — two GitHub Action workflows that fire on `v*` tag push:
  - `.github/workflows/release.yml` — verifies the tag matches `package.json` version, re-runs the full CI gate (typecheck, test, build, pack-gate, smoke) on the tagged commit, then runs `npm publish --provenance`. The `--provenance` flag attaches a SLSA cryptographic attestation linking the published tarball to its source commit + workflow run; adopters can verify with `npm audit signatures`.
  - `.github/workflows/release-draft.yml` — slices the matching `## [X.Y.Z]` section out of `CHANGELOG.md` and creates a DRAFT GitHub Release pre-filled with those notes; reviewer publishes from the GH UI when ready.
  - Required GitHub secret: `NPM_TOKEN` (granular automation token, scoped to the `@firatcand/forge` package, publish permission only). Setup recipe in `CONTRIBUTING.md` §Releasing.
- **Adopter release templates** at `templates/github-workflows/release.yml` and `templates/github-workflows/release-draft.yml` — generic versions (no forge-specific smoke step) that adopter projects can copy into their own `.github/workflows/` manually. Auto-scaffolding by `forge init` is deferred — adopter projects aren't always npm packages, so the npm-vs-other-publishing prompt design needs more work before we wire scaffold integration.

### Changed

- **`npm run lint` now runs ESLint** (#264, #265) — forge's repo gained a minimal,
  non-blocking ESLint setup (flat config: `@typescript-eslint/no-unused-vars`,
  `no-unreachable`, `no-constant-condition`, all as **warnings**). The `lint`
  script previously aliased to `typecheck`, which can't flag unused imports/vars
  (the repo omits `noUnusedLocals`) — exactly the gap that let a dead import slip
  through review. Warnings-only keeps it non-blocking; CI runs it via a
  `continue-on-error` step, and all 23 pre-existing warnings were cleared.
  Contributor-facing dev tooling only — forge ships no linter config, so adopters
  are unaffected.

### Fixed

- **Scaffolded lint/e2e gate steps no longer fail when the script is absent**
  (#267) — the templates `forge init` writes referenced `npm run lint` (CI
  workflow + the default `phases.yaml` `gate_check_command`) and `npm run e2e`
  (gate) unconditionally, so a project that hadn't defined those scripts hit
  `Missing script` failures in CI and at the phase gate. They now use
  `npm run lint --if-present` / `npm run e2e --if-present`; `typecheck` stays the
  hard requirement, and the `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` command lists
  annotate Lint as "(if your project defines one)". Forge still imposes no
  linter — the references just stop hard-failing when absent. Adopter-side mirror
  of the forge-repo lint-script fix (#256).

## [0.3.0] — 2026-05-25

First release of the post-v0.2.2 line. **Contains breaking changes** to the CLI verb surface, `plans/phases.yaml` schema, and `CLAUDE.md` layout. Existing v0.2.x adopters should run `forge upgrade` after upgrading, and `forge upgrade --migrate-claudemd` if they have a v0.2.x-shape combined `CLAUDE.md`.

### Migration summary

- **`plans/phases.yaml`** — replace `linear_*` keys with canonical `tracker_*` keys (see `Removed` below).
- **`forge orchestrate next | suggest-next | session-check | intent-detect`** — removed without alias; use `forge orchestrate phases --ready` and `forge orchestrate status` instead.
- **`CLAUDE.md`** — methodology has moved to `.forge/CONTEXT.md`. Run `forge upgrade --migrate-claudemd` for an automatic strict-match migration, or follow the manual recipe printed on drift.
- **Worktrees** — new default location is `.forge/worktrees/<id>/` (was `../<project>-worktrees/<id>/`). Existing sibling worktrees keep working; consolidation is optional.

### Added

- **`.forge/CONTEXT.md` methodology split + multi-agent root files** (FORGE-152 / Phase A, [#216](https://github.com/firatcand/forge/pull/216)) — `forge init` now writes a slim per-agent root file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, user-selected via the init prompt) plus a Forge-managed `.forge/CONTEXT.md` containing the methodology. Methodology no longer pollutes the product's `CLAUDE.md`. `.forge/CONTEXT.md` is gitignored and regenerated from the bundled npm package.
- **`forge upgrade` verb** (FORGE-153 / Phase B, [#217](https://github.com/firatcand/forge/pull/217)) — explicit re-sync verb. Refreshes `.forge/CONTEXT.md` from the bundled template, manages enabled agents via `--add-agent` / `--remove-agent`, supports `--dry-run`, writes `.forge/.version`. Strict edit detection refuses to overwrite user edits; `--force` overrides and writes `.bak`. Exit codes 1/3/4 implemented (exit 2 — dirty-worktree + lease guard — tracked as FORGE-155).
- **`forge upgrade --migrate-claudemd`** (FORGE-154 / Phase C, [#219](https://github.com/firatcand/forge/pull/219)) — one-shot migration for existing v0.2.x-shape `CLAUDE.md` files. Strict heading-by-heading SHA-256 match against a pinned v0.2.x fixture; bails to a manual recipe on drift.
- **`forge init` GitHub-connected prompt + `gh auth` probe** (FORGE-108 / P3-T01, [#220](https://github.com/firatcand/forge/pull/220)) — standalone yes/no prompt with non-blocking `gh auth status` validation. Scaffolded `.forge/settings.yaml` now includes `codex` / `decisions` / `doctor` blocks per the extended SettingsSchema.
- **Multi-host project-local skill + agent farm** (FORGE-156) — `forge init` and `forge upgrade` now materialize per-host directories for every enabled agent, so host-side slash-command and subagent discovery resolves in a freshly-initialized project. Layout (one per enabled host):
  - Claude Code → `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md`
  - Codex CLI → `.codex/skills/<name>/SKILL.md`, `.codex/agents/<name>.md`
  - Gemini CLI → `.gemini/skills/<name>/SKILL.md`, `.gemini/agents/<name>.md`
  Entries are symlinks pointing into the bundled `node_modules/@firatcand/forge/skills` and `agents/` on POSIX, and recursive copies on Windows (where unprivileged symlinks aren't reliable). Idempotency is replace-if-mismatched: an existing-and-correct entry is left alone; a mismatched entry (different target, real file/dir, broken link) is backed up to `<entry>.bak` and replaced. The farm directories are gitignored by the forge-managed `.gitignore` block — targets are per-machine and rotate on every `forge upgrade`, so committing them would break teammates with a different npm layout. Adopters who want to track their own non-forge skills/agents in these dirs can add `!` override lines below the marker block.
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
- **Legacy `linear_*` keys in `plans/phases.yaml`** — `linear_project_id`, `linear_team_id`, per-phase `linear_milestone_id`, per-task `linear_id`, and top-level `github_repo` are gone from the schema. The canonical tracker-agnostic keys (`tracker_project_id`, `tracker_url`, per-phase `tracker_milestone_id`, per-task `tracker_issue_id`) are now the only supported names. Tracker-specific config (Linear `team_id`, GitHub `repo`, Notion `database_id`) lives only in `.forge/settings.yaml::tracker.config`, no longer duplicated into `phases.yaml`. Originally scheduled for v0.3.0; accelerated because there are no external adopters with stored legacy keys.

### Deprecated

- **`/push-to-linear`** is now an alias for `/push-to-tracker` and prints a deprecation warning before forwarding.

### Behavior change

- **Worktree location standardized to `.forge/worktrees/<sanitized-id>/`** (FORGE-115 / P2.5-T19) — `/pickup-task` now creates worktrees inside the project at `.forge/worktrees/`, matching the orchestrator's existing convention. Previously the skill used `../${PROJECT}-worktrees/${TICKET}/` (sibling directory outside the repo). **Migration:** existing sibling worktrees keep working — git tracks them by absolute path. To consolidate, run `git worktree list` to find them, then either `git worktree move <old-path> .forge/worktrees/<id>` to relocate or `git worktree remove <old-path>` if the branch is already merged. `forge init` now also writes tooling-exclude entries (`.eslintignore`, `.prettierignore` get a one-line append; `tsconfig.json` and `vitest.config.*` get a copy-paste snippet in `.forge/init-warnings.md`) so lint / typecheck / test runs don't recurse into worktrees.

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
