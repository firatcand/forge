---
name: forge
description: Run forge's discovery interview over a product idea and produce a project BRIEF. Lightweight — 4 product/spec questions. The required first command for any new forge project.
tools: Read, Write, Edit, Bash(git*)
---

# /forge

Take a product idea — a sentence in the user's head — and turn it into a structured `spec/BRIEF.md` that everything downstream draws from.

Forge **suggests, never interrogates.** It does not question whether the user should build the idea or what their advantage is. It clarifies *what* they want to build and surfaces structure.

## When invoked

User runs `/forge` (no args) at the start of a new project, OR `/forge --refine [section]` to re-run on a section of an existing BRIEF.md.

## The 4 product questions

Ask all four. Keep them tight. If an answer is vague, ask up to 2 follow-ups before moving on. Do not push back on the *value* of the idea — only on the *clarity* of intent and scope.

### Q1 — What is it, and who uses it?

"In one or two sentences, what does this product do? Who is the target user, and what's the situation when they reach for it?"

If the answer is abstract ("a platform for X"), ask for a concrete moment — the last time someone hit the problem this product solves and what they did instead.

### Q2 — The smallest valuable thing (v1 scope)

"What is the smallest version of this that's still worth using? Strip everything optional. What remains?"

Force a v1 cut. Anything beyond v1 goes to "open unknowns" or "later".

### Q3 — Non-goals

"What will this product NOT do, even when tempting? Where's the scope trap?"

Need at least 2 concrete non-goals. If the user can't list any, the v1 scope is under-defined — re-ask Q2.

### Q4 — Open unknowns

"What's still fuzzy? What decisions are you deferring? What are you assuming that you'd want to validate before/during build?"

Capture these — they feed `/draft-prd` and `/draft-spec`.

## What forge does NOT ask

Forge does **not** ask: "Why you?", "Why now?", "What's your unfair advantage?", "What's your kill criteria?", "What's your north-star metric?". These are founder-validation questions and don't belong in an engineering-delivery framework. Forge assumes the user has already decided to build.

## Output

Use `templates/BRIEF.template.md` to write `spec/BRIEF.md`.

After writing, print:

```
BRIEF written to spec/BRIEF.md

Summary:
1. Product: [one-line]
2. User & JTBD: [one-line]
3. v1 scope: [bullets]
4. Non-goals: [bullets]
5. Definition of done: [one-line]
6. Open unknowns: [bullets]

Gate 1 — review the brief. To proceed:
  • /draft-prd to generate the PRD (with per-feature discovery loop)
  • Edit spec/BRIEF.md directly for fixes
  • /forge --refine [section] to re-interview a section
```

## --refine mode

When invoked with `--refine [section]`:
1. Read existing spec/BRIEF.md
2. Re-ask the relevant question(s) for that section
3. Update only that section
4. Show diff before writing

## Confusion Protocol

If the user's idea is too vague to answer Q1, stop and ask for a one-sentence pitch first. Don't guess what they mean.
