# AI-subprocess spawner is the wrong tool for local trusted commands
> 2026-05-30 · FORGE-168 · tags: [foundation, security, subprocess, schema]

## What we expected
A repo with a hardened `spawnSubprocess` helper (`src/harnesses/subprocess.ts`) — "we already spawn subprocesses, reuse it" for the new verify runner.

## What happened
That helper is built for AI hosts (codex/gemini): it strips env to a `SAFE_ENV_KEYS` allowlist precisely so secrets don't reach an external model API, and its errors are host-typed ("install the X CLI"). Reusing it for adopter test commands would have silently broken any integration test needing `NODE_ENV` / DB creds, and produced nonsense error text. Built a separate `verify-runner.ts` (execa `shell:true`, `extendEnv:true`) instead.

## Why
"Spawning a subprocess" is not one concern. AI-host spawning and local-trusted-command spawning have **opposite** security postures: strip-env-because-output-leaves-the-machine vs full-env-because-it's-the-adopter's-own-command. A shared helper would force one posture onto both.

## Next time
Before reusing a subprocess/IO helper, check whose threat model it encodes. If the new caller's trust direction is inverted (trusted-local vs untrusted-egress), fork a new module — don't widen the hardened one. Two smaller adjacent learnings from the same task: (1) a *reusable* runner's "never throw" contract must be enforced at the call loop, not just in the default impl, so it holds for any injected impl (Codex review-impl); (2) for an optional config block, `Schema.optional()` + `.min(1)` keeps "unset = skip" distinct from "configured but empty = error" — don't `.default({})`.
