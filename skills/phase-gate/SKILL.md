---
name: phase-gate
description: Ceremony to advance from phase N to phase N+1. Verifies gate criteria, runs end-to-end check, generates retro, prompts for human approval.
tools: Read, Write, Bash(*)
subagent: phase-gatekeeper
---

# /phase-gate

Delegate to `phase-gatekeeper`.

## Args

- `phase-{N}` (e.g., `phase-1`)

## Steps

1. Read `plans/phases.yaml` for `phase-N.gate_criteria`
2. Verify all phase-N tasks are Done in Linear (abort with list if not)
3. Run `gate_check_command` from phases.yaml (e.g., `npm run e2e && npm run typecheck`)
4. Generate `docs/retros/phase-{N}.md`:
   - Tasks shipped (with PR links)
   - Decisions made
   - Scope changes from original phases.yaml
   - Learnings to harvest
   - What to do differently in phase-{N+1}
5. Print summary, ask: "Approve advancing to phase-{N+1}? [y/N]"
6. On `y`:
   - Linear: close Cycle N, activate Cycle N+1
   - Move all phase-(N+1) tasks Backlog → Todo
   - Update phases.yaml: `phase-N.status = "complete"`
   - Commit retro
7. On `N`: list what's missing, exit (no partial advances)

## Output

If approved: confirmation + Phase N+1 task summary. If not: list of blockers.
