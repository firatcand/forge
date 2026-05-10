---
name: draft-prd
description: Generate spec/PRD.md from spec/BRIEF.md with a per-feature discovery loop. Orchestrates the user's product-spec skill if available, otherwise guides Claude through the PRD template.
tools: Read, Write, Edit
---

# /draft-prd

## Preconditions

`spec/BRIEF.md` must exist. If not, refuse and direct the user to `/forge`.

## Orchestration

1. Read `spec/BRIEF.md`
2. Check if user has a `product-spec` skill globally — if yes, invoke it with BRIEF as input
3. Otherwise, use `templates/PRD.template.md` and walk Claude through filling each section
4. **Per-feature discovery loop** — for each item in `BRIEF.v1 scope`:
   - Ask: "What does this feature do? What's the user flow?"
   - Ask: "What's the success criteria for this feature? Edge cases or failure modes?"
   - Ask: "What does this feature NOT do?" (per-feature non-goals)
   - Capture answers as a per-feature subsection in PRD
5. Cross-check generated PRD against BRIEF — flag any drift (new features outside v1 scope, definition-of-done that conflicts with BRIEF)
6. Write to `spec/PRD.md`

## Required PRD sections

- **Problem** (synthesized from BRIEF, made concrete with specific user/moment/workaround)
- **Target user** (specific persona, JTBD format)
- **Per-feature breakdown** — for each v1 feature: what it does, user flow, acceptance criteria, edge cases, per-feature non-goals
- **Acceptance criteria (overall v1)** — testable bullets that prove v1 is done end-to-end
- **Non-goals** (must include all from BRIEF.non-goals)
- **Constraints** (budget, timeline, regulatory, integrations, secret management, task tracker)

## Output

Print:

```
PRD written to spec/PRD.md

Per-feature acceptance preview:
- [feature 1]: [criterion]
- [feature 2]: [criterion]

Gate 2 — review the PRD. To proceed:
  • /draft-spec to generate the technical SPEC
  • /draft-design to generate the DESIGN doc (if UI surface)
  • Edit spec/PRD.md directly
  • /draft-prd --refine [section] to re-generate a section
```
