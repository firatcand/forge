# /tmp realpath canonicalization breaks symlink-target assertions in farm tests
> 2026-05-30 · FORGE-159 · tags: [testing, gotcha, filesystem]

## What we expected
A test that creates a forge-style symlink in a tmpdir farm and asserts `classifyHostFarm` counts it as forge-owned should just pass.

## What happened
It counted 0 forge-owned. The provenance check compares `readlink(dest)` against `relative(dirname(dest), src)`. The test built the symlink target from the raw `mkdtemp` path (`/var/folders/...`), but production canonicalizes via `realpathSync` first (`/private/var/folders/...` on macOS) — the `..` depth differs by one component, so the stored relative target never matches.

## Why
macOS `/tmp` and `/var` are symlinks to `/private/...`. `skill-farm.ts` already documents this and canonicalizes both cwd and packageRoot; the test didn't mirror that, so the two sides computed different relative paths.

## Next time
In any test that asserts on symlink relative-targets, canonicalize the tmp root with `realpathSync(freshDir())` (and `realpathSync` the packageRoot) exactly as production does — before computing the symlink target. Don't assume `mkdtemp` returns a canonical path.
