# FORGE-207 — guard the migrate rename codemod (guards-only, user decision 2026-06-12)

**Branch:** `feat/FORGE-207-codemod-guards` (rename from feat/FORGE-207 if needed) · **Worktree:** `.forge/worktrees/FORGE-207`
**User decision:** Option (c) "Guards only" — keep auto-rewriting, but (1) skip path classes that exist to mention old names, (2) add a line-level self-replace guard. NOT chosen: demote-to-warnings (a), opt-in flag (b).

## Where

All changes in `src/cli/migrate/drift-detect.ts` (findings producer — both `forge migrate` and any other consumer inherit the fix; `migrate.ts` apply path unchanged).

## Change 1 — guarded path classes (skip rewrite, emit warning finding instead)

New const next to SCAN_DIRS:
```ts
// Paths whose JOB is to mention old command names — historical records,
// design docs discussing renames, and deprecation-alias skills. Rewriting
// them produces self-referential nonsense ("X is deprecated — use X").
const REWRITE_GUARD_DIRS = ['docs/retros', 'docs/plans'];
const REWRITE_GUARD_SKILLS = ['skills/push-to-linear']; // alias dirs named after a rename SOURCE
```
In `detectCommandRefs`, for each scanned file: if its repo-relative path is under a guard prefix, DO run `rewriteCommandRefs` for detection counts, but emit a `class: 'warning'` finding (no `edit`) instead of the `actionable` one, e.g. detail: `mentions renamed command(s) (<parts>) — left untouched: historical/alias content (FORGE-207)`. The `dropped-verbs-removed` warning branch is already edit-free; leave it.

**Path matching MUST be segment-boundary** (pre-review major): normalize `\` → `/`, then `rel === guard || rel.startsWith(guard + '/')`. A bare `startsWith(guard)` would wrongly guard siblings like `docs/retrospective/` or `skills/push-to-linear-old/`. Add a small `isUnderGuard(rel, guards)` helper + unit tests for the sibling cases.

## Change 2 — line-level self-replace guard inside `rewriteCommandRefs`

Rework `rewriteCommandRefs` to operate per line: for each rename pair (PUSH_TO_LINEAR → '/push-to-tracker', ORCHESTRATE_NEXT → 'forge … orchestrate … claim', SUGGEST_NEXT → 'phases --ready'), skip any LINE that already contains the replacement target ('/push-to-tracker'; /\borchestrate\s+claim\b/; 'phases --ready'). Rationale: a line containing both old and new name is, by construction, prose ABOUT the rename ("use Y instead of X") — rewriting it yields "use Y instead of Y".
- Counts (`pushToLinear`, `renamedNext`, `renamedSuggest`) must count only rewrites actually performed.
- **Skipped-line visibility** (pre-review minor, adopted): add a `selfReplaceSkipped` counter to TextRewriteResult — lines that matched an old name but were skipped because the replacement target was already present. Surface it in the finding detail (`· N line(s) left untouched (mention both old and new name)`) so the blind spot is visible, not silent. Accepted trade-off: such lines are never auto-retired; that's the point of guards-only.
- `removedVerbs` detection unchanged (it never rewrites).
- Preserve line endings EXACTLY — split retaining separators with `/(\r\n|\n|\r)/` (lone `\r` included, not just `\r?\n`) — byte-identical output for untouched content is REQUIRED (migrate.ts compares `current !== f.edit.before` and the diff preview shows noise otherwise).
- `rewriteCommandRefs` is exported and unit-tested — update existing tests where behavior intentionally changed; do not weaken unrelated assertions.

## Tests (extend existing drift-detect/migrate test files)

1. Deprecation-alias fixture: a file containing `"/push-to-linear is deprecated — use /push-to-tracker"` → NO rewrite of that line (self-replace guard), even outside guarded dirs.
2. Historical fixture: `"Rename /push-to-linear → /push-to-tracker"` → untouched.
3. Guarded-dir fixture: file under `docs/retros/` with a genuinely stale ref (`/push-to-linear` alone on a line) → no `edit` in finding; finding class is `warning`; file content untouched after a full migrate apply run.
4. Unguarded stale ref still rewrites: `docs/guide.md` line `run /push-to-linear to sync` → rewritten to `/push-to-tracker`, counted, actionable finding with edit (regression: convenience preserved).
5. Mixed file: guarded line + rewritable line in one unguarded file → only the rewritable line changes.
6. skills/push-to-linear/SKILL.md fixture: untouched entirely (guard dir class).
7. CRLF preservation: a CRLF file with one rewrite keeps CRLF on all lines.
8. Forge-repo end-to-end shaped test (unit-level fixture mimicking the real four files) asserting zero edits across all four.

## Acceptance mapping (ticket ACs under guards-only)

- "migrate on forge repo itself → zero modifications to tracked skills/docs": the four real-world corruption sites all fall under REWRITE_GUARD_* or self-replace — covered by tests 1/2/3/6/8.
- "no rewrite without consent": NOT adopted (user chose guards-only); ticket AC satisfied in amended form — guarded classes warn instead of rewrite; note this explicitly in the PR body and Linear comment.
- Backup + dry-run behavior unchanged (no changes to migrate.ts).
- Ships in 0.4.1 (release cut after this merges).

## Gates

typecheck · full test suite 0 fail · lint · build + doctor spec-code `drift: []` · manual: run built CLI `migrate --dry-run` inside a fixture repo AND inside the forge worktree itself → planned changes must NOT include docs/skills rewrites.
Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8 gate.

## Commit skeleton

```
fix(migrate): guard rename codemod against alias/historical docs — FORGE-207

- docs/retros/, docs/plans/, skills/push-to-linear/ are detection-only:
  warning findings, never auto-rewritten
- line-level self-replace guard: a line already containing the replacement
  target is prose about the rename and is never rewritten
- counts reflect performed rewrites only; CRLF/byte-identical untouched lines
```
