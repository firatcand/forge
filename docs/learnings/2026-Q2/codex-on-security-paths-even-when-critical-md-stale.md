# Run codex on security-sensitive paths even when CRITICAL.md is stale

> 2026-05-12 · FORGE-18 · tags: [review, security, codex, critical-paths, ethos]

## What we expected
CRITICAL.md enumerates the files that require multi-model review. forge's CRITICAL.md still lists adopter-template defaults (auth/billing/prisma/supabase) — not forge's own internals. `src/core/secrets.ts` and `src/secrets-managers/*` aren't listed.

## What happened
Ran `/codex review --uncommitted` anyway because the code touches secrets. Surfaced two P2 findings (type unsoundness + TOCTOU leak) that would have merged otherwise.

## Why
ETHOS principle 6 applies by spirit, not by config-file enumeration. CRITICAL.md is a hint, not a contract. Security-sensitive code is recognizable by what it does (handles secrets, auth, atomic claim, subprocess, IPC), not by whether someone remembered to add it to a list.

## Next time
If the code touches secrets / auth / atomic-claim / subprocess-spawn / IPC / filesystem-with-untrusted-input, run codex regardless of CRITICAL.md state. Update CRITICAL.md as a side effect (or open a tracking issue — for forge that's FORGE-29).
