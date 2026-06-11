# Batch 3 — schema caps & validation UX (FORGE-83, FORGE-120, FORGE-175, FORGE-176, FORGE-177)

**Branch:** `feat/hardening-schema-caps` · **Worktree:** `.forge/worktrees/FORGE-83`
**User decisions (2026-06-11):** FORGE-83 = enforce true UTF-8 byte caps (+ byte-safe truncation helper). FORGE-177 = add `'human'` to OWNER_TYPES, doc-only dispatch semantics (no TASK_DISPATCH_POLICY enum).

## FORGE-83 — UTF-8 byte caps on attempt/verdict string fields

New module `src/schemas/byte-bounded.ts` (schemas dir; both schema files import it):
- `byteBoundedString(maxBytes: number, opts?: { min?: number })` → `z.string().min(opts?.min ?? 0).max(maxBytes).refine(s => Buffer.byteLength(s, 'utf8') <= maxBytes, { message: \`must be <= ${maxBytes} UTF-8 bytes\` })`. The `.max` stays as a cheap pre-filter — UTF-8 bytes ≥ UTF-16 units always, so it never rejects anything the refine would allow. **MUST preserve existing `.min(1)` constraints** — fields that currently require non-empty (attempt.ts `autonomous_decision.reason`, `attempt_cancelled.reason`; verdict.ts `summary`, `findings[].message`) pass `{ min: 1 }`. Audit each converted field's current min before replacing.
- `truncateUtf8(s: string, maxBytes: number): string` — byte-safe truncation that never splits a code point (and never splits a surrogate pair). Must be correct for emoji (4-byte), CJK (3-byte), combining marks at the boundary. Implementation freedom, but include boundary tests.

Apply `byteBoundedString(N)` to the byte-budget-critical fields ONLY (identifier-ish fields keep plain `.max`):
- `src/schemas/attempt.ts`: `tests_run.output_excerpt` (2048, line 39), `lint_run.output_excerpt` (2048, line 46), `commit.message_excerpt` (200, line 52), `autonomous_decision.reason` (2000, line 74), `attempt_cancelled.reason` (1000, line 84).
- `src/schemas/verdict.ts`: `summary` (4000, line 6), `tests.output_excerpt` (2048, line 13), `lint.output_excerpt` (2048, line 19), `save_point` (8000, line 22), `findings[].message` (2000, line 35).
- Keep plain `.max`: Id(64), head_sha(40), decision_key, chosen_option_id, path, matched_glob, suggested_decision_key, branch, findings[].path.

Fix the mislabeled enforcement in `src/harnesses/verdict-parser.ts`:
- Line 56 `trimmed.slice(0, MAX_FINDING_MESSAGE_BYTES)` counts UTF-16 units, not bytes → use `truncateUtf8(trimmed, MAX_FINDING_MESSAGE_BYTES)`. (This feeds `findings[].message`, which now byte-validates — char-slice could otherwise produce an invalid synthesized verdict.)
- Line 25 `fenced[1].slice(0, 2000)` feeds a HarnessError detail (not schema-validated) — switch to `truncateUtf8` for consistency.

Producers (CORRECTED by pre-review): two CLI paths build capped fields from user/CLI input BEFORE appendAttemptEvent validation and must truncate byte-safely instead of erroring:
- `src/cli/orchestrate/cancel.ts` — builds `attempt_cancelled.reason` (cap 1000) from the `--reason` flag → wrap with `truncateUtf8(reason, 1000)`.
- `src/cli/orchestrate/question-write.ts` — builds `autonomous_decision.reason` (cap 2000) → wrap with `truncateUtf8(…, 2000)`.
- Audit for any sibling sites feeding other converted fields (grep appendAttemptEvent callers) and apply the same pattern.

Back-compat decision (explicit): NO migration for previously stored state. Old `verdict.json` / `events.jsonl` entries whose multibyte strings exceed the byte cap will now fail re-parse (gc reverify, event reads). Accepted because forge's own producers emit ASCII excerpts and the caps were generous; the failure mode is an ok:false read of an already-terminal artifact. Add one regression test DOCUMENTING this: an over-byte-cap stored verdict fails VerdictSchema.parse — named so readers see it's intentional (e.g. "byte caps: pre-existing oversized multibyte state fails re-parse by design (FORGE-83)").

Tests (new `test/unit/schemas/byte-bounded.test.ts` + extensions to attempt/verdict schema tests):
- all-emoji string within char cap but over byte cap → REJECTED (e.g. 1100 × '😀' = 2200 units > 2048? no — pick 600 emoji = 1200 units ≤ 2048 but 2400 bytes > 2048 → rejected).
- CJK string over byte cap → rejected; ASCII at exactly N bytes → accepted.
- `truncateUtf8`: never splits a code point; result always ≤ maxBytes; idempotent on short strings; emoji-at-boundary case.
- verdict-parser: oversized non-ASCII fallback message still produces a schema-valid ReviewVerdict.

## FORGE-120 — TaskSchema.status enum (verify + close the test gap)

Already shipped in code: `TASK_STATUSES` (phases.ts:52) + `TaskStatus` type (line 237) + `z.enum(TASK_STATUSES)` (line 69) — covers the ticket's enum AC plus `'done'`. ONLY remaining AC: a rejection test. Add to `test/unit/phases.schema.test.ts`: TaskSchema rejects `status: 'foo'`. Note pre-done state in PR body.

## FORGE-175 — decompose skill emits acceptance_criteria

- `skills/decompose/SKILL.md:35`: `acceptance_criteria` → `acceptance`.
- `agents/product-decomposer.md:14`: same rename.
- Same-class bug, same line region (decompose SKILL.md:30): skill lists `type (foundation | data | backend | frontend | design | infra | content | integration)` but TaskSchema enum is `foundation|data|backend|integration|content|infra|skill|docs` — fix the skill's list to match the schema (drop frontend/design, add skill/docs). This is in-scope per the ticket's "and any other references" + its root cause (skill prose disagreeing with validator).
- Do NOT add the CI example-validation check (ticket marks optional; separate concern).
- templates/phases.template.yaml already correct (`acceptance:`), no change.

## FORGE-176 — surface ZodError issues[] through PHASES_PARSE_ERROR

Verified: `loadPhases` (src/core/phases.ts:62–70) already throws `PhasesError('SCHEMA_INVALID', …, { path, issues: err.issues })`. The gap is `src/cli/orchestrate/phases.ts:88–98`, which calls `fail('PHASES_PARSE_ERROR', msg, false)` WITHOUT details.

Fix in phases.ts catch:
- If `err instanceof PhasesError` and `err.details.issues` is present, map issues to `{ path: issue.path.join('.'), code: issue.code, message: issue.message }` and pass as `fail(…, { issues })` → lands at `error.details.issues` in the --json envelope (envelope's `details?: Record<string, unknown>` already supports this; do NOT change the envelope shape).
- Human (stderr) form: envelope.ts never renders details, so compose the issues into the MESSAGE in phases.ts: `phases schema validation failed: <path>\n  - phases.0.tasks.0.acceptance: Required\n  - …` (one bullet per issue, cap at ~20 issues with a "+N more" tail to avoid stderr floods).
- Tests: feed an invalid phases.yaml through the phases verb (unit-level, fixture-based like existing phases verb tests): assert --json envelope contains `error.details.issues[0].path === 'phases.0.tasks.0.acceptance'`-style entries, and human message contains the bulleted line. Both modes.
- Do not touch claim.ts / render-worker-prompt.ts loadPhases call sites (different surfaces, out of ticket scope).

## FORGE-177 — add 'human' to OWNER_TYPES

- `src/schemas/phases.ts:3–12`: add `'human'` to OWNER_TYPES.
- `spec/SPEC.md:355` (just-refreshed §phases.yaml snippet): add `'human'` to the owner_type enum line. Immediately after the snippet's superRefine prose, add one sentence: tasks with `owner_type: 'human'` are never auto-dispatched by the orchestrator — they appear in the queue as documentation/checkpoints for manual work (account provisioning, OAuth consent, secrets placement).
- `skills/amend-roadmap/SKILL.md:30`: add `human` to the enumerated owner list.
- `skills/decompose/SKILL.md:34`: extend `owner_type` bullet with `(use 'human' for manual bootstrap work — never auto-dispatched)`.
- ENFORCEMENT (added per pre-review): doc-only is insufficient — `phases --ready` feeds the dispatch loop (forge-orchestrate skill step 3 claims/dispatches whatever --ready returns), so a human task would get auto-dispatched. Fix: `src/cli/orchestrate/phases.ts` `--ready` mode EXCLUDES `owner_type: 'human'` tasks from the dispatchable list and reports them separately (e.g. `human_checkpoints: [...]` in --json, a "⏸ human checkpoint (not dispatchable)" line in human output) so they stay queue-visible per the chosen semantics. Plain `phases` (no --ready) still lists them normally.
- Test: phases schema accepts `owner_type: 'human'`; `phases --ready` excludes a ready human task from the dispatchable set and surfaces it in the checkpoint list; existing OWNER_TYPES-derived tests still pass.
- Out of scope (note in PR): TASK_DISPATCH_POLICY enum (user declined).

## Gates

1. `npm run typecheck` clean · 2. `npm test` 0 fail (expect +~10 tests) · 3. `npm run lint` clean
4. `npm run build` + `node dist/bin/forge.cjs orchestrate doctor --scope spec-code --json` → `drift: []`
5. Manual: `node dist/bin/forge.cjs orchestrate phases --json` against a broken fixture shows issues[]
6. Implementer: Opus 4.8 (code-heavy batch). Cross-review: GPT 5.5 (codex, read-only), ≥8 gate.

## Commit skeleton

```
fix(schemas): schema caps & validation UX batch — FORGE-83/120/175/176/177

FORGE-83: UTF-8 byte caps via byteBoundedString refine + truncateUtf8 helper;
  verdict-parser slice was UTF-16-unit-based despite BYTES name — fixed
FORGE-120: TASK_STATUSES enum verified shipped; added missing garbage-status
  rejection test
FORGE-175: decompose skill + product-decomposer agent emit `acceptance` (was
  acceptance_criteria); type enum list corrected to match TaskSchema
FORGE-176: PHASES_PARSE_ERROR now surfaces ZodError issues[] — bulleted in
  human stderr, structured at error.details.issues in --json
FORGE-177: OWNER_TYPES gains 'human' (never auto-dispatched; SPEC documents
  semantics); amend-roadmap + decompose skill prose updated
```
