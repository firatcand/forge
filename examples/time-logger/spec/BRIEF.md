# time-logger — Brief

> Forged: 2026-05-07
> Status: Gate 1 passed (example only — frozen for forge documentation)

## The pain

A solo founder shipping multiple side projects burns 10–20 minutes a day in context-switching tax: opening a tracker, picking the project from a stale list, writing a vague note. Toggl and Clockify are built for teams — invoicing flows, billable rates, project sharing. They make a single user pay the cost of multi-user complexity. The maintainer last hit this exact pain on 2026-05-04 trying to log a context-switch from `applaiflow` to `roster` mid-flow, and gave up because the tracker's "new entry" form took five clicks.

What people do today: they don't log it. They reconstruct the week on Friday from git history and Slack, which produces noisy, lossy records.

## The user

Solo founder shipping 3–6 side projects in parallel.

JTBD: When I shift focus from project A to project B, I want to log the switch in one keystroke from my terminal, so that on Friday I can see exactly how my time landed across projects without manual reconstruction.

## The unfair advantage

The maintainer is the user. Every friction point is felt directly. CLI-first matches an existing workflow (terminal already open, project name already in muscle memory). No team features means no account system, no SSO, no billing — release cadence is bounded only by the maintainer's patience.

This is not defensible against someone who decides to copy it. It is defensible against the founder *not building it* — the alternative is "keep using Toggl badly," which is what's already happening.

## The smallest valuable thing

A single CLI command:

```
tl <project> [note]
```

Appends a timestamped entry to a local SQLite file. `tl report` shows the last 7 days grouped by project. That is the entirety of v1. No GUI, no sync, no integrations.

## Non-goals

- Team features (sharing, roles, billing) — never
- Mobile or web UI in v1 — never as a primary surface; CLI-first stays
- Integrations with Toggl, Clockify, or invoicing tools in v1
- Pomodoro / focus timers — different problem
- Auto-detection of which project you're working on (terminal cwd inference is too brittle)

## North-star metric

**Maintainer logs ≥80% of work hours** (self-reported via a weekly Friday review) for **4 consecutive weeks** by 2026-07-01.

## Kill criteria

- At week 4: if maintainer compliance is <50%, kill — the tool isn't reducing friction enough
- At week 12: if maintainer has gone >3 consecutive days without logging, kill — habit didn't stick
- At month 6: if no second user has tried it after offering, accept that it stays personal-only and stop investing in shareability

## Open questions

- Does `tl` collide with another common shell command? (Quick survey: `which tl` on a clean Mac shows nothing, but verify on Linux.)
- Should the project list auto-derive from `~/repos/*` directories, or stay an explicit allowlist? (Lean: explicit, with `tl init <project>`.)
