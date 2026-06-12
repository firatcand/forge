# Batch 9 (final) — FORGE-160 Cursor host · FORGE-131 doctor symbols · FORGE-164 SPEC-change signal

**Branch:** `feat/hardening-final-batch` · **Worktree:** `.forge/worktrees/FORGE-160`
**Design memo:** `spec/decisions/2026-06-12-cursor-host.md` (user-approved; commit WITH this batch — it is the FORGE-160 AC artifact). FORGE-131 fork resolved by user: grep + allowlist.

## FORGE-160 — Cursor host (per the memo; all three user choices locked)

1. `AgentKind` += `'cursor'` (agent-root-files.ts:14); `ROOT_FILE_BY_AGENT.cursor = '.cursor/rules/forge-context.mdc'` (nested path — the upgrade refresh loop must mkdir and handle a nested managed file). **Materialize-when-enabled (pre-review major):** the refresh loop currently SKIPS missing root files; for cursor the artifact is fully forge-owned, so the loop CREATES it when `enabled_root_files` includes cursor and it's absent (per-host policy flag; claude/codex/gemini keep skip-if-missing). New `cursorBody()`/dedicated assembly: file = `.mdc` frontmatter (`alwaysApply: true`, description) FIRST, then the forge marker block whose body inlines the rendered CONTEXT.md (reuse the `desiredContext` string upgrade.ts:236 already computes; the writer takes it as input). `replacePrefixBlock` manages the marker region within the post-frontmatter body — write a cursor-specific wrapper that splits/reattaches frontmatter around the generic helpers. **Every cursor write path MUST route through the wrapper** (pre-review major): the generic prepend would put markers above MDC frontmatter; add a unit test proving the generic path is never invoked for cursor (e.g. the upgrade loop branches on agent==='cursor' before touching replacePrefixBlock directly). The artifact is FULLY regenerated on upgrade whenever the inlined context drifts.
1b. **Static host-triple sweep (pre-review major):** grep every `'claude' | 'codex' | 'gemini'` union/map and update for cursor where semantically required: init preflight (preflight.ts:21 checks CLAUDE.md only — decide+document cursor behavior), scaffold TEMPLATE_BY_AGENT (add a templates/ cursor variant produced by the wrapper), the manifest schema host enum, `forge status` ALL_HOSTS, eject manifest rootFiles handling (nested path + the FORGE-208 symlink-guard paths), migrate-claudemd (no cursor interaction expected — verify and note). List every touched site in the report.
1c. **Worker-prompt conventions (pre-review major):** render-worker-prompt.ts:133 readHost maps any non-codex/non-gemini value to claude, and the conventions reader only looks at CLAUDE.md/AGENTS.md — a cursor-primary run would render the wrong host block. Add cursor to the host mapping; its conventions source = the marker-block BODY of `.cursor/rules/forge-context.mdc` (strip frontmatter+markers), falling back to AGENTS.md/CLAUDE.md when absent; the worker prompt template gets a cursor host variant (mirror how gemini joined in FORGE-88).
2. Settings: `enabled_root_files` enum += `'cursor'` (settings.ts:147-149) and init checkbox gains `{ name: 'Cursor (.cursor/rules/forge-context.mdc)', value: 'cursor' }` (prompts.ts:431-460, EnabledRootFileEnum:98). `primary_host_cli` accepts `'cursor'` gated by new `agents.cursor_host_beta_opt_in: z.boolean().default(false)` via a schema refine — selecting cursor without the flag is a parse error whose message names the flag and the beta caveat.
3. Skill farm: `HOST_DIRS.cursor = { skills: '.agents/skills', agents: '.cursor/agents' }` (skill-farm.ts:51-55). **Shared-root prune safety (pre-review major):** `pruneHostFarm(cursor)` must NOT remove forge-owned entries under a directory that another currently-ENABLED host also maps to — pass the enabled-host set into pruneHostFarm (signature extension) and skip shared roots still in use; test: cursor+X both enabled sharing a root → remove-agent cursor leaves the shared entries; cursor alone → they're pruned. Gitignore block (gitignore-block.ts:31-43) += `/.agents/skills/`, `/.cursor/agents/`, `/.cursor/rules/forge-context.mdc`.
4. `CursorHarness` (new src/harnesses/cursor.ts, modeled on codex.ts): subprocess-backed `agent -p --force --output-format json <prompt>` with `CURSOR_API_KEY` env passthrough; `dispatchSubagent` primary path; `runReview` throws NOT_SUPPORTED; `healthCheck`/`detectVersion` via `agent --version`-style probe (verify actual flag in implementation; mock-driven tests only — no live CLI). `createHarness('cursor')` wired; conformance test additions mirror claude's primary-only profile. **Factory gate API (pre-review major):** `createHarness` gains an explicit opts input for the gate — `createHarness(host, { cursorBetaOptIn?: boolean, ... })` threaded from loaded settings at every call site (the factory must not read settings globally); cursor without `cursorBetaOptIn: true` throws a typed error naming the flag (defense in depth with the schema refine).
5. upgrade `--add-agent cursor` / `--remove-agent cursor` work through the existing flows (the FORGE-208 symlink guards + the nested-path mkdir are the new edge); idempotency covered by the existing twice==once property test topologies — add a cursor topology to it.
6. Tests: agent-root-files unit (frontmatter-first assembly, marker round-trip, inline-content refresh on context change); skill-farm withTmpDir cursor entries (symlink + prune + shared-root safety); prompts scripted checkbox with cursor; settings refine (cursor-as-primary rejected without flag, accepted with); harness conformance + subprocess arg shape; upgrade integration: init-less fixture → add-agent cursor → upgrade twice==once → remove-agent leaves no forge-owned residue.
7. CHANGELOG entry under [Unreleased] (per ticket AC).

## FORGE-131 — doctor symbol-mention check (grep + allowlist, user-decided)

> Honesty note (pre-review minor): this is a bounded MENTION check, not true export analysis — a symbol appearing only in comments/tests passes, renamed exports with stale prose are caught only when the old name vanishes entirely. Document these bounds in the doctor section of ORCHESTRATOR.md/SPEC and in the entry-kind comment. Do NOT grow toward AST analysis in this batch.

1. drift.ts: in the SAME spec-file loop (43–80), extract backtick spans and keep only identifier-shaped candidates — `/^[A-Za-z_$][A-Za-z0-9_$]*$/` AND (CamelCase with ≥2 humps OR camelCase OR ALL_CAPS_SNAKE) AND length ≥ 4 — the shape filter is the main false-positive killer; prose nouns rarely match.
2. Allowlist: built-in BASE_SYMBOL_ALLOWLIST const (language/framework/CLI terms that legitimately appear in SPEC prose) + `doctor.symbol_allowlist: z.array(z.string().min(1)).default([])` settings extension (DoctorSchema, settings.ts:255-261).
3. Existence check: build one lowercase-insensitive? NO — exact-match symbol index by reading `src/**/*.ts` contents once per run (reuse/parallel the scan-budget discipline from migrate's walker if available; otherwise a bounded readdir walk; budget caps like FORGE-117-era scanners). Candidate missing from every source file → drift entry `kind: 'missing_symbol'` (extend SpecCodeDriftEntry kind union; source/target fields reused). Exit-code semantics unchanged (drift → exit 2).
4. **Self-clean gate (the ticket's AC3):** the existing e2e (doctor.test.ts:244-260) runs doctor on the forge worktree itself and must stay exit 0 — the implementer iterates the BASE allowlist until the real SPEC passes with zero false positives. This tuning is in-scope work, not test fudging: every term added must be a genuine prose mention, recorded in a comment grouped by category.
5. Tests: missing-symbol detected (fixture SPEC mentions `PhantomSchema`); allowlisted term ignored; settings extension honored; shape filter negative cases (plain words, short ids); e2e self-clean.

## FORGE-164 — SPEC-change signal at ship time (informational, no gate)

1. `spec-diff --all-active` (spec-diff.ts) — precise enumeration (pre-review major): walk `.forge/orchestrator/tasks/<task_id>/` reading `state.json` + `lease.json`; include tasks whose state ∈ ACTIVE set (dispatched|running|blocked_on_question); validate lease via LeaseSchema — corrupt lease/state → SKIP with one stderr note (never fail the listing); EXPIRED lease → still listed with `lease_expired: true` (the claim still predates the spec change — that's the signal). Per included task run `computeSpecDiffSinceClaim(repoRoot, lease.spec_revision)`; emit `{ task_id, commit_count, files_affected, lease_expired }[]`; no-diff tasks omitted. Always exit 0. Declare the flag in FLAG_DECLS (honesty contract).
2. skills/ship/SKILL.md: new step between preflight and gates — run `forge orchestrate spec-diff <task_id> --json`; when non-null, (a) print the rendered block, (b) add a `### ⚠ SPEC changes since this task was claimed` section to the PR-body template (step 3, lines 52-55) listing the summaries + a pointer to `--all-active` for other affected tasks. Strictly informational — the skill text must say it never blocks the ship.
3. SPEC.md/ORCHESTRATOR.md: document `--all-active` in the spec-diff synopsis; one sentence in the mechanism-not-policy section noting the push-time half of the FORGE-114 mitigation now exists.
4. Tests: --all-active with two seeded leases (one stale claim, one fresh) lists exactly the stale one; empty state → empty list exit 0; FLAG_DECLS honesty test auto-covers the new flag via the existing loop.

## Gates

1. typecheck · 2. full suite 0 fail (baseline 2118/2092/26; expect +~30) · 3. lint · 4. build + doctor spec-code `drift: []` (now INCLUDING the new symbol detection against the real SPEC — the self-clean gate)
5. Manual: built CLI in a /tmp fixture — init-style settings with cursor enabled → upgrade materializes .cursor/rules/forge-context.mdc with frontmatter-first + inlined context → second run no-op; `spec-diff --all-active --json` parses.
6. Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8.

## Commit skeleton

```
feat(hosts): Cursor host + doctor symbol drift + ship-time SPEC signal — FORGE-160/131/164

FORGE-160: cursor AgentKind — .cursor/rules/forge-context.mdc (alwaysApply,
  inlined methodology, gitignored), .agents/skills canonical farm +
  .cursor/agents, beta-gated primary dispatch (cursor_host_beta_opt_in)
  via subprocess CursorHarness; design memo committed (user-approved A/B/C)
FORGE-131: doctor --scope spec-code detects exported-name drift — backtick
  spans shape-filtered + base/settings allowlists, missing_symbol drift
  entries, exit-2 semantics unchanged, self-clean on forge's own SPEC
FORGE-164: spec-diff --all-active lists active claims predating spec/
  changes; /ship surfaces a SPEC-changes PR section (informational, no gate)
```
