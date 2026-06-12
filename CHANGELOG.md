# Changelog

All notable changes to forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and forge adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Cursor host (FORGE-160).** `cursor` is now a first-class `AgentKind`. Its
  managed artifact is `.cursor/rules/forge-context.mdc` — YAML frontmatter
  (`alwaysApply: true`) FIRST, then a forge marker block that INLINES the
  rendered methodology context verbatim (Cursor `.mdc` rules cannot reliably
  `@file`-import, so the breadcrumb is self-contained). The file is gitignored
  and regenerated per machine by `forge upgrade` (same determinism rationale as
  `.forge/CONTEXT.md`), and — unlike the product-owned root files of the other
  hosts — it is **materialized when enabled** (created if absent). Skill farm:
  `.agents/skills` (Cursor's native cross-tool skill root) + `.cursor/agents`.
  `forge init`'s root-file checkbox gains a Cursor option; `settings.yaml`
  `enabled_root_files` and `primary_host_cli` accept `cursor`. Cursor as the
  PRIMARY dispatch host is **beta-gated** behind
  `agents.cursor_host_beta_opt_in: true` (selecting it without the flag is a
  parse error naming the flag); under opt-in a subprocess-backed `CursorHarness`
  (`agent -p --force --output-format json`, `CURSOR_API_KEY` passthrough) drives
  primary dispatch — `runReview` is NOT_SUPPORTED (review hosts stay codex |
  gemini). `forge upgrade --add-agent cursor` / `--remove-agent cursor`,
  `.gitignore` block entries, and the eject path all handle the nested artifact
  and the shared `.agents/skills` farm root (prune-safe when another enabled
  host shares it).
- **Doctor symbol-mention drift (FORGE-131).** `forge orchestrate doctor
  --scope spec-code` now flags identifier-shaped backtick spans in the spec
  files that appear nowhere in `src/**/*.ts` (`missing_symbol` drift entries,
  exit-2 semantics unchanged). This is a **bounded mention check, not export
  analysis**: a symbol in a comment or test counts as present, and a renamed
  export with stale prose is caught only when the old name vanishes from `src`
  entirely. A code-shape filter (CamelCase ≥2 humps / camelCase /
  `ALL_CAPS_SNAKE`, len ≥4) plus a built-in `BASE_SYMBOL_ALLOWLIST` and the new
  adopter-declared `settings.doctor.symbol_allowlist` keep prose nouns and
  external names out of the drift list.
- **`spec-diff --all-active` + ship-time SPEC signal (FORGE-164).** `forge
  orchestrate spec-diff --all-active` enumerates every active task
  (`dispatched` | `running` | `blocked_on_question`) whose claim predates a
  `spec/` change, emitting `{ task_id, commit_count, files_affected,
  lease_expired }[]` (corrupt/missing state or lease → skip with a stderr note;
  expired leases still listed with `lease_expired: true`; no-diff tasks omitted;
  always exits 0). `/ship` surfaces the single-task signal as an informational
  `### ⚠ SPEC changes since this task was claimed` PR-body section — it never
  blocks the ship. Together with the on-resume block this closes both halves of
  the FORGE-114 SPEC-drift mitigation.

## [0.4.2] - 2026-06-12

### Fixed

- **`forge upgrade` destroyed symlinked agent root files (FORGE-208).**
  `writeAtomic`'s rename replaced the symlink inode itself, so a
  CLAUDE.md → AGENTS.md parity link became a divergent regular file on every
  upgrade. The primitive is now default-deny: an lstat preflight throws typed
  `FsWriteError('SYMLINK_TARGET_REFUSED')` on symlinked targets (only ENOENT
  is treated as absent; other lstat failures propagate). Per-surface policy:
  the recurring upgrade refresh **skips symlinked root files / .gitignore with
  a notice** (exit 0, identical in `--dry-run`); a symlinked
  `.forge/settings.yaml` is refused upfront before anything is written;
  `--add-agent`/`--remove-agent` refuse explicitly; `migrate-claudemd`'s
  preconditions now cover CONTEXT.md/.version/.gitignore (no partial-state
  writes); `eject` and `init` skip gracefully — including eject's
  forge-created `unlinkSync` paths and init's staged-promotion bypass, so a
  user-converted symlink is never deleted. Covered by property tests (lstat
  file type before == after for every touched path; upgrade twice == once;
  dry-run parity). Known documented gap: hardlinks still break silently on
  rename (`nlink > 1` preflight is follow-up scope).

## [0.4.1] - 2026-06-12

### Added

- **`/wrap-up` skill + `forge orchestrate gc --remove-worktrees` (FORGE-116).**
  End-of-task housekeeping: confirm the merge, close the tracker issue, and
  remove the task's worktree through the gc planner (eligible/refused/absent
  classification, lease-health gate, exit 1 on any refusal).
- **`gc --prune-merged-branches` opt-in (FORGE-139).** `workspace.cleanup()`
  can now delete the task branch after merge: leading-`-` pre-screen,
  `git check-ref-format --branch` as the authoritative ref predicate, then
  `git branch -d --` (never `-D`); a refusal is reported as
  `branchRetainedReason`, never an error.
- **`owner_type: 'human'` for manual bootstrap tasks (FORGE-177).** Provision
  accounts / paste keys / OAuth-consent work can now be modeled faithfully.
  Human-owned tasks are never auto-dispatched: `phases --ready` excludes them
  from the dispatchable set and surfaces them as `human_checkpoints` (with a
  `⏸ human checkpoint` line in human output); plain `phases` still lists them.
- **`PHASES_PARSE_ERROR` now surfaces the zod `issues[]` (FORGE-176).** Human
  stderr gets a bulleted `<path>: <message>` list (capped at 20, `+N more`);
  `--json` gets structured `error.details.issues`.

### Changed

- **Unified task-id schema (FORGE-130).** All task-id validation now flows through
  one primitive (`src/schemas/task-id.ts`, `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`):
  alphanumeric start, then letters/digits/`.`/`_`/`-`, max 64 chars, no `#`, `/`,
  `\`, or whitespace. The CLI args schema, the questions/paths segment validator,
  `workspace.sanitizeIssueId`, and the gc worktree-id check all wrap this single
  source of truth (each keeps its own error codes). This **widens** the prior
  Linear-only CLI shape — lowercase ids, no-hyphen ids, phases ids (`P2.5-T07`),
  normalized GitHub ids (`GH-42`), and UUIDs now pass. Two **narrowings** vs the
  prior per-site validators: a leading `.` (old `workspace` pattern) and a
  leading `_`/`-` (old `questions/paths` pattern) are now rejected — both are
  leading-punctuation path hazards no live id namespace used.
- **GitHub issue identifier normalized to `GH-<n>` (FORGE-130).** The GitHub
  adapter now emits the path-safe `GH-42` identifier instead of the legacy `#42`
  (which the unified shape rejects). `parseIssueNumber()` reverse-maps `GH-42`,
  `#42`, bare `42`, and issue URLs back to the bare number across **every** native
  call site (claim, releaseClaim, updateState, comment, createIssue, setBlockedBy,
  updateIssueBody, setClaimFence), so the legacy `#42` shape is still **accepted on
  read** — existing `plans/phases.yaml` bindings keep working. `setBlockedBy`'s
  blocker input is widened the same way (footer still stores the bare number).
  `reconcile` seeds legacy aliases (`#<n>` + bare `<n>`) for GitHub issues so
  `--pull` never false-removes a task bound by an old shape and `--push` resolves
  body targets through the same aliases.
- **UTF-8 byte caps on attempt/verdict string fields (FORGE-83).** Byte-budget
  fields (output excerpts, summaries, `save_point`, finding messages, reasons)
  now enforce true UTF-8 byte limits via `byteBoundedString` (the old `.max(N)`
  counted UTF-16 code units — multibyte text could overshoot up to 3×). New
  code-point-safe `truncateUtf8` helper; `verdict-parser` and the
  `cancel`/`question` producers truncate byte-safely. **Stricter:** previously
  stored multibyte strings over the byte cap now fail re-parse (by design; forge's
  own producers emit ASCII excerpts).
- **`codex.auto_codex_token_cap` removed (FORGE-124).** The field was RESERVED
  with no enforcement (a relic of dropped host-level hooks). Legacy keys in
  existing `settings.yaml` files parse cleanly and are silently ignored.

### Fixed

- **`forge migrate`/`upgrade` rename codemod no longer corrupts deprecation
  aliases and historical docs (FORGE-207).** `docs/retros/`, `docs/plans/`, and
  `skills/push-to-linear/` are detection-only (warning findings, never
  rewritten), and a line-level self-replace guard skips any line that already
  contains the replacement name — eliminating the self-referential
  "/push-to-tracker is deprecated — use /push-to-tracker" class. Skipped lines
  are surfaced, untouched content stays byte-identical.
- **Worktree-lifecycle hardening (FORGE-139/140/142/70).** `ensure-worktree`
  anchors a relative `git rev-parse --git-common-dir` on the git command's cwd
  (not `process.cwd()`); hydration skips git submodule boundaries (including a
  submodule hydration root itself); `/pickup-task` installs dependencies in the
  fresh worktree (npm/pnpm/yarn/bun by lockfile).
- **`/decompose` emitted invalid `phases.yaml` (FORGE-175).** The skill and the
  product-decomposer agent now emit `acceptance` (was `acceptance_criteria`,
  which failed validation on every fresh run) and the skill's `type` list
  matches the real TaskSchema enum.
- **`TaskSchema.status` garbage-rejection test (FORGE-120)** closing the
  deferred security-review AC (enum itself shipped earlier).

### Documentation

- SPEC §Module layout gains the `src/harnesses/` subtree (FORGE-137); the
  §`phases.yaml` schema snippet is refreshed field-for-field from
  `src/schemas/phases.ts` (FORGE-129); the methodology context template gains
  the ambiguous-field authority conflict table (FORGE-162); CONTRIBUTING gains
  the clean-room pre-push smoke recipe incl. the chalk-render check via
  `migrate --dry-run` (FORGE-68).

## [0.4.0] - 2026-06-11

v0.4.0 ships the **closed-loop / ephemeral-ADR workflow**: the `apply-decision`
verb (FORGE-95), the `/update-spec --draft|--apply` skill (FORGE-93), and the
`/amend-roadmap` verb + skill (FORGE-101) are all production-ready. Only worker
drift *events* and the precedence engine remain scheduled for v0.5; the
worktree-drift-guard was canceled.

Also in this release: Notion tracker support via the `ntn` CLI incl.
`updateIssueBody` (`setClaimFence` remains stubbed — FORGE-167) (replacing
the removed MCP transport), `forge migrate` for v0.2.x project paths, a
greenfield e2e fixture matrix, phases-write lock, and a range of orchestrator
robustness improvements.

### Migration

- **Pre-v0.4 combined `CLAUDE.md`** — from any repo with a pre-v0.4-shape
  combined `CLAUDE.md`:
  ```
  npm i -g @firatcand/forge@0.4.0 && forge upgrade --migrate-claudemd
  ```
- **v0.2.x project drift** — settings blocks, `@inherit` in `DESIGN.md`,
  `/push-to-linear` references, renamed/dropped orchestrate verbs, missing ADR
  template, and legacy v1 orchestrator state:
  ```
  forge migrate
  ```
  `forge migrate` previews all detected drift, requests confirmation, backs up
  before applying, and reports complex conversions as manual follow-ups —
  never invoking the owning tool itself (missing settings → `forge
  init`; `@inherit` strips → `/draft-design`; legacy orchestrator state →
  `forge orchestrate gc`).
- **Notion** — MCP transport has been removed; `@modelcontextprotocol/sdk` is
  no longer a dependency. The official `ntn` CLI is now required — install it
  and authenticate (credentials live in your system keychain; no API-key env
  var needed):
  ```
  curl -fsSL https://ntn.dev | bash && ntn login
  ```
  The `mcp_command` and `mcp_env` fields in `.forge/settings.yaml` are now
  deprecated-ignored (accepted by the schema but not read; will be removed in
  v0.5).

### Added

- **`/amend-roadmap` skill + `forge orchestrate amend-roadmap` verb** (FORGE-101)
  — tracker-first mid-flight task creation with a journaled, resumable amend
  flow. Features O_EXCL task-id reservation, adoption-on-resume (exactly-one
  footer match, refuses truncated views), payload-hash mismatch refusal, and an
  inline drift warning that replaces the dropped worktree-drift-guard
  (FORGE-103). The new **phases-write lock** (per-attempt ownership tokens,
  steal-mutex-serialized takeover, release validity window, `assertFresh` before
  every write) closes lost-update races — including `apply-decision`'s previously
  unlocked `phases.yaml` write path. `reconcile` gains `stagedAdditions` +
  `insertTaskIntoDocument` to keep `phases.yaml` single-writer for mid-flight
  additions.
- **`forge migrate` — v0.2.x → v0.4 project migration** (FORGE-109) — detects
  the v0.2.x drift signatures (stale settings blocks, `@inherit` in
  `DESIGN.md`, `/push-to-linear` refs, renamed/dropped orchestrate verbs, missing
  ADR template, legacy v1 orchestrator state), shows a chalk diff preview,
  requests hybrid confirmation (TTY `y/N`, `--yes` for CI, `--dry-run`), writes
  verified backups to `.forge/backup-<ts>/` before applying, and re-verifies
  after each write. Complex conversions are REPORTED as manual follow-ups —
  migrate never invokes the owning tool itself
  (missing settings → run `forge init`; `@inherit` strips + follow-up marker;
  legacy state → `forge orchestrate gc`).
- **`/update-spec --draft|--apply` skill** (FORGE-93) — two-mode skill wrapping
  the `apply-decision` verb. `--draft`: active-ADR preflight (malformed
  ADR-shaped files refuse; companions never block), discovery interview,
  template instantiation, codex-suggest hook. `--apply`: completed-archive
  recovery branch before ADR resolution, canonical-file + journal-trust +
  clean-target gates (tracker scope bounded by `affected_tasks`),
  payload-complete journal authoring with a schema-validated worked example,
  per-artifact diff confirmation, envelope-driven error handling, exact-footprint
  staged-patch audit, and a `--cleanup=verbatim` propagation commit carrying the
  full ADR rationale. Clears 36 stale "FORGE-93 still v0.5/pending" qualifiers
  across SPEC/PRD/CONTEXT template.
- **NotionTracker via the `ntn` CLI** (FORGE-117) — `McpCall` seam replaced with
  `NtnExec` (a `GhExec` mirror; execa `reject:false` with resolved-ENOENT
  re-throw). Every tracker call translated to `ntn api v1/...` — except
  `setClaimFence`, which remains a NOT_IMPLEMENTED stub on Notion (claim-fence
  storage needs a dedicated design; FORGE-167 follow-up) — (stdin bodies,
  query-arg pagination, `NOTION_API_VERSION` pinned to 2026-03-11).
  `updateIssueBody` implemented (validation contract parity, `forge_task_id`
  precondition, list → delete → append children with documented non-atomic
  idempotently-re-runnable semantics, shared `bodyToParagraphBlocks` chunking).
  `classifyNotionExecError` with the full official code table including transient
  codes. `@modelcontextprotocol/sdk` removed from `package.json` (user-approved
  soft deprecation; `mcp_command`/`mcp_env` stay schema-accepted but ignored,
  removed in v0.5). `BaseTracker.withRetry` now honors provider `Retry-After`
  hints (`details.retryAfterMs`) for **all** adapters — previously stored, never
  read. `runProbe` (init): central fix for execa@9 resolved-ENOENT spawn failures
  — every probe (git/gh/claude/codex/ntn/op) now reports install guidance instead
  of a bogus exit message; `ntn` probe verifies install + keychain auth in one
  call (`ntn api v1/users/me`).
- **Greenfield e2e fixtures + lifecycle drive-through + CI matrix** (FORGE-110)
  — `examples/greenfield-{github,linear,notion}`: frozen mini-projects
  (deterministic `phases.yaml`, tracker-typed settings, spec stubs with
  resolvable anchors, ADR template) serving as both test fixtures and living
  documentation. `test/integration/cli/orchestrate/lifecycle.e2e.test.ts`:
  per-fixture drive-through gated behind `FORGE_E2E_FIXTURE` (self-skips under
  plain `npm test`): fixture sanity, claim → dispatch → heartbeat with
  `state.json`/lease assertions, amend-roadmap drift warning, multi-main CAS
  race (winner + `ALREADY_CLAIMED` loser envelopes), full `update-spec` closed
  loop (+ `--resume` crash recovery), `reconcile --pull/--push` drift, migrate
  smoke. `.github/workflows/ci.yml` gains an e2e job (matrix Node 22/24 × 3
  fixtures = 6 cells). `docs/release-checklist.md` documents the manual
  pre-release ritual.
- **`forge status` verb** (FORGE-159) — a read-only, top-level command that
  reports a forge-managed project's state in one round-trip: methodology version
  drift (bundled vs on-disk), agent root files (`CLAUDE.md`/`AGENTS.md`/
  `GEMINI.md` marker presence + user-content byte size), symlink-farm provenance
  counts (forge-owned vs user-owned vs broken under `.claude/`, `.codex/`,
  `.gemini/`), spec placeholder-section counts, `plans/phases.yaml` phase/task
  counts, and tracker/secrets config. Supports `--json` for a machine-parseable
  `{ ok, data }` envelope. Distinct from `forge orchestrate status` (which
  reports orchestrator run-state). Never writes; a non-forge directory returns
  `managedByForge: false` and exits 0.
- **`forge orchestrate apply-decision` verb** (FORGE-95) — the mechanical
  applier behind `/update-spec --apply`. Given an accepted ephemeral ADR and a
  payload-complete journal at
  `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`, propagates
  the decision across SPEC §sections + PRD §sections (marker-block replacement),
  `phases.yaml` task fields, and tracker issue bodies — journaling each mutation
  so a partial failure is resumable with `--resume`. On full success writes a
  durable rationale (`spec/decisions/INDEX.md` line + `<slug>.commit-msg.txt`),
  deletes the ephemeral ADR, and archives the journal. Trackers that cannot
  update issue bodies fail a preflight before any local mutation. Folds in
  FORGE-163 (durable decision rationale via `spec/decisions/INDEX.md`).
- **`forge eject` — reversible clean uninstall** (FORGE-158) — strips the
  forge-managed marker block from each agent root file, reverses the `.gitignore`
  / `.eslintignore` / `.prettierignore` blocks, removes the host skill/agent
  farms and the `.forge/` directory. `spec/`, `plans/`, `CRITICAL.md`, and your
  source are left untouched. Dry-run by default; takes a restorable backup
  snapshot (`.forge.eject-backup-<ISO>/`) before deleting; refuses while an
  active worktree or a non-terminal task state exists, or when a forge-managed
  file has uncommitted git changes.
- **`settings.verify` + real verification runner** (FORGE-168) — optional
  `verify` block in `.forge/settings.yaml` declares the commands that prove an
  attempt is good (`npm test`, `npm run lint`, etc.). Commands run sequentially
  via `shell: true`; all run even if one fails; aggregate pass/fail reported.
  Optional: unset ⇒ verification skipped with a warning.
- **Release automation** (FORGE-157) — `.github/workflows/release.yml`
  (verify-tag → full CI gate → `npm publish --provenance`) and
  `.github/workflows/release-draft.yml` (slice matching `## [X.Y.Z]` section →
  create DRAFT GitHub Release). Adopter generic copies at
  `templates/github-workflows/release.yml` and `release-draft.yml`.
- **`forge orchestrate dashboard` verb + `/status-check` skill** (FORGE-90) —
  cross-run cockpit: active sessions (runs owning ≥1 in-flight task), open
  questions, ready/blocked tasks, file-overlap warnings, lease health
  (alive/expiring_soon/stale). Extracts `collectActiveAttempts` +
  `isTrackerIdDone` into `src/orchestrator/readiness.ts` shared by `dashboard`
  and `phases --ready`.
- **Decision classifier + preflight wrapper + question budget** (FORGE-65) —
  `forge orchestrate question` now runs `gateQuestion` before writing: reuse a
  prior answer → block on an open question → force an autonomous decision at the
  per-task hard cap → else write (carrying a soft-cap warning). `recommended_option_id`
  + `what_happens_if_unanswered` required at the verb. New
  `decision-classifier.ts` and `preflight.ts` (extracted from
  `guardrail-check`). `{{BUDGET_WARNING}}` placeholder wired for FORGE-98
  dispatcher integration.
- **Claim-time overlap gate** (FORGE-170) — `claim.ts` pre-flight refuses a
  task whose declared `write_globs` hard-overlap an already-active attempt
  (retriable `OVERLAP_CONFLICT`) unless `--force`. `DEFAULT_HARD_LOCK_GLOBS`
  retuned: drops `plans/phases.yaml` (generated cache, byte-stable via
  FORGE-121), adds `spec/**` + `skills/**`.
- **Claim-metadata footer storage + read** (FORGE-145 / FORGE-167) —
  `src/trackers/claim-fence.ts` (parse/upsert/strip the `<!-- forge:claim={json}
  -->` footer); `setClaimFence` write side on Linear + GitHub adapters; `toIssue`
  on both adapters populates `Issue.claimId`/`claimGeneration`/`claimOwnerRunId`
  from the body fence. Foundation for gc tracker-divergence rows. Notion write
  stubbed (lands with FORGE-117, delivered in this release).
- **Per-repo `.forge/.env` auto-load for tracker credentials** (#259) —
  `src/core/forge-env.ts` loads an allowlisted set of tracker-auth keys from
  `.forge/.env` into `process.env` at CLI startup (no-override, absent file
  is a no-op, malformed file warns but never crashes). `forge init` scaffolds a
  `.forge/.env` create-once. Linear AUTH errors now name `.forge/.env`.

### Changed

- **`npm run lint` now runs ESLint** (#264, #265) — minimal non-blocking ESLint
  setup (flat config: `@typescript-eslint/no-unused-vars`, `no-unreachable`,
  `no-constant-condition`, all as **warnings**). The `lint` script previously
  aliased to `typecheck`. Warnings-only; CI runs via `continue-on-error`; all 23
  pre-existing warnings were cleared. Contributor-facing dev tooling only.
- **`forge orchestrate reconcile --pull` formatting preserved** (FORGE-121) —
  serializes with `{ lineWidth: 0, flowCollectionPadding: false }` so untouched
  nodes round-trip byte-stable. A 53-title-sync pull dropped from 1835 changed
  lines to 112. `depends_on` lists now edited in-place (preserving block-style
  formatting and inline comments). Deduplication of tracker `blockerIds` at
  source prevents spurious depends_on diffs on every --pull.
- **`forge orchestrate reconcile --pull` false-pruning fixed** (FORGE-165) —
  matched `tracker_issue_id` against both tracker `id` and `identifier`; added
  `Tracker.listAllIssues()` (terminal states now seen, so done/cancelled tasks
  are never mistaken for deleted ones). Fail-closed on truncation: orphan
  detection skipped when the adapter hits its page/limit cap.
- **Codex review harness: diff via stdin instead of argv** (FORGE-166) — avoids
  `SPAWN_FAILED` when the diff exceeds the OS exec arg-size limit.
- **SPEC/PRD `deferred to v0.5` language corrected** — the ephemeral-ADR and
  closed-loop workflow was re-scoped into v0.4 on 2026-06-11. Worker drift
  events, the precedence engine, and the canceled worktree-drift-guard remain
  correctly deferred/dropped.

### Fixed

- **Scaffolded lint/e2e gate steps no longer fail when the script is absent**
  (#267, #268) — templates now use `npm run lint --if-present` / `npm run e2e
  --if-present`; `typecheck` stays the hard requirement.
- **`runProbe` ENOENT crash fix** (FORGE-117) — execa@9 resolved-ENOENT spawn
  failures now surface as install-guidance messages instead of bogus exit codes
  for every probe (git/gh/claude/codex/ntn/op).
- **Orchestration audit umbrella** (#262) — dead import cleanup, stale comment
  refresh (`DECISION_KEY_EXHAUSTED` is no longer dormant), missing verb-level
  test for the `render-worker-prompt` question-budget soft-cap path, Linear
  claim retry classifier guard, and stale-dist e2e test restoration.

### Removed

- **`notion-mcp-transport.ts`** — `src/trackers/notion-mcp-transport.ts` deleted;
  `@modelcontextprotocol/sdk` removed from `package.json`. The Notion MCP
  transport has been replaced by the `ntn` CLI adapter (FORGE-117).
  `mcp_command`/`mcp_env` settings fields are deprecated-ignored (accepted,
  never read; will be removed in v0.5).
- **Dead internal helpers + unused test fixtures** (#249) — `flags.ts:
  nthPositional`, `core/errors.ts: isOrchestratorError`, `scaffold.ts:
  toSettingsObject`, `orchestrator/overlap.ts: globsOverlap`. Associated dead
  test fixtures removed.

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
