# TOCTOU between statSync and readFileSync leaks raw fs errors

> 2026-05-12 · FORGE-18 · tags: [filesystem, error-handling, toctou, codex-finding, security]

## What we expected
Wrap `statSync` in try/catch → `SecretsError` with `MISCONFIGURED` code for bad paths. `healthCheck()` returns `{ ok: false }` for all bad-config cases per documented contract.

## What happened
Only `statSync` was wrapped. `readFileSync` on the next line threw raw fs errors when: path is a directory (EISDIR), perms revoked between calls (EACCES), or file deleted in the stat→read window (ENOENT race). `healthCheck()` rethrew. Contract silently broken.

## Why
Every filesystem call in a chain can fail independently. The TOCTOU window between stat and read exists even on local filesystems (concurrent processes, symlinks, perm changes). Wrapping one call in the chain doesn't protect the others.

## Next time
Wrap EVERY fs call in the same try/catch pattern — never assume "stat succeeded so read will too". Add an explicit test for "path is a directory" (the cheapest TOCTOU-class regression). When a function documents a "always returns X for bad cases" contract, audit every throw site, not just the obvious one.
