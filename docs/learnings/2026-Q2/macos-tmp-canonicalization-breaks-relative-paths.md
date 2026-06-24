# macOS /tmp canonicalization silently breaks relative-path + startsWith logic

> 2026-05-30 · FORGE-158 · tags: [foundation, gotcha, fs, testing]

## What we expected
`abs.startsWith(`${cwd}/`)` and `relative(cwd, abs)` would produce clean
project-relative paths when storing farm entries in the manifest.

## What happened
`applySkillFarm` canonicalizes its cwd via `realpathSync` (to dodge a separate
idempotency bug), so its result paths come back as `/private/var/...` while the
caller's `cwd` was `/var/...`. `startsWith` failed → paths stored as ABSOLUTE
canonical → eject's empty-dir walk (`current.startsWith(cwd)`) never matched →
cleanup skipped. Only reproduced under `mkdtemp` in tests (macOS symlinks
`/tmp`→`/private/tmp`); never on a normal repo path.

## Why
On macOS `/tmp`, `/var`, `/etc` are symlinks. `realpathSync` resolves them;
plain `resolve`/`cwd` does not. Mixing canonical and non-canonical forms of the
same path breaks every `===` / `startsWith` / `relative` comparison between them.

## Next time
When computing a relative path against a root that some other function may have
`realpathSync`'d, relativize against `realpathSync(root)` too — never assume two
paths to the same file are byte-equal. Also: a test passing on a real repo path
but failing under `mkdtemp` is the tell-tale signature of this class of bug.
