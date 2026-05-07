---
name: ingest-spec
description: Validate that BRIEF, PRD, SPEC, and (optional) DESIGN are all complete and consistent. Build CONTEXT.md as canonical synthesis. Required before /decompose.
tools: Read, Write
---

# /ingest-spec

## Validation checklist

For BRIEF.md:
- [ ] Pain section is concrete (not "people want")
- [ ] Target user is specific
- [ ] Non-goals listed
- [ ] North-star metric has a number

For PRD.md:
- [ ] Acceptance criteria are testable
- [ ] Non-goals match BRIEF non-goals
- [ ] Success metrics include BRIEF north-star

For SPEC.md:
- [ ] Stack is specified
- [ ] Data model present
- [ ] Env variables enumerated
- [ ] Security model defined

For DESIGN.md (if exists):
- [ ] Tokens reference brand-book via @inherit OR are explicitly defined
- [ ] Voice section calibrated for this product

## Cross-document consistency

- PRD acceptance criteria must be testable given SPEC's data model
- DESIGN voice must be compatible with PRD's target user
- All env vars in SPEC must have entries in `.env.example`

## On failure

List what's missing or inconsistent. Block /decompose.

## On success

Write `spec/CONTEXT.md` — single-page synthesis of all four docs. This is what `/decompose` reads.

Print: "Spec validated. /decompose unlocked."
