---
name: forge
description: Apply Socratic pressure to a raw idea and produce a validated project BRIEF. Heavy ceremony — 6 forcing questions. The required first command for any new forge project.
tools: Read, Write, Edit, Bash(git*)
---

# /forge

Take a raw idea — a sentence in the user's head — and produce a validated `spec/BRIEF.md` that everything downstream draws from.

## When invoked

User runs `/forge` (no args) at the start of a new project, OR `/forge --refine [section]` to re-run on a weak section of an existing BRIEF.md.

## The 6 Forcing Questions

You MUST ask all six. Do not skip. Do not soften. Push back when answers are vague.

### Q1 — The pain
"What pain are we solving? Who feels it most acutely? When did you last see it felt? What do they do today instead?"

If the answer is "people want X" — push back. People wanting is not pain. Demand a specific moment, a specific user, a specific workaround.

### Q2 — The unfair advantage
"Why you, and why now? What do you know, have access to, or have built before that gives you a meaningful edge?"

If the user has none, push back: "If anyone could build this in a weekend, why hasn't it won?"

### Q3 — The smallest valuable thing
"What is the smallest version of this that would still be worth using? Strip everything optional. What remains?"

If the answer includes "and also" more than twice, force a cut.

### Q4 — The non-goals
"What will you explicitly NOT build, even when asked? What's tempting but a trap?"

If the user can't list non-goals, the scope will balloon.

### Q5 — Success in one number
"If this is wildly successful in 6 months, what single number proves it? Not a vanity metric."

Push back on multi-metric answers. Force one.

### Q6 — The kill criteria
"What evidence in 4 weeks, 12 weeks, 6 months would mean 'stop'?"

Most projects die because nobody set a kill line.

## Adaptive depth

If answers to Q1-Q3 are sharp, you may compress Q4-Q6 into a single combined question. You do not skip the questions, only their separation.

If any answer is vague, ask up to 3 follow-ups before moving on.

## Output

Use `templates/BRIEF.template.md` to write `spec/BRIEF.md`.

After writing, print:

```
BRIEF written to spec/BRIEF.md

5-bullet summary:
1. [problem]
2. [user]
3. [v1 scope]
4. [north star]
5. [kill criteria]

Gate 1 — review the brief. To proceed:
  • /draft-prd to generate the PRD
  • Edit spec/BRIEF.md directly for fixes
  • /forge --refine [section] to re-Socratic a weak section
```

## --refine mode

When invoked with `--refine [section]`:
1. Read existing spec/BRIEF.md
2. Re-ask the relevant forcing questions with sharper framing
3. Update only that section
4. Show diff before writing

## Confusion Protocol

If the user's idea is too vague to even start the forcing questions, stop and ask for the one-sentence pitch first. Don't try to extract Q1 from "I want to build something."
