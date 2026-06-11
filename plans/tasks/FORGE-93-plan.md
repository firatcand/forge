# FORGE-93 — `/update-spec --draft|--apply` skill (two modes)

> Status: draft for Codex pre-opinion · Attempt 019eb65f-1752-722c-ac38-31af47c56c67
> No user-decision forks: the verb contract (apply-decision, FORGE-95), the ADR machinery (adr.ts, markdown-section.ts, apply-journal.ts), the design doc (closed-loop-workflow-redesign.md §419-443, §914-918), and SPEC §997 (auto-codex line) pin every behavior. Re-scope treatment (stale "FORGE-93 still v0.5" language + v0.5 label) follows the FORGE-101 precedent the user already approved.
> AC nuance: ticket says suggest "/codex review-decision"; /codex is the deprecated v0.4 alias — SPEC:997 prescribes `💡 Suggested next: /second-opinion review-decision`, and codex-suggest's EVENT_TO_VERB already reserves `update-spec → review-decision`. The skill ends with `forge codex-suggest update-spec` (no CLI change needed).

## What ships

| Artifact | Path |
|---|---|
| Skill | `skills/update-spec/SKILL.md` (two modes, one file) |
| Registry | `src/cli/registry.ts` SLASH_COMMANDS += update-spec (CONTEXT.md renderer) |
| Template sync | `templates/CONTEXT.template.md:54` — "FORGE-93 (still pending)" → shipped |
| Spec sweep | SPEC/PRD stale-deferral qualifiers (SPEC 17, 18, 90, 136, 608, 843, 922, 960, 994; PRD 15, 19, 55, 70, 121, 295, 414, 669) — only deferral QUALIFIERS change; flow descriptions stay |
| Tracker | FORGE-93 description AC note (codex→second-opinion naming) + v0.5 label removal |

Skill↔verb contract: the skill owns interviews, diff previews, confirmations, journal AUTHORING (the verb's documented upstream), and the git commit; ALL artifact mutation flows through `forge orchestrate apply-decision`.

## Mode `--draft`

1. Preflight: `templates/adr.template.md` exists (else: run `forge migrate`); **refuse if any non-INDEX `*.md` already in `spec/decisions/`** ("one decision at a time", design §419-443) — print the existing draft's slug + next steps.
2. Interview (AskUserQuestion batches): title → kebab slug (validate `^[a-z0-9-]+$`, collision-check against `spec/decisions/` AND the completed-journal archive), Context / Decision / Consequences / Alternatives, affected lists with format guidance:
   - `affected_spec_sections` / `affected_prd_sections`: `"spec/SPEC.md §Heading"` or `"spec/SPEC.md#anchor"` (parseSectionRef formats; slugified per slugifyHeading)
   - `affected_phases_tasks`: `P\d+(\.\d+)?-T\d+[a-z]?` ids; `affected_tasks`: tracker ids
3. Write `spec/decisions/<YYYY-MM-DD>-<slug>.md` from the template, frontmatter `status: proposed` filled, body sections from the interview.
4. Print the review path: user reads, optionally edits, flips `status: accepted` when ready.
5. End: `forge codex-suggest update-spec` (emits the SPEC:997 suggestion line; silent under FORGE_AUTO_CODEX=0 / settings codex.auto_codex_enabled=false).

## Mode `--apply <slug>` (+ `--resume`, `--yes-all`, `--dry-run`)

1. Preflight: resolve the ADR (suffix-match rules per resolveAdrPath); pre-check `status: accepted` for a friendly refusal (the verb re-gates authoritatively).
2. **Author the payload-complete journal** at `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json` (skip if present — resume path; the verb validates):
   - For each `affected_spec_sections`/`affected_prd_sections` ref: read the CURRENT section (between forge:adr-section markers if present, else heading→next-same-or-higher-level-heading), synthesize the post-decision replacement, `new_body` = full section INCLUDING the heading line (replaceManagedSection contract), entry `status: pending`.
   - For each `affected_phases_tasks` id: `field` ∈ {description, acceptance} + new value (string vs string[] respectively).
   - For each `affected_tasks` tracker id: full replacement body (no forge:* footer comments — adapter owns those).
   - version: 1, slug, started_at.
3. **Per-artifact diff preview + confirmation** (skill-side, before the verb): for each journal entry show current→new diff; user confirms per artifact, or `--yes-all` skips. A rejected artifact = remove that entry? NO — coverage gate (assertCoverage) requires every ADR-declared ref to have a journal entry: a rejection means STOP, edit the ADR's affected lists or the synthesized body, re-run.
4. Optional `--dry-run`: run the verb with `--dry-run --json`, show its plan, stop.
5. Run `forge orchestrate apply-decision <slug> --json [--yes-all] [--resume]`. Parse envelope:
   - ok+applied → step 6. ok+already_applied → report idempotent no-op.
   - fail APPLY_FAILED (retriable) → print failed ref + `--resume` hint, stop.
   - fail ADR_NOT_ACCEPTED / JOURNAL_COVERAGE_MISMATCH / TRACKER_INCAPABLE → targeted guidance per code.
6. Commit (skill-side git — the verb never runs git): stage `spec/ plans/phases.yaml spec/decisions/INDEX.md` deletions/edits, `git commit -F .forge/orchestrator/global/update-spec-apply-journal/<slug>.commit-msg.txt` after prepending a conventional-commit subject `spec: apply decision <slug>`; verify ADR file deleted + INDEX line present; report.
7. `--resume`: journal exists → skip authoring, jump to step 5 with `--resume`.

## Tests

Skill is markdown (host-executed); deterministic surface covered by:
- registry conformance (SLASH_COMMANDS entry — existing registry.test.ts patterns; render-context test re-renders CONTEXT with the new command line).
- codex-suggest `update-spec` event — already covered by existing codex-suggest tests (EVENT_TO_VERB table); verify a test exists, add one if the reserved event is untested.
- Template line-54 change flows through existing render/upgrade tests.
No new runtime code ⇒ no new unit-test target beyond the above; the E2E exercise of the full skill lands with FORGE-110's harness.

## Risks / notes

- Journal authoring guidance must be precise enough that a host agent produces verb-valid JSON on the first try — include a complete worked example in the SKILL (real shapes for all four entry types).
- The completed-journal archive collision check on slugs prevents resurrecting an already-applied slug (verb would report already_applied and refuse to redo).
- INDEX.md is created by the verb on first apply; skill must not pre-create it.
