# SPEC drift from dropped features
> 2026-05-18 · FORGE-105 · tags: [spec-discipline, planning, drift]

## What we expected
SPEC.md is canonical; FORGE-105 acceptance criteria directly mirror SPEC §Auto-codex skill-level hooks.

## What happened
During /plan-task fork enumeration, the `auto_codex_token_cap` budget concept turned out to be a legacy artifact of the DROPPED Feature 7 (auto-executing host hooks). For the passive-suggestion model that survived, the budget bounds nothing — the suggestion consumes zero tokens; the user controls whether to invoke `/codex`. SPEC was never re-examined when Feature 7 was cut. Dropped budget enforcement from FORGE-105 scope; filed FORGE-124 to amend SPEC.

## Why
SPEC amendments happen in waves; smaller hooks and contracts referenced by the amended section are easy to miss. /plan-task's fork-severity filter forces re-examination at the implementation point, surfacing drift that would otherwise compound silently.

## Next time
When a /plan-task fork reveals SPEC says X but X no longer makes sense given other SPEC changes, file a SPEC-amendment ticket as a sibling task before implementing. Do not leave "RESERVED" comments in code — that buries the drift in code archaeology.
