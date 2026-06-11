# Batch 2 — docs/spec sync (FORGE-137, FORGE-162, FORGE-124, FORGE-129, FORGE-68, FORGE-141)

**Branch:** `feat/hardening-docs-spec-sync` · **Worktree:** `.forge/worktrees/FORGE-137`
**Theme:** close spec↔code and docs gaps. One PR, six tickets, each with its own commit-message section.
**Decisions:** FORGE-124 = Decision **A** (pre-authorized by user in FORGE-105 Q2: "Drop budget, just ship disable switches"). FORGE-206 descoped from batch (user kept "Compound Learning" name, 2026-06-11).

## FORGE-137 — SPEC.md §Module layout: add `src/harnesses/`

- `spec/SPEC.md` lines 514–606 (untagged code fence, `//` comments, `// (added ...)` annotations).
- Insert a `harnesses/` subtree after `src/orchestrator/` (or alphabetic slot matching the block's existing order) listing all 7 files with one-line roles, annotated `// (added FORGE-88)`:
  - `base.ts` — IHarness contract + Subagent{Handle,Result}/HealthResult types + HarnessError
  - `claude.ts` — ClaudeHarness (primary-only; runReview NOT_SUPPORTED)
  - `codex.ts` — CodexHarness (primary or review; codex exec subprocess)
  - `gemini.ts` — GeminiHarness (experimental, env-gated)
  - `index.ts` — barrel + createHarness(host) factory
  - `subprocess.ts` — execa wrapper (timeout/stdout-cap/error classification)
  - `verdict-parser.ts` — fenced-JSON ReviewVerdict extractor + schema validation
- Note: the ticket's "v0.5 module additions footnote" does not exist in current SPEC.md (FORGE-133 audit text absent) — nothing to keep consistent; do NOT invent one.
- Gate: `node dist/bin/forge.cjs orchestrate doctor --scope spec-code --json` → `drift: []`; every `src/...ts` path referenced exists on disk.

## FORGE-162 — conflict table for authority-by-field

- `templates/CONTEXT.template.md` §Source of truth (lines 21–33). After the authority table + before/around the "Rule for AI agents" paragraph, add a small **Ambiguous-field conflict table**:

| Ambiguous field | Authority |
|---|---|
| task readiness / status | tracker |
| sequencing / dependencies / assignment | tracker |
| task acceptance criteria | PRD / phases.yaml snapshot |
| architectural constraints written into task text | SPEC |
| architecture / non-functional requirements | SPEC |

- One intro sentence: these fields overlap in practice; use this lookup instead of improvising.
- `.forge/CONTEXT.md` is generated (gitignored locally) — do NOT hand-edit it; after merge the orchestrator reruns `npm run forge:render-context` on main. Verify `src/cli/upgrade/render-context.ts` consumes the template file (not an inlined copy); if inlined, update that source too.

## FORGE-124 — Decision A: drop `auto_codex_token_cap`

Remove every trace from `src/` and `spec/`; `rg auto_codex_token_cap src spec` must return zero hits. In `test/`, the literal is allowed in EXACTLY ONE place: the legacy-tolerance regression test (named so grep readers see why), which feeds a settings.yaml containing the legacy key and asserts it parses cleanly and the key is ignored. All other test occurrences go. (plans/phases.yaml ticket-text mentions are allowed — they describe this task; reconcile owns that file.)

- `spec/SPEC.md:999` — delete the "Bounded by `codex.auto_codex_token_cap` (RESERVED …)" sentence; keep "Env var `FORGE_AUTO_CODEX=0` disables suggestions entirely."
- `spec/SPEC.md:314` — remove the field line from the settings-schema snippet.
- `spec/PRD.md:373` — remove the `auto_codex_token_cap: 50000` example line.
- `src/schemas/settings.ts:212,219` — remove RESERVED comment + field.
- **Parse-compat gate (AC):** adopter settings.yaml files scaffolded by ≤0.4.0 may carry the key. Check whether `CodexSchema`/parent objects use `.strict()`: if non-strict (zod default strips unknown keys) plain removal is safe; if strict, relax just enough that the stale key is tolerated-and-ignored (and add a test proving a settings.yaml WITH the legacy key still parses). Either way add that legacy-key regression test.
- `src/cli/migrate/drift-detect.ts:84` — remove from the defaults object (confirm what that object feeds; keep drift-detect behavior coherent).
- Tests: `test/unit/settings.schema.test.ts` (505/531/540/545/554/576 — drop cap assertions, drop negative/non-integer cap tests, update type assertion), `test/unit/cli/codex-suggest.test.ts` (33/39 — remove from helper/YAML), `test/unit/cli/migrate/migrate.test.ts` — the fixture at 522 AND the ripple sites: changing `SETTINGS_DEFAULT_BLOCKS.codex` (drift-detect.ts:84) also affects default-equivalence/migration assertions around lines 106–117, 190–199, 436–438; audit every `SETTINGS_DEFAULT_BLOCKS` consumer and update expected YAML/objects coherently.
- Record "Decision A" in the PR body section for FORGE-124.

## FORGE-129 — refresh stale `phases.yaml` zod snippet

- `spec/SPEC.md` 333–371: delete the stale pointer note (line 335) and replace the `ts` code block (337–371) with the CURRENT shape from `src/schemas/phases.ts`: SourceSchema (4 fields), TaskSchema (all 20 fields incl. lifecycle + write_globs + question_budget with hard≥soft refine), PhaseSchema (8 fields), PhasesSchema (project, tracker_url?, gate_check_command?, source?, phases).
- Keep it a doc snippet (trim long enum lists only if the block does so elsewhere — prefer exact). After the block, one prose sentence: `.superRefine` validates duplicate phase/task IDs, unknown `blocked_by`/`depends_on` targets, and DAG cycles (reports the cycle path). State `src/schemas/phases.ts` remains canonical in one trailing sentence (replacing the stale note).

## FORGE-68 — CONTRIBUTING.md clean-room smoke recipe

- `CONTRIBUTING.md` §Local validation ends line 80 ("All must pass cleanly."). Insert a `### Pre-push smoke (catches packaging bugs the regular checks miss)` subsection after it, per the ticket's markdown: why-line (devDeps runtime ≠ end-user install; tsdown externals — chalk incident, see `docs/learnings/2026-Q2/smoke-job-needs-external-deps-installed.md` if present, else cite FORGE-67), recipe `npm run build; rm -rf node_modules; npm ci --omit=dev; node dist/bin/forge.cjs --version; node dist/bin/forge.cjs --help`, restore note `npm ci`.
- Note: that learning file does not exist in-repo (docs/learnings is empty save .gitkeep) — reference FORGE-67/PR #91 instead of a dead path.

## FORGE-141 — stale FORGE-88.investigation.md

- Verified 2026-06-11: `/Users/firatdogan/repos/forge/plans/tasks/FORGE-88.investigation.md` does not exist (already removed in a prior wrap-up). docs/learnings has no FORGE-88 content to preserve. No pattern (zero `*.investigation.md` anywhere) → no /wrap-up step needed.
- Resolution: close with verification note. No code change in this PR.

## Gates (whole batch)

1. `npm run typecheck` clean
2. `npm test` — 0 fail (expect count to DROP by the removed cap tests, +1 legacy-key test)
3. `npm run lint` clean
4. `node dist/bin/forge.cjs orchestrate doctor --scope spec-code --json` → `drift: []` (run after `npm run build`)
5. `rg -n auto_codex_token_cap src spec` → zero hits; `rg -n auto_codex_token_cap test` → hits ONLY inside the single legacy-tolerance test
6. Cross-review: implementation by Claude (Sonnet 4.6) → review by GPT 5.5 (codex, read-only) with ≥8 gate

## Commit message skeleton

```
docs(spec): docs/spec sync batch — FORGE-137/162/124/129/68/141

FORGE-137: SPEC §Module layout gains src/harnesses/ subtree (7 files)
FORGE-162: CONTEXT template §Source of truth gains ambiguous-field conflict table
FORGE-124: Decision A — drop auto_codex_token_cap (SPEC/PRD/schema/tests; legacy-key tolerance test added)
FORGE-129: SPEC §phases.yaml schema snippet refreshed from src/schemas/phases.ts
FORGE-68: CONTRIBUTING gains clean-room pre-push smoke recipe
FORGE-141: verified stale investigation file already absent — no-op closure
```
