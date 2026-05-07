---
name: draft-prd
description: Generate spec/PRD.md from spec/BRIEF.md. Orchestrates the user's product-spec skill if available, otherwise guides Claude through the PRD template directly.
tools: Read, Write, Edit
---

# /draft-prd

## Preconditions

`spec/BRIEF.md` must exist. If not, refuse and direct user to `/forge`.

## Orchestration

1. Read `spec/BRIEF.md`
2. Check if user has a `product-spec` skill available globally — if yes, invoke it with BRIEF.md as input
3. If not, use `templates/PRD.template.md` directly and guide Claude through filling each required section based on BRIEF
4. Cross-check generated PRD against BRIEF — flag any drift (new features not in v1 scope, success metrics differing from BRIEF's north star)
5. Write to `spec/PRD.md`

## Required PRD sections

- Problem (synthesized from BRIEF.pain, made concrete)
- Target user (specific persona, JTBD format)
- Acceptance Criteria (testable bullets)
- Non-goals (must include all from BRIEF.non-goals)
- Success metrics (must include north-star from BRIEF)
- Constraints (budget, timeline, regulatory, integrations)

## Output

Print:

```
PRD written to spec/PRD.md

Acceptance criteria preview:
- [criterion 1]
- [criterion 2]
- [criterion 3]

Gate 2 — review the PRD. To proceed:
  • /draft-spec to generate the technical SPEC
  • /draft-design to generate the DESIGN doc (if UI-heavy)
  • Edit spec/PRD.md directly
  • /draft-prd --refine [section] to re-generate a weak section
```
