# Symlink provenance is per-install, not per-package-name
> 2026-05-30 · FORGE-159 · tags: [architecture, gotcha, cli]

## What we expected
`forge status` run in the forge repo would report its `.claude/skills/` symlinks as forge-owned.

## What happened
It reported them as user-owned. The farm symlinks point at the GLOBALLY installed forge (`/opt/homebrew/.../node_modules/@firatcand/forge/skills/`), but the local dev build's `locatePackageRoot()` resolves to the local repo — so the readlink targets don't match and the entries classify as user-owned.

## Why
`isForgeOwnedSymlink` (reused as the single source of truth, also used by `pruneHostFarm`) defines forge-owned as "points at THIS package's source." A farm created by a different forge install than the one inspecting it won't match. This is correct-by-design (conservative: never delete/claim what another install made) and exact in a normal adopter project (one forge install throughout) — it only surprises when dogfooding a local dist against a globally-created farm.

## Next time
When provenance == exact-target-match, expect dev-build-vs-global-install discrepancies and don't "fix" them by widening to package-name matching — that would diverge the report from what prune actually deletes. Document the same-install caveat at the check.
