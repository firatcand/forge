---
name: learn
description: Write a learning entry capturing what surprised us, what we'd do differently. Auto-suggested by /ship if task was notable.
tools: Read, Write
subagent: learning-curator
---

# /learn

Delegate to `learning-curator`.

## Triggers (any one makes the task "notable")

- Investigation took > 30 min
- > 2 fix attempts before success
- Surprised by behaviour
- Found a non-obvious gotcha
- Made a non-trivial trade-off
- Bootstrapped something new (test framework, CI, infrastructure)

## Process

1. Read the last commit + PR description + investigation file (if exists)
2. Extract:
   - What we expected
   - What actually happened
   - Why
   - What we'd do differently
3. Tag with relevant types
4. Write 5-10 line learning to `docs/learnings/{quarter}/{slug}.md` using `templates/learning.template.md`

## Format

```markdown
# {Slug title}
> {ISO date} · {LINEAR-ID} · tags: [foundation, testing]

## What we expected
[1-2 lines]

## What happened
[2-3 lines]

## Why
[1-2 lines]

## Next time
[1-2 lines]
```

## Retrieval

`/pickup-task` reads recent learnings tagged with the new task's type and injects them into context. The system gets smarter over time.
