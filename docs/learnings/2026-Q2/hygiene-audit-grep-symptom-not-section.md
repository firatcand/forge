# Hygiene audit: grep for the symptom, not the section
> 2026-05-21 · FORGE-132 · tags: [spec-hygiene, audit, codex-second-pass, doc-pivot, false-negative]

## What we expected

A spec-hygiene audit anchored to the ticket body's "Concrete locations to audit" list would catch all stale prose. The ticket named specific sections by heading and approximate line number (PRD §Feature 5, §Feature 6, §Precedence rules, §Locked decisions 10/11; CONTEXT §The closed-loop drift workflow, §Module layout). Admonishing those sections should be sufficient.

## What happened

Codex's second-pass review surfaced 4 high-confidence misses (scores 8–9), all in the same superseded-contract family but expressed outside the named sections:

- PRD §156 (Feature 1 AC bullet): "Tracker body is a projection ... phases.yaml wins"
- PRD §182 (Feature 2 "Two truths, two mechanisms"): "Roadmap truth is phases.yaml"
- PRD §520 (Constraints "Tracker-agnostic data"): "phases.yaml schema is the canonical task representation; trackers are projections"
- PRD §542–553 (Flow A code block): `/update-spec --draft|--apply`, `worktree-drift-guard`, `/amend-roadmap` shown as live v0.4 commands with no admonition

A cold reader landing on PRD §156 without scrolling to the top-of-file amendments would walk away believing the superseded phases-canonical contract still held. All 4 required follow-up commit `535030c` before merge.

## Why

The audit was anchored to the ticket body's named sections. That anchoring created an attentional blind spot: every section listed in the ticket received scrutiny; every other section received only incidental attention.

The structural trap: a doc-wide architectural pivot (authority-by-field replaces 6-level precedence) ripples through a document via downstream assertions — short AC bullets, constraint prose, illustrative code blocks — that don't live inside the explicitly-flagged feature sections. Auditing the named sections catches the most visible offenders but misses the ripple.

Codex caught it precisely because it had no anchor to the ticket body. It read the final document state and looked for internal contradictions. The named-section model is weaker than the symptom-pattern model.

Sibling FORGE-133 (SPEC.md audit) didn't surface the same miss only because SPEC.md happened to have less unadmonished prose asserting the old contract — the same systemic flaw existed in both audits, just less visible there.

## Next time

1. Before starting any spec-hygiene audit, derive a **symptom grep list** from the pivot itself. For the v0.4→v0.5 authority pivot those phrases were: "phases.yaml is canonical", "tracker is projection", "phases wins", "phases.yaml wins", "/update-spec --apply", "drift events", "worktree-drift-guard", "/amend-roadmap".

2. Grep the entire document for each symptom. Every hit is a disposition candidate regardless of which section contains it.

3. Apply admonitions to all hits first, then revisit the ticket-named sections for structural changes. The ticket list identifies the most visible offenders; grep finds the ripple.

4. At review time, ask: "Would a cold reader landing on paragraph X — without scrolling to the top-of-file amendments — walk away with a false belief about the current contract?" If yes, that paragraph needs an inline admonition.

5. Use Codex second-pass on hygiene audits specifically as a contradiction detector, not just a style reviewer. Its lack of ticket-body anchoring is an asset here.

---

Cross-references: see also `docs/learnings/2026-Q2/` entries on Codex catching misses that section-scoped reviews miss (if filed), and any entries on doc-pivot blast-radius estimation.
