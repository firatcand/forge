---
name: draft-spec
description: Generate spec/SPEC.md from spec/PRD.md. Orchestrates the user's software-architect skill if available, otherwise guides Claude through the SPEC template.
tools: Read, Write, Edit
---

# /draft-spec

## Preconditions

`spec/PRD.md` must exist (Gate 2 must have passed).

## Orchestration

1. Read `spec/PRD.md`
2. Read `~/.claude/CLAUDE.md` for any stack_preferences block
3. Check if user has a `software-architect` skill available — if yes, invoke it with PRD + stack preferences
4. If not, use `templates/SPEC.template.md` and guide Claude through filling sections
5. Invoke `security-auditor` subagent in advisory mode for the chosen stack — get security model recommendations
6. Write to `spec/SPEC.md`

## Required SPEC sections

- Stack (runtime, frontend, backend, db, hosting, auth)
- Data model (tables, relationships, indexes)
- Key flows (numbered steps with edge cases)
- Integration points (external services)
- Security model (authN, authZ, sensitive data handling)
- Environment variables (12-Factor compliant — names + descriptions)
- Performance targets (p95 metrics)
- Observability (logs, metrics, errors)

## Stack choice ceremony

If SPEC implies a tech stack not yet committed, invoke Confusion Protocol:
- List 2-3 viable options
- Show concrete trade-offs
- Stop and ask user to pick before writing

## Output

Print confirmation + Gate 3 instructions.
