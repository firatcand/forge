---
name: update-spec
description: Draft an ephemeral ADR for an in-flight architectural decision (--draft), then propagate the accepted decision to SPEC + PRD + phases.yaml + tracker bodies atomically (--apply <slug>) via the apply-decision verb's resumable journal.
tools: Read, Write, Edit, Bash(*)
---

# /update-spec

Two modes, one lifecycle (ephemeral ADRs — see `.forge/CONTEXT.md` §Ephemeral ADR workflow):

- `--draft` — interview → write `spec/decisions/<YYYY-MM-DD>-<slug>.md` from `templates/adr.template.md`. The user reviews, optionally gets a second opinion, and flips `status: accepted` by hand.
- `--apply <slug>` (+ `--yes-all`, `--resume`, `--dry-run`) — author the payload-complete journal, preview every artifact diff, then delegate ALL mutation to `forge orchestrate apply-decision`. On success the skill (not the verb) runs the git commit with the ADR's rationale as the body.

Skill ↔ verb contract: this skill owns interviews, diff previews, confirmations, journal authoring (the verb's documented upstream input), and git. The verb owns every artifact mutation, the resumable journal state machine, INDEX.md, and ADR deletion. The skill NEVER edits SPEC/PRD/phases/tracker directly.

---

## Mode `--draft`

### Preflight

1. `templates/adr.template.md` must exist. Missing → stop: "run `forge migrate` (or `forge upgrade`) to restore the bundled scaffold."
2. **One decision at a time.** Scan `spec/decisions/*.md` and classify each file:
   - `INDEX.md` → ignore (the durable decision index).
   - ADR frontmatter parses with `status: proposed` or `status: accepted` → refuse:
     ```
     ✗ /update-spec --draft: an active ADR already exists: <file> (status: <status>).
       Finish it first: /update-spec --apply <slug>   (or edit/delete the draft)
     ```
   - `status: rejected` → refuse with: "delete the rejected ADR manually (SPEC lifecycle: rejected ADRs are removed by hand, never applied or replaced)."
   - **Filename matches the ADR shape `<YYYY-MM-DD>-<slug>.md` but the frontmatter is missing or unparseable → REFUSE** ("malformed ADR — fix or remove it first"). A broken ADR must not be silently treated as a companion note and bypassed.
   - Anything else (no ADR-shaped name, no frontmatter — e.g. companion `*.plan.md` notes) → ignore; companions never block.

### Interview

Collect via AskUserQuestion batches (≤4 per call):

| Field | Constraint |
|---|---|
| Title | becomes the H1 and the slug |
| Slug | kebab-case `^[a-z0-9-]+$`; derived from title, user-overridable. **Collision check**: no existing `spec/decisions/*-<slug>.md` AND no `.forge/orchestrator/global/update-spec-apply-journal/completed/<slug>.json` (an already-applied slug must not be resurrected — the verb would report `already_applied` and refuse to redo). |
| Context | what triggered this decision |
| Decision | what we decided |
| Consequences | positive + negative, downstream changes |
| Alternatives considered | options + rejection reasons |
| `affected_spec_sections` | refs like `spec/SPEC.md §CLI surface` or `spec/SPEC.md#cli-surface` — `§Heading` is slugified GitHub-style; the section must exist (verify the heading resolves before writing the ADR) |
| `affected_prd_sections` | same formats against `spec/PRD.md` |
| `affected_phases_tasks` | phases.yaml task ids (`P2.5-T04` shape) whose `description`/`acceptance` change |
| `affected_tasks` | tracker issue ids (e.g. `FORGE-95`) whose BODIES the apply will rewrite — **authoritative scope**: at apply time the journal's `tracker_issues` ids must be a subset of this list (the verb doesn't coverage-gate tracker entries, so this declaration is the only thing bounding them). Include the tracker ids of any `affected_phases_tasks` whose bodies need syncing too |

### Write + handoff

1. Copy `templates/adr.template.md` → `spec/decisions/<YYYY-MM-DD>-<slug>.md`, fill frontmatter (`status: proposed`, today's date) and the four body sections from the interview.
2. Print the handoff:
   ```
   ✓ ADR drafted: spec/decisions/<date>-<slug>.md (status: proposed)
     Review it, edit freely, then flip `status: accepted` to unlock /update-spec --apply <slug>.
   ```
3. End with the second-opinion hook (silent under `FORGE_AUTO_SECOND_OPINION=0` or settings `second_opinion.auto_enabled: false`):
   ```bash
   forge second-opinion suggest update-spec
   ```
   (Emits `💡 Suggested next: /second-opinion review-decision …` — `/codex` is its deprecated alias.)

---

## Mode `--apply <slug>`

### Step 0 — Recovery check, THEN resolve + gate

**Completed-archive check comes FIRST** — a fully-applied slug has its ADR already deleted, so demanding the ADR up front would make crash recovery unreachable:
- `.forge/orchestrator/global/update-spec-apply-journal/completed/<slug>.json` exists → this is the recovery path: skip ADR resolution entirely, run the journal-trust gate's canonical-file rules on the completed journal, then jump to the `already_applied` decision tree in Step 3's table (commit-detection → footprint-bounded Step 4 or no-op).
- No completed archive → normal path: resolve the ADR (`spec/decisions/<date>-<slug>.md`, suffix match on `-<slug>.md`).

Read the ADR. `status` ≠ `accepted` → refuse with a friendly message (the verb re-gates authoritatively; this is just better UX). Frontmatter must parse; every `affected_*` ref must resolve (file + heading / task id) — fix the ADR first otherwise.

**Canonical-file gate (security):** `affected_spec_sections` refs MUST target exactly `spec/SPEC.md` and `affected_prd_sections` exactly `spec/PRD.md`. Any other file in a ref (an edited/adversarial ADR could point at arbitrary in-repo markdown) → refuse the whole apply before authoring anything. The same two paths are the ONLY files Step 4 may stage for section entries.

**Journal-trust gate (security):** the gate applies to JOURNAL content too, not just the ADR — a resumed or hand-edited journal is untrusted input. Whenever a journal already exists (active OR the completed archive consulted by the already_applied path), validate before any preview/apply/staging:
- every `spec_sections[].ref` file-part === `spec/SPEC.md`; every `prd_sections[].ref` === `spec/PRD.md`;
- the journal's section/phases refs are exactly the ADR-declared sets — coverage (verb-side) only checks declared ⊆ journal; the skill enforces journal ⊆ declared, so EXTRA smuggled entries are refused;
- **`tracker_issues[].id` ⊆ the ADR's `affected_tasks`** — the verb treats tracker entries as authoritative and never coverage-gates them, so this subset check (plus the declaration being authoritative at draft time) is what stops a hand-edited journal from rewriting undeclared tracker issues, even under `--yes-all`;
- `slug` matches, `phases_tasks[].id` are valid task ids.
Any violation → stop; the user inspects/deletes the journal and re-runs.
(When the ADR is already deleted — recovery path below — the declared-set equality checks are impossible and unnecessary: the canonical-file rules structurally bound the local footprint to `spec/SPEC.md`, `spec/PRD.md`, `plans/phases.yaml`, `spec/decisions/INDEX.md`, and the ADR path, and recovery never touches the tracker.)

**Clean-target gate (commit hygiene):** before the FIRST mutation (the initial verb run), `spec/SPEC.md`, `spec/PRD.md`, and `plans/phases.yaml` (when `phases_tasks` is non-empty) must be CLEAN in `git status`. Refuse otherwise — pre-existing edits would later be indistinguishable from the propagation and ride into its commit under the ADR's rationale.

### Step 1 — Author the journal (skip when it already exists)

Journal path: `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`.

- **Exists** → this is a resume/retry: do NOT re-author. Jump to Step 2 with the existing journal (its `applied` entries are skipped by the verb; `pending`/`failed` re-run).
- **Absent** → author it payload-complete. The verb is a MECHANICAL applier: every entry carries the exact bytes to write; nothing is synthesized verb-side.

For each `affected_spec_sections` / `affected_prd_sections` ref:
1. Read the CURRENT section: between `<!-- forge:adr-section:<anchor> -->` markers if present (a previously-applied section), else from the matching heading to the next heading of equal-or-higher level (or EOF).
2. Synthesize the post-decision replacement. `new_body` = the FULL section **including the heading line** (replaceManagedSection contract; ≤200k chars).

For each `affected_phases_tasks` id: one entry per changed field — `field: "description"` takes a string, `field: "acceptance"` takes a non-empty string[].

For tracker propagation: one entry per tracker issue whose body must change — full replacement body, NO `<!-- forge:KEY=... -->` comments (adapters own footers and reject such input).

**Complete worked example** (all four arrays present even when empty; `started_at` ISO-8601; journal `slug` MUST equal the requested slug):

```json
{
  "version": 1,
  "slug": "switch-tracker-transport",
  "started_at": "2026-06-11T12:00:00.000Z",
  "spec_sections": [
    {
      "ref": "spec/SPEC.md#cli-surface",
      "new_body": "## CLI surface\n\n(the full rewritten section body…)",
      "status": "pending"
    }
  ],
  "prd_sections": [],
  "phases_tasks": [
    {
      "id": "P2.5-T04",
      "field": "acceptance",
      "value": ["new criterion 1", "new criterion 2"],
      "status": "pending"
    }
  ],
  "tracker_issues": [
    {
      "id": "FORGE-95",
      "new_body": "(full replacement issue body, no forge:* comments)",
      "retries": 0,
      "status": "pending"
    }
  ],
  "finalize": {
    "commit_msg_written": false,
    "index_appended": false,
    "adr_deleted": false,
    "archived": false
  }
}
```

Coverage gate: the verb refuses (`JOURNAL_COVERAGE_MISMATCH`) unless every ADR-declared `affected_spec_sections`/`affected_prd_sections`/`affected_phases_tasks` ref has a covering journal entry. Never drop an entry to dodge a rejection — see Step 2.

### Step 2 — Per-artifact diff preview + confirmation

For EVERY journal entry show a current → new diff (section text / task field / issue body) and ask the user to confirm. `--yes-all` skips these confirmations (**skill-side semantics only** — the verb parses `--yes-all` but applies unconditionally either way; the journal content IS the decision).

**User rejects an artifact** → STOP before any mutation. Recovery paths:
- The synthesized content was wrong → rewrite that journal entry's `new_body`/`value` in place (it is still `pending`; the journal is yours until the verb runs), re-preview.
- The SCOPE was wrong (section shouldn't change at all) → edit the ADR's `affected_*` lists AND delete the authored journal, then re-run `--apply` (coverage gate forbids a journal that skips a declared ref).

### Step 3 — Dry-run / apply

```bash
# optional preview of the verb's own plan (also the right move with --resume):
forge orchestrate apply-decision <slug> --dry-run --json
# real apply:
forge orchestrate apply-decision <slug> --json [--yes-all] [--resume]
```

`--resume` on the skill = journal already exists; pass `--resume` through. (The verb resumes implicitly from entry statuses; the flag is declarative intent.) `--resume --dry-run` together is valid: reuse the journal, run the verb with BOTH flags, report the remaining plan, stop.

Envelope handling:

| Result | Action |
|---|---|
| `ok` + `data.applied: true` | → Step 4 |
| `ok` + `data.already_applied: true` | a prior run finished the PROPAGATION — but the commit is skill-side and may be missing (crash window). Recovery decision tree: (1) `git log --grep "^spec: apply decision <slug>$" -n 1` finds the apply commit → pure no-op, report and stop. (2) No commit found → load `completed/<slug>.json`, run the journal-trust gate on it, derive the footprint, and check `git status` on EXACTLY those paths: dirty → Step 4 once; clean → no-op. Never commit when (1) matched — a second dirty state means unrelated work, not a lost apply |
| `fail APPLY_FAILED` (retriable) | print `data.failed` ref + applied-count; instruct: fix the cause (e.g. tracker auth), then `/update-spec --apply <slug> --resume` |
| `fail ADR_NOT_ACCEPTED` | flip the frontmatter after review, re-run |
| `fail JOURNAL_COVERAGE_MISMATCH` | `data.missing` lists uncovered refs — author those entries (Step 1), re-run |
| `fail TRACKER_INCAPABLE` | tracker can't rewrite bodies (Notion pre-FORGE-117). Do NOT just delete the tracker entries — `affected_tasks` isn't coverage-gated, so the apply would finalize and the declared tracker updates would be silently lost forever. Either wait for tracker capability, or make the scope reduction EXPLICIT: edit the ADR's `affected_tasks`, delete the journal, re-run `--apply` with a full re-preview |
| `fail ADR_NOT_FOUND / ADR_AMBIGUOUS` | check the slug against `spec/decisions/` |

### Step 4 — Commit (skill-side; the verb NEVER runs git)

The verb wrote the rationale (the full ADR body, headings included) to
`.forge/orchestrator/global/update-spec-apply-journal/<slug>.commit-msg.txt`.

1. Build the final message in a NEW temp file (never mutate the verb's file — retries must stay idempotent):
   ```bash
   { printf 'spec: apply decision <slug>\n\n'; cat .forge/orchestrator/global/update-spec-apply-journal/<slug>.commit-msg.txt; } > /tmp/update-spec-<slug>-commit.txt
   ```
2. Stage EXACTLY the journal's footprint — never a blanket `spec/` (unrelated in-flight work must not ride along):
   - each distinct file from `spec_sections`/`prd_sections` refs
   - `plans/phases.yaml` iff `phases_tasks` is non-empty
   - `spec/decisions/INDEX.md` (the verb appended the durable line)
   - the deleted ADR path (`git add` records the deletion)
3. **Staged-patch audit:** before committing, review `git diff --cached --stat` — it must list ONLY the footprint files, and the staged hunks must correspond to the confirmed journal entries (spot-check section anchors / task ids). Anything else staged → unstage, investigate; never commit a superset under the ADR's rationale. (The clean-target gate makes this audit a formality in the happy path.)
4. Commit with verbatim cleanup — the body is markdown and `#` heading lines must survive:
   ```bash
   git commit --cleanup=verbatim -F /tmp/update-spec-<slug>-commit.txt
   ```
5. Verify + report: ADR file gone, INDEX has the `<slug>` line, journal archived under `completed/`:
   ```
   ✓ /update-spec --apply <slug>: N artifact(s) propagated · ADR deleted · rationale in commit <sha>.
   ```

## Edge cases

- **Re-running `--apply` after full success**: verb returns `already_applied`; the envelope row above decides — commit exactly once if the footprint is dirty, else pure no-op.
- **`--draft` with an active ADR present**: refused (see preflight) — one decision in flight, ever.
- **Rejected ADR in `spec/decisions/`**: never applied, never auto-deleted — the user removes it manually (SPEC lifecycle).
- **phases.yaml edits**: only `description`/`acceptance` are amendable via the journal. Scope changes (new tasks) are `/amend-roadmap`'s job; status is the tracker's.

## Output template

```
✓ /update-spec --draft: spec/decisions/<date>-<slug>.md written (status: proposed).
✓ /update-spec --apply <slug>: N artifact(s) propagated · ADR deleted · rationale in commit <sha>.
```
