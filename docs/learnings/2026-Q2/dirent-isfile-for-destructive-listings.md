# Use Dirent.isFile() when a directory listing feeds a destructive or all-or-nothing operation
> 2026-05-15 · FORGE-73 · tags: [orchestrator, filesystem, gc, fs-listing, defense-in-depth]

## What we expected
Filtering `readdirSync` results by `name.endsWith('.json')` is sufficient to identify JSON files for gc migration processing.

## What happened
A subdirectory named `something.json` is a legal POSIX artifact. `name.endsWith('.json')` passes it through the filter. When the gc migration called `linkSync` on that entry, it would throw `EISDIR`. Because the gc pass is all-or-nothing (abort on first failure), this single poisoned entry would leave all remaining valid legacy question files unmigrated — with no indication of which entry caused the failure.

## Why
Filename suffix is a naming convention, not a filesystem guarantee. `readdirSync` returns both files and directories; the suffix filter does not distinguish them. The failure mode is especially sharp here because: (a) the operation is destructive/irreversible (hardlinks + deletion), and (b) failure is not per-item — one bad entry aborts the whole pass.

This applies to any listing that feeds: gc/migration passes, batch deletes, bulk moves, or any loop where a mid-loop error leaves the system in a partially-modified state.

## Next time
Always use `readdirSync({ withFileTypes: true })` and chain `.filter(d => d.isFile())` before any suffix filter when the listing feeds a destructive or all-or-nothing operation:

```ts
readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isFile() && d.name.endsWith('.json'))
```

The cost is one boolean check per entry. The benefit is the operation cannot be poisoned by a directory entry with a matching suffix. Apply this pattern proactively — not only when you expect weird directory entries, but because you cannot control what ends up in a directory over time.
