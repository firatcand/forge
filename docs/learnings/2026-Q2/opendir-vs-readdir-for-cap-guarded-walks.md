# `opendirSync` vs `readdirSync` for cap-guarded fs walks
> 2026-05-17 · FORGE-114 · tags: [orchestrator, security, defense-in-depth, fs-walking]

## What we expected
A `DIGEST_MAX_FILES = 1000` cap inside a recursive directory walker would bound work on a maliciously large spec/ subtree.

## What happened
Codex (second-opinion review) caught that `readdirSync(dir)` materializes the full directory listing into a JS array before the cap loop can engage. A directory with millions of entries OOMs or blocks the event loop before the cap fires. Switching to `opendirSync(dir).readSync()` in a while-loop fixed this — each call returns one entry, so the cap engages at entry N regardless of how many siblings exist.

## Why
`readdirSync` is the obvious "list a directory" API but its eager materialization makes it unsafe as the *first* operation inside a defensive cap. The cap can only protect work after the array exists. `opendirSync` / `Dir.readSync` are the streaming-iterator equivalents — they bound work AT the boundary.

## Next time
When adding caps to a fs walker, audit the cap engagement point. If the cap sits inside a loop over an already-materialized list (`readdirSync`, `glob`), the cap is decorative — the OOM window is before it. Use streaming iterators (`opendirSync().readSync()`) so the cap fires at the boundary.

See also: [[link-vs-rename-for-never-overwrite-invariant]], [[codex-on-security-paths-even-when-critical-md-stale]]
