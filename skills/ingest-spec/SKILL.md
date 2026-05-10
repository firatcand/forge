---
name: ingest-spec
description: Validate that BRIEF, PRD, SPEC, and (optional) DESIGN are all complete and consistent. Build CONTEXT.md as canonical synthesis. Required before /decompose.
tools: Read, Write
---

# /ingest-spec

## Validation checklist

For `spec/BRIEF.md`:
- [ ] **Product** section is concrete (one or two sentences describing what the product DOES)
- [ ] **User & JTBD** section is specific (named persona + JTBD format)
- [ ] **v1 scope** has at least 2 bullets
- [ ] **Non-goals** has at least 2 bullets
- [ ] **Definition of done** is a delivery checkpoint (not a metric, not a vision)

For `spec/PRD.md`:
- [ ] **Problem** is concrete (specific user, specific moment)
- [ ] **Target user** is specific
- [ ] **Per-feature breakdown** has one subsection per v1 feature; each has flow + acceptance + edge cases + non-goals
- [ ] **Acceptance criteria (overall v1)** are testable
- [ ] **Explicit non-goals** include all from BRIEF.non-goals

For `spec/SPEC.md`:
- [ ] **Stack** is specified (runtime, language, key libs)
- [ ] **Data model** present
- [ ] **Key flows** documented
- [ ] **Environment variables** enumerated
- [ ] **Security model** defined

For `spec/DESIGN.md` (if exists):
- [ ] **Mode** declared (`project_owned` or `reference_external`)
- [ ] **Tokens** are self-contained (no `@inherit` patterns — if found, flag as drift from prior forge version)
- [ ] **Voice** section calibrated for this product

## Cross-document consistency

- PRD acceptance criteria must be testable given SPEC's data model
- DESIGN voice must be compatible with PRD's target user
- All env vars in SPEC must have entries in `.env.example` (or be documented per secret manager)
- BRIEF non-goals must appear verbatim in PRD non-goals
- PRD constraints (tracker, secret manager) must match `.forge/settings.yaml` if present

## On failure

List what's missing or inconsistent. Block `/decompose` with a clear message: "ingest-spec failed — fix the items above and re-run."

## On success

Write `spec/CONTEXT.md` — single-page synthesis of all four docs. This is what `/decompose` reads.

Print: "Spec validated. /decompose unlocked."
