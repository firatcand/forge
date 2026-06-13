---
slug: native-goal-integration
date: 2026-06-13
status: accepted
affected_tasks: [FORGE-214, FORGE-190, FORGE-187]
affected_spec_sections: ["spec/SPEC.md §Skill ↔ verb contract"]
affected_prd_sections: []
affected_phases_tasks: [P4-T04]
---

# Forge rides the host-native `/goal` loop; it does not ship its own

## Context
The Autopilot/autonomy design (FORGE-183 narrative, FORGE-214 `/goal` ticket) assumed Forge would ship a `/goal` skill — a per-ticket driver that loops a ticket through plan→build→review→ship.

Two facts discovered while planning FORGE-187 (2026-06-13) invalidate that assumption:
1. **`/goal` is a native command in both target hosts.** Claude Code ships `/goal` (v2.1.139+) — a generic "keep working until a model-checked completion condition holds" loop, implemented as a session-scoped prompt-based Stop hook; its own docs cite "working through a labeled issue backlog until the queue is empty" as a use case. Codex ships a native goals feature (a goals store, `~/.codex/goals_*.sqlite`).
2. A Forge-shipped `goal` skill would therefore **collide with / be shadowed by** the native command, and would **reinvent** a loop the host already does better (separate evaluator model, session resume, headless `claude -p "/goal …"`).

Native `/goal` is an *engine* ("keep going until the condition is true"); it carries no recipe. The recipe is whatever the agent does each turn.

## Decision
**Forge provides the recipe (skills) + the state machine (verbs) + the review gates. The host's native `/goal` (and `/loop`) provides the loop engine. Forge does NOT ship a `/goal` skill.**

- Forge's per-ticket and cross-phase drivers are expressed as **forge skills/verbs invoked each turn**, looped by the user (or autopilot) via native `/goal "<completion condition>"`. Example: `/goal every ready FORGE ticket is merged` with Forge's pickup→plan→implement→review→ship skills running each turn; `/goal the review-queue is empty` driving the FORGE-187 `auto-review` skill.
- Any Forge-owned driver that needs a name lives under a **non-colliding** surface — a `forge orchestrate` verb and/or a distinctly-named skill — never bare `goal`.
- Forge skills MUST NOT implement their own polling loop (`sleep`/`watch`/`while true`/`--follow`): looping is the host engine's job. (Already enforced by the FORGE-187 auto-review contract test.)

## Consequences
- **FORGE-214** is reframed from "ship a `/goal` skill" to "make Forge's per-ticket gauntlet drivable by native `/goal` — a recipe skill (non-colliding name) + per-ticket completion-condition templates + the supporting verbs." Its acceptance criteria change accordingly.
- **FORGE-190** (watcher `/loop` + plan-approval queue) similarly rides native `/loop`, not a Forge-built watcher loop.
- **FORGE-187** is unaffected and validated: the `auto-review` skill is the per-turn recipe that native `/goal "review-queue empty"` drains; its no-loop contract test is correct by this decision.
- Cross-host: behavior differs slightly per host (Claude `/goal` vs Codex goals), accepted — Forge owns the recipe, the host owns the engine.
- Documentation must teach the pattern (good `/goal` conditions per workflow) rather than a Forge `/goal` command.

## Alternatives considered
- **A — Forge ships its own `/goal` skill** (original plan). Rejected: name collision with native `/goal` in both hosts; reinvents the native loop; loses native evaluator/resume/headless.
- **B — Forge drives only the host-native engine with no Forge driver name.** Viable but leaves the per-ticket recipe undiscoverable; chosen variant keeps a Forge recipe skill under a non-colliding name (hybrid = this decision).
- **C — Forge builds a generic loop engine.** Rejected: duplicates a solved, host-owned primitive.

> Propagate with `/update-spec --apply native-goal-integration` to update SPEC §Skill↔verb contract + FORGE-214/190 bodies, then this file is deleted per the ephemeral-ADR workflow.
