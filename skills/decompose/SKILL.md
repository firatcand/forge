---
name: decompose
description: Break the validated spec into phases.yaml — a dependency graph of tasks across Phase 1/2/3 with gate criteria, owner types, and acceptance criteria.
tools: Read, Write, Edit
subagent: product-decomposer
---

# /decompose

Delegate to the `product-decomposer` subagent.

## Preconditions

`spec/CONTEXT.md` must exist.

## Algorithm

1. Identify the smallest end-to-end working slice → Phase 1
   - Phase 1 goal is always: "skeleton works end-to-end with mock/seed data"
2. Identify the core feature loops → Phase 2
   - Phase 2 goal: "real users can complete the primary JTBD"
3. Identify polish + launch prep → Phase 3
   - Phase 3 goal: "quality bar for public launch"

## Per-task fields

- id (P{phase}-T{nn})
- title (verb + noun, max 8 words)
- description (1 paragraph)
- type (foundation | data | backend | integration | content | infra | skill | docs)
- priority (P0 | P1 | P2)
- depends_on (list of task IDs)
- estimate (S | M | L | XL)
- owner_type (which subagent picks this up — use 'human' for manual bootstrap work, never auto-dispatched)
- acceptance (concrete, testable)

## Hard rules

- No XL tasks ship — split them
- Every phase has explicit gate_criteria
- Dependency graph must be a DAG (validator catches cycles)

## Refinement

Show YAML to user, ask for one round of edits. Then write to `plans/phases.yaml`.

Print: "phases.yaml written. /push-to-tracker unlocked. Gate 4 — review the breakdown."
