# Team-mode Minimum Architecture

**Status:** Approved 2026-05-17 (afternoon — supersedes the morning's `closed-loop-workflow-redesign.md`)
**Author:** Firat (with Claude + 4 rounds of Codex consults)
**Date:** 2026-05-17

> This doc supersedes `closed-loop-workflow-redesign.md` (same day, earlier). The earlier redesign added a closed-loop drift workflow with ephemeral ADRs, `/update-spec --draft|--apply`, `/amend-roadmap`, `/reconcile`, worktree drift guards, drift events, drift-routed questions, auto-codex hooks. After a team-collaboration thought experiment + four Codex stress-tests, the user explicitly pulled the design back to a minimum-viable shape. This is the locked architecture for v0.4.

---

## 1. Why this doc exists

The morning redesign was the right shape for a solo workflow. When stress-tested against a 5-person team, the design's "SPEC is local-truth, tracker is projection" precedence rule turned out to be a single-user assumption: each dev has their own local SPEC; the only real-time shared surface is the tracker.

Four design rounds explored the team-collaboration question:

1. **Round 1** — flip phases.yaml to tracker-as-truth (cache model). Codex: yes, call it a "local execution snapshot." Locked.
2. **Round 2** — tracker as "proposal surface" for architectural changes; SPEC catches up. Codex: adopt, but elevate "tracker edit" into a first-class proposal object with lifecycle, transactional promotion gate, journal.
3. **Round 3** — fast-path/slow-path: normal git for uncontested SPEC changes, proposal-object lifecycle only when contested. Codex: yes, but contradiction detection needs SPEC section tags, active worktree registry, revalidation gates, PR-policy modes.
4. **Round 4** — drop the gate entirely; trust standard git + team coordination. Codex: ship the minimum; the only correction is a confirmation prompt on missing `--affects`.

The user then pulled back **once more** beyond Round 4: drop the `--affects` declaration too. Standard git push, no gate, no declared-impact interlock. Engineers pull SPEC changes the same way they pull code changes.

**Product positioning crystallized:**
> Forge provides mechanism (scaffold + dispatch + sync), not policy (review rituals, conflict resolution, PR enforcement). Team coordination is the team's responsibility.

This matches forge's original BRIEF ethos: *"Forge suggests, never interrogates."*

---

## 2. The locked architecture

```
TRACKER (Linear / GitHub / Notion)
  └─ team's shared coordination surface
  └─ authoritative for: execution scope (tasks, status, assignments, deps)
        │
        │  bidirectional sync via /reconcile
        │  (mechanical projection, no semantic interpretation)
        ▼
GIT REPO  (git is the team-sync mechanism for canonical artifacts)
  ├─ spec/{BRIEF,PRD,SPEC,DESIGN,CONTEXT}.md     ← committed, NOT gitignored
  ├─ plans/phases.yaml                            ← derived snapshot (regenerated from tracker)
  └─ source code
        │
        │  standard git workflow: commit → push → others pull
        │  team owns: PR review, branch policy, conflict resolution
        ▼
WORKERS in worktrees
  ├─ stamp spec_revision at claim time
  └─ on resume: informational notification "SPEC changed since you claimed this ticket"
                                            (not gating; dev decides)
```

### 2.1 Authority by field

Different artifacts own different concerns:

| Artifact | Owns |
|---|---|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria |
| `plans/phases.yaml` | Local execution snapshot (derived from tracker) |
| Tracker issue body | Execution metadata: assignee, status, sequencing, live coordination |
| Source code | Implementation |

The morning redesign tried to encode this as a single linear precedence chain. It is not a chain. It is a matrix of ownership by field. When in doubt, ask "whose field is this?" not "which artifact ranks higher?"

### 2.2 phases.yaml as a derived snapshot

`plans/phases.yaml` becomes a generated artifact. Source of truth is the tracker.

- **Written by:** `/reconcile --pull` only. All other commands that change scope (`/decompose`, `/amend-roadmap` when shipped, `/push-to-tracker`) write to the tracker first, then trigger reconcile.
- **Read freshness:** every command that reads phases.yaml prints a freshness line: `phases.yaml: synced 47min ago against linear@rev_abc123`. Not auto-sync; just no pretending freshness.
- **Hand edits:** allowed in the sense that nothing stops you, but overwritten on next reconcile. Use `/amend-roadmap` (when shipped) or edit the tracker directly.
- **Storage:** committed to git for audit trail + PR-visible scope diff.
- **Source metadata stanza** (Codex round 1):
  ```yaml
  source:
    tracker: linear
    project_id: ...
    synced_at: 2026-05-17T15:30:00Z
    tracker_revision: rev_abc123
    spec_revision: <git sha or content digest>
  ```

### 2.3 SPEC changes — no gate

Architectural changes flow through standard git. Dev edits `spec/SPEC.md`, commits, pushes. Other engineers `git pull` and adapt their in-flight work.

**No `--affects` flag. No contradiction check. No proposal-object lifecycle in v0.4.**

The honest cost (explicitly accepted): a dev pushes "we now use async dispatch for billing events." Another dev mid-task on "invoice retry UI" doesn't connect the dots. Their work ships against the old assumption. Bug surfaces later.

Mitigations the **team** owns (not forge):
- PR review on SPEC changes (team's choice, no forge enforcement)
- Standup / Slack discussion of architectural shifts
- Discipline of reading `git log spec/` periodically

Mitigation forge **does** offer (the one small assist):
- When a worker resumes a task, show: `SPEC changed since you claimed this ticket — 3 commits affecting 2 sections. Show diff?` Informational. Not gating. Dev decides what to do.

### 2.4 Spec files untracked in forge's own .gitignore — fixed

Forge's `.gitignore` currently has:
```
/spec/BRIEF.md
/spec/PRD.md
/spec/SPEC.md
/spec/DESIGN.md
/spec/CONTEXT.md
/plans/phases.yaml
```

These exist because forge ships via npm and the goal was to keep our specs out of the package. **The right control is `package.json#files` (allowlist), not gitignore.** The files list already exists; it just needs verification + a CI packaging check.

Remove the spec entries from `.gitignore`. Keep them out of npm via the `files:` allowlist + CI pack test.

---

## 3. What's IN vs OUT

### IN (v0.4 scope)

- Untrack spec files in forge's own `.gitignore`; add CI packaging gate.
- `phases.yaml` as derived snapshot with source metadata + freshness display on read.
- `/reconcile --pull` (and `--push`) for bidirectional tracker ↔ phases.yaml sync.
- `Tracker.updateIssueBody(id, body)` on all 3 adapters (Linear/GitHub/Notion).
- CLI verb suite split into read-only vs user-approved-mutate bands. (FORGE-20 refactor — simplified scope.)
- Worker prompt with **authority-by-field** precedence (architecture from SPEC, execution from tracker, freshness check on phases.yaml read).
- Worker `spec_revision` stamping at claim + informational SPEC-diff notification on resume.
- `forge orchestrate doctor` — read-only diagnostic, **scoped down** to SPEC↔code reference checks only.
- Dispatch skill rewrite (present → approve → claim — the present-then-claim flow is good regardless).
- Auto-codex in-skill hooks (suggest `/codex review-*` at architectural decision points).
- Init flow onboarding interview (primary/secondary agent, tracker, GitHub auth).
- `forge migrate` v0.2.x → v0.4.
- E2E fixtures + cross-host CI matrix (Claude Code + Codex parity).

### OUT (deferred to v0.5+ as opt-in, or dropped entirely)

| Out of v0.4 | Disposition |
|---|---|
| Ephemeral ADRs (`templates/adr.template.md`) | Deferred to v0.5 as opt-in tooling for teams that want formal RFC-like flows |
| `/update-spec --draft` and `/update-spec --apply` skills | Deferred to v0.5 as opt-in |
| `forge orchestrate apply-decision` verb | Deferred to v0.5 |
| `/amend-roadmap` skill + verb (mid-flight task creation) | Deferred to v0.5 (use direct tracker edit + `/reconcile --pull` instead) |
| `forge orchestrate worktree-drift-guard` verb | Dropped — no drift workflow |
| Drift events, drift-routed questions, cross-session question UX | Dropped — no drift workflow |
| `QuestionIndex.drift_event_id` + `QuestionIndex.routing_hint` fields | Dropped — no drift workflow |
| Section ownership tags (`<!-- forge:section affects=... -->`) | Dropped — fast-path contradiction detection abandoned |
| Active worktree file-glob registry as architectural-safety gate | Dropped — file overlap is for execution coordination, not SPEC safety |
| LLM-classified SPEC-vs-tracker contradiction detection | Dropped |
| `forge spec-push --affects` flag and confirmation prompt | Dropped — no gate at all |
| Forge-enforced PR review policy (solo/team modes) | Dropped — team's choice |
| Server-side hooks / CI gates for SPEC changes | Dropped — team's choice if they want them |
| Workflow-stage state machine (`suggest-next`, `session-check`, `intent-detect`) | Already dropped in morning redesign; staying dropped |

---

## 4. Ticket consolidation — Phase 2.5

The morning redesign created 15 P2.5 tickets (P2.5-T01 .. P2.5-T15). Under the minimum architecture, most are deferred or dropped. The consolidation:

### Kept (with simplification)

| Old ID | Tracker | Title | What changes |
|---|---|---|---|
| P2.5-T03 | FORGE-94 | `Tracker.updateIssueBody` on all 3 adapters | **No change.** Still needed for `/reconcile --push`. |
| P2.5-T05 | FORGE-96 | Refactor FORGE-20 CLI verb suite | **Simplified.** Drop apply-decision, amend-roadmap, worktree-drift-guard from required surface. Keep claim/dispatch/heartbeat/question/answer/event/complete/cancel/gc/reconcile/run/phases/status/questions/doctor/attach. |
| P2.5-T06 | FORGE-97 | Worker prompt template | **Simplified.** Replace the 6-level precedence chain with authority-by-field. No drift event/question protocol. Add freshness check on phases.yaml read. |
| P2.5-T07 | FORGE-98 | `/forge orchestrate` dispatch skill rewrite (present → approve → claim) | **No change.** This flow is good regardless of drift workflow. |
| P2.5-T08 | FORGE-99 | `forge orchestrate doctor` | **Scoped down.** Only SPEC↔code reference checks. Drop ADR-draft and apply-journal scopes. |
| P2.5-T09 | FORGE-100 | `/reconcile` skill + verb (bidirectional) | **Simplified.** No conflict-resolution UI (team handles via git/tracker normally). Diff preview only. |
| P2.5-T13 | FORGE-105 | Auto-codex in-skill hooks | **No change.** Useful regardless. |
| P2.5-T14 | FORGE-106 | Precedence + skill-verb contract docs in CLAUDE.md | **Simplified.** Document authority-by-field instead of 6-level chain. |

### New tickets for the minimum architecture

| New ID | Title | Notes |
|---|---|---|
| P2.5-T16 | Untrack `spec/*` + `plans/phases.yaml` from forge's `.gitignore`; verify `package.json#files` allowlist; add CI `npm pack --dry-run` gate | S, no deps. |
| P2.5-T17 | `phases.yaml` source metadata stanza + freshness display on every read | S, depends on T03 (updateIssueBody not strictly needed but reconcile is). |
| P2.5-T18 | Worker `spec_revision` stamping at claim + informational SPEC-diff notification on resume | S, no deps. |

### Deferred to v0.5 (mark `status: deferred-v0.5` in phases.yaml, preserve `tracker_issue_id` for cleanup or future use)

| Old ID | Tracker | Title | Disposition |
|---|---|---|---|
| P2.5-T01 | FORGE-92 | ADR template + ephemeral ADR convention docs | v0.5 opt-in |
| P2.5-T02 | FORGE-93 | `/update-spec --draft` and `--apply` skill | v0.5 opt-in |
| P2.5-T04 | FORGE-95 | `forge orchestrate apply-decision` verb | v0.5 opt-in |
| P2.5-T10 | FORGE-101 | `/amend-roadmap` skill + verb | v0.5 opt-in |

### Dropped entirely (close tracker issue with explanation)

| Old ID | Tracker | Title | Reason |
|---|---|---|---|
| P2.5-T11 | FORGE-103 | `forge orchestrate worktree-drift-guard` verb | No drift workflow |
| P2.5-T12 | FORGE-104 | Cross-session question UX (drift-routed questions) | No drift workflow |
| P2.5-T15 | FORGE-107 | `QuestionIndex.drift_event_id` + `routing_hint` extension | No drift workflow |

---

## 5. Effect on paused Phase 2 tickets

The morning redesign paused FORGE-20 (P2-T07), FORGE-21 (P2-T08), FORGE-74 (P2-T18). Under the minimum architecture:

- **FORGE-20** — un-pause, but execute under the **simplified** P2.5-T05 scope (drop apply-decision/amend-roadmap/worktree-drift-guard from required verbs). Replaced_by: [P2.5-T05] (one ticket, not three).
- **FORGE-21** — un-pause, replaced_by: [P2.5-T06] (worker prompt with authority-by-field).
- **FORGE-74** — un-pause, replaced_by: [P2.5-T07] (dispatch skill rewrite).

---

## 6. SPEC / PRD / ORCHESTRATOR edit plan

| Artifact | Edit |
|---|---|
| `spec/PRD.md` | Add new amendment block dated 2026-05-17 (PM) noting further simplification. Mark Feature 5 (drift workflow + ADRs) deferred to v0.5. Mark Feature 6 (mid-flight roadmap mutation) deferred to v0.5. Update precedence rules section to authority-by-field. |
| `spec/SPEC.md` | Add new amendment block noting simplification. Replace 6-level precedence chain with authority-by-field matrix. Mark §ADR layer as v0.5 opt-in. Update §phases.yaml semantics: derived snapshot, source metadata stanza, freshness check. Remove apply-decision/amend-roadmap/worktree-drift-guard from Module layout's required surface (keep as future-planned but explicitly v0.5). |
| `spec/ORCHESTRATOR.md` | The uncommitted diff already has the CLI surface split (read-only vs mutate) — that's good architecture, keep. Remove apply-decision, amend-roadmap, worktree-drift-guard from the required mutating verbs list (move to "v0.5 opt-in" section). Remove `drift_event_id` + `routing_hint` fields from `QuestionIndex`. Simplify the §Worker prompt template section to authority-by-field. |
| `plans/phases.yaml` | Phase 2.5 task consolidation per §4 above. Update Phase 2.5 goal + gate criteria. Mark Phase 2.5-T01/T02/T04/T10/T11/T12/T15 as `status: deferred-v0.5` or `status: dropped` with `disposition: <reason>`. Add P2.5-T16/T17/T18. |
| `.gitignore` | Remove 7 spec/phases entries. |
| `package.json` | No code change needed; `files:` allowlist already exists. Add CI gate (`scripts.test:pack`) that runs `npm pack --dry-run` and asserts spec/plans/.forge are NOT included. |

---

## 7. Definition of done (v0.4)

End-to-end demo on a fresh adopter machine:

1. `npx @firatcand/forge@latest init` — scaffolds project, runs onboarding interview.
2. User runs `claude`, types `/forge`.
3. BRIEF → PRD → SPEC → DESIGN → phases.yaml → tracker, no manual context-switching.
4. `/forge orchestrate` — claims a ready task with user approval, dispatches a worker.
5. Worker on resume sees: `phases.yaml: synced 47min ago against linear@rev_abc123` + (if SPEC changed since claim) `SPEC changed since claim — 3 commits affecting spec/SPEC.md. Show diff?`
6. User edits SPEC mid-flight, commits, pushes. Other workers/devs pull as part of normal git workflow. No forge ceremony.
7. `/reconcile --pull` regenerates phases.yaml from tracker after a tracker-side scope change.
8. `/ship` → PR + tracker status update.
9. `forge orchestrate doctor` on this very project returns exit 0.
10. `npm pack --dry-run` confirms no spec/plans/.forge files in the tarball.

**Explicitly NOT in v0.4 demo:** no ADR draft/apply, no mid-flight roadmap amendments, no drift events, no contradiction gate. Those are v0.5 opt-in features.

---

## 8. Open questions

These are intentionally deferred — they don't block v0.4:

1. **When v0.5 adds opt-in ADR workflow**, do ADRs live in `spec/decisions/` or directly as tracker-comment proposals? (Round 2 Codex consult favored tracker-comments; deferred decision.)
2. **`phases.yaml` filename rename?** Initially proposed `phases.snapshot.yaml` to signal cache-ness. Deferred — keeping name minimizes churn in v0.4; revisit after adopter feedback.
3. **Render-target SPEC mirroring to Notion** (for PMs who don't read git) — v0.5+ feature behind the `SpecSource` adapter abstraction. Codex round 1 recommended Shape A (one-way mirror) as the safe start. Not in v0.4.

---

## 9. Provenance

- Discussion: 2026-05-17 chat session, ~8 rounds of design exploration
- Codex consults: 4 rounds (round 1 = team-mode bootstrap; round 2 = proposal-object lifecycle; round 3 = section-tag/registry expansion; round 4 = minimum stress-test)
- Symphony research: `openai/symphony` SPEC.md — confirmed Symphony is a pure scheduler/dispatcher, not a spec-lifecycle manager. Forge's "spec lifecycle + sync bridge" is forge-original design.
- User decisions: consistently chose simpler over more complex through every round
- Final pull-back: drop the `--affects` declaration entirely. Standard git push for SPEC changes.

## 10. Immediate next steps

1. ✅ This doc written
2. ☐ Add superseded banner to `closed-loop-workflow-redesign.md`
3. ☐ `.gitignore` edit (untrack spec files)
4. ☐ `package.json#files` already correct; add CI packaging gate (small follow-up)
5. ☐ phases.yaml Phase 2.5 consolidation per §4
6. ☐ PRD amendment block per §6
7. ☐ SPEC amendment block per §6
8. ☐ ORCHESTRATOR.md surgical trim per §6
9. ☐ `/push-to-tracker` — close FORGE-103/104/107; defer FORGE-92/93/95/101 with v0.5 label; create new tickets for P2.5-T16/T17/T18
10. ☐ Update memory `project_forge_phase2_state.md` to reflect new pickup order

**Estimated CC time to land §1-7 (in-repo edits):** ~2-3h.
**Estimated CC time to land §8-9 (tracker sync):** ~30min.
