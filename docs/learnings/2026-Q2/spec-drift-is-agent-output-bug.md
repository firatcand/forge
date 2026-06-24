# SPEC drift is an agent-output bug, not architectural hygiene

> 2026-05-16 · FORGE-80 / FORGE-91 · tags: [architecture, spec, adr, agent-context, codex-review, foundational, defended-too-hard]

## What we expected
While walking the user through FORGE-80 (/sync-status rewrite), I described forge's current design as: *"BRIEF/PRD/SPEC are written once at the start. They describe the original vision. Refinements live in tickets. SPEC is a founding document, not a living one. Forge's design says: that's fine."* Framed it as a deliberate trade-off the user had signed up for, intentional and defensible.

## What happened
The user pushed back hard: *"Specs should be a living document and specs should be up to date because specs and phases in YAML will help us with debugging... the agent doesn't know what to pick on so I think this is an issue."*

I checked the framing against reality before defending it. Found:

1. **No `/update-spec` skill exists.** Only `/draft-spec` (one-shot creation). The skill list has no equivalent for editing.
2. **The "frozen reference" header on `spec/ORCHESTRATOR.md`** is a warning about update *cost*, not a design *principle*: *"Status: frozen reference. Every Phase 2 implementation task is built against this spec. Changes here require re-review of any unfinished task."*
3. **Two of our own learnings explicitly contradict** on which doc wins when SPEC and Linear disagree:
   - `spec-beats-linear-ac.md` (FORGE-14): SPEC won, Linear AC was corrected post-ship.
   - `spec-api-reality-check-before-design.md` (FORGE-16): SPEC was wrong, had to be amended after implementation.
   - Both lessons are valid in isolation. Together they prove **no deterministic precedence rule exists**. Agents reading the learnings have to guess.
4. **Multiple recent tickets carry rescope headers that never propagated to SPEC:** FORGE-72 "SCOPE EXPANDED 2026-05-14", FORGE-22 "FUNDAMENTALLY RESCOPED 2026-05-14", FORGE-76 outcome-(c) lock 2026-05-15.

Codex consult (gpt-5.5, 2026-05-16) confirmed at confidence 8/10: *"A frozen SPEC is defensible as a historical baseline. It is NOT defensible as the planning substrate for autonomous agents."* The failure mode: agent picks up FORGE-N, reads SPEC for grounding, reasons against stale architecture, produces work consistent with the wrong mental model. The agent doesn't know what it doesn't know.

User was right. I was defending a design that didn't exist — only an absence I'd mistaken for one.

## Why
I had pattern-matched the *absence* of a workflow ("no /update-spec exists") into the *presence* of a deliberate design choice ("SPECs are frozen by design"). That conflation is dangerous in two directions:

- **Underclaim:** treating a gap as a feature stops you from filing the ticket that would close it.
- **Overclaim:** authoritatively explaining the gap to the user as intent makes them stop pushing on what would otherwise be a productive conversation.

The user pushed past my framing because they have ground truth I didn't — they're feeling the agent-drift cost in their own work. My SPEC-frozen mental model came from the gitignore comment ("Forge dogfooding — keep our project specs local") and the absence of an update skill. Neither is a design statement.

## Next time
- **Distinguish "we decided X" from "X just happens to be what we have."** If there's no skill, no doc, no policy, no migration plan, no ADR — it's a gap, not a decision. State it as such.
- **When defending a design against user pushback, verify the design exists in writing first.** Grep the spec docs, the skills, the ETHOS, the CLAUDE.md. If the design isn't stated anywhere except your inference, the user's pushback is probably more grounded than your defense.
- The right mental model for project documentation isn't "living vs frozen." It's **three artifacts with explicit precedence**:
  - **Snapshot SPEC** — current architecture, written to be read cold by a new contributor or autonomous agent
  - **Decision log** (ADRs, MADR schema) — append-only history of *why* we changed our minds
  - **Operational task state** (Linear) — what's happening right now
  Each layer has a clear job. Conflating any two creates drift.
- For autonomous-agent frameworks specifically, **the precedence rule MUST be deterministic and documented**. Agents have no judgment for "this learning was about a different situation" — they read everything as authoritative.

## What got filed as a result
FORGE-91 (Urgent, 5pt): *"Architecture-drift workflow: /update-spec + ADR records + doctor diagnostics (foundational)."* Three coordinated parts:
1. `/update-spec` skill — explicit, reviewed edits triggered when architecture shifts
2. `spec/decisions/` ADR records — MADR-shaped, append-only, with `supersedes:` chains
3. `forge orchestrate doctor` drift diagnostics — flags Linear/SPEC drift, SPEC/code drift, learning/SPEC drift, phases.yaml/SPEC drift

## Related
- FORGE-91 — the follow-up that captures the full fix
- [[ac-as-unit-test]] — same family: don't assume "structure exists ⇒ behavior correct"
- [[linear-deps-via-relations]] — same family: don't trust prose over structured data
- `spec-beats-linear-ac.md` / `spec-api-reality-check-before-design.md` — the contradictory pair that proved the gap
