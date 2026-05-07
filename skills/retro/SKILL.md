---
name: retro
description: Write a phase retrospective. Auto-invoked by /phase-gate but can run standalone.
tools: Read, Write, Bash(git*)
---

# /retro

## Args

- `phase-{N}` (e.g., `phase-1`)

## Process

1. Gather data from Linear (closed tasks in cycle N) + git log (commits during cycle) + learnings written during cycle
2. Synthesize:
   - What shipped (count + highlights)
   - Cycle time avg
   - Decisions made (with PR links)
   - Scope changes from original phases.yaml
   - Learnings (count + key ones)
   - What to do differently next phase
3. Write to `docs/retros/phase-{N}.md` using `templates/retro.template.md`

## Output

Retro file path + 5-bullet summary printed to terminal.
