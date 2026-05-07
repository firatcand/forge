# time-logger — PRD

## Problem

Solo founders working across 3–6 projects lack a low-friction way to record context switches as they happen. Existing tools (Toggl, Clockify) optimize for teams: account creation, project sharing, billable rates, invoicing. Each switch through these tools costs ~30s and 4–5 clicks, so users skip logging and reconstruct retroactively from git history and Slack — which is noisy, lossy, and demoralising.

The pain peaks during a working day when the founder shifts focus 6–10 times across projects. The cost is not just the lost minutes per switch but the mental tax of opening another app while in flow.

## Target user

Solo technical founder shipping 3+ side projects from a terminal-centric workflow.

JTBD: When I shift focus from project A to project B, I want to log the switch in one keystroke from my terminal, so that on Friday I can see exactly how my time landed across projects without manual reconstruction.

## Acceptance Criteria (the MVP)

- [ ] `tl <project>` appends a new entry; closes the previous open entry's `ended_at` automatically
- [ ] `tl <project> "<note>"` works the same way and stores the note
- [ ] `tl init <project>` registers a project so it shows up in tab completion
- [ ] `tl report` (no args) prints the last 7 days grouped by project, with hours per project, total hours, and percentages
- [ ] `tl report --week 2` shows two weeks back
- [ ] `tl status` shows the current open entry (project, note, started_at, elapsed time)
- [ ] All commands complete in <100ms p95 on a database with 10,000 entries
- [ ] Database is at `${TL_HOME:-~/.tl}/data.db`, mode 0600
- [ ] Tab completion works in zsh and bash (project names auto-suggest)

## Explicit non-goals

- Not building team features (sharing, roles, billing, invoicing) — ever
- Not building a web UI or mobile app — CLI-first stays
- Not building integrations with Toggl, Clockify, or invoicing tools in v1
- Not building Pomodoro / focus timers
- Not auto-inferring the current project from terminal cwd

## Success metrics

- **North-star**: maintainer logs ≥80% of work hours for 4 consecutive weeks by 2026-07-01
- **Leading indicators**:
  - Entries per work-day (target: ≥4)
  - Distinct projects tracked per week (target: ≥3)
  - Days active per 7-day rolling window (target: ≥5)

## Constraints

- **Budget**: zero hosting cost (local-only). No paid services.
- **Timeline**: v1 ships in 1 working week (~5 evenings).
- **Regulatory**: none (no data leaves the machine).
- **Integration**: must not require root, must not require a daemon, must not modify the user's shell rc files automatically (only via opt-in `tl install-completion`).

## User flows

### Flow 1 — first switch of the day
1. User opens terminal, types `tl applaiflow "fix billing webhook"`
2. System creates entry with `started_at = now`, `ended_at = NULL`
3. System prints: `→ applaiflow @ 09:14 (note: "fix billing webhook")`
4. Edge: if a previous entry is open from yesterday, prompt: "Yesterday's session is still open from 17:23. Close it now? [y/N]"

### Flow 2 — switching mid-flow
1. User types `tl roster "design audit"`
2. System closes the previous entry (`applaiflow`) by setting `ended_at = now`
3. System creates new entry for `roster`
4. System prints: `← applaiflow (closed @ 11:42, 2h28m)`, then `→ roster @ 11:42 (note: "design audit")`

### Flow 3 — end of day
1. User types `tl off "done"` (special project name `off`)
2. System closes any open entry; does NOT create a new one
3. System prints: `← applaiflow (closed @ 18:05, 6h22m). Day total: 7h14m across 4 projects.`

### Flow 4 — Friday review
1. User types `tl report`
2. System queries last 7 days (Saturday → Friday by default)
3. System prints a table: project, hours, %, last entry note
4. Edge: ANSI colors fall back to plain text when stdout is not a TTY
