# Dual source of truth in worktree creation produces phantom diffs
> 2026-05-18 · FORGE-136 · tags: [debugging, worktree, hydration, conditional-bugs, dogfooding]

## What we expected

`forge orchestrate ensure-worktree` would create a coherent worktree: HEAD content matches working-tree content. A `git diff` immediately after creation should be empty.

## What happened

Real-world repro during a `/pickup-task` on 2026-05-18 surfaced a phantom 7-line diff against `CRITICAL.md` the instant the worktree appeared. The bug was **conditional** — clean main, clean working tree, but a still-unmerged sibling branch (`feat/FORGE-88-iharness-adapter`) had touched the same file. Engineering a clean repro required forcing divergence between two specific commits — see "Repro technique" below.

Root cause: the verb had **two independent sources of truth** for "what is main":

1. `base` (default `origin/main`, can be overridden via `--base`) → consumed by `git worktree add -b <branch> <path> <base>` to populate HEAD + working tree
2. `mainWorktree` (= local main checkout) → consumed by `workspace.create()`'s hydration loop to `copyFileSync` "project meta" (CLAUDE.md, CRITICAL.md, spec/*.md, plans/*) on top of the just-checked-out tree

When the two resolve to different revisions for the same tracked file, the second write loses agreement with the first. The new worktree is born with a `git diff` between its HEAD (from `base`) and its working tree (overwritten by hydration). Committing it would silently revert whichever commit `base` was ahead of.

## Why

The hydration loop was written when forge's project meta was largely gitignored (`spec/*.md` was in `.gitignore` early on). Over time, the framework migrated to tracking spec files via `package.json#files` allowlist + npm-pack gate (FORGE-112), and `CLAUDE.md` + `CRITICAL.md` had always been tracked. But the hydration plan kept copying them anyway — defensive over-hydration that became silent corruption once the source-of-truth split mattered.

Three reinforcing pressures hid this for weeks:
1. In **steady state**, `base = origin/main = local main` so the two sources collapse to one byte-for-byte — no diff, no symptom.
2. The bug **only fires during a merge-train window**: another PR just merged on GitHub, the new worktree's `base` (origin/main) advances to the merge tip, but local main hasn't been `git pull`'d yet. Most adopters pull immediately on PR-merge notifications, so the window is small.
3. The bug **looks like ordinary editor diff noise** if the developer doesn't `git diff` before their first commit. The 7-line removal was caught only because the developer recognized the harness block they'd just merged.

## Next time

**Bug class signal.** Any code path that places content via two independent mechanisms (git checkout + filesystem copy, schema migration + ORM cache, config file + env var override, …) needs an explicit single source of truth or an explicit reconciliation step. Look for "we already have X, but let's also copy from Y" patterns — they're load-bearing only because the two stay in sync most of the time. When they don't, the bug looks conditional and the symptom looks like editor noise.

**Repro technique for conditional worktree-creation bugs.** Use `--base <old-sha>` to engineer divergence: pick a historical commit where the file you care about has *known different content* than current main, pass it as base, observe the diff. This is a deterministic, no-side-effects substitute for re-creating the merge-train timing window:

```
node dist/bin/forge.cjs orchestrate ensure-worktree \
  --task FORGE-9001 --base <old-sha-with-divergent-content> --json
git -C .forge/worktrees/FORGE-9001 diff -- <tracked-file>
```

Pre-fix this produced a non-empty diff; post-fix it's clean. Symmetric: this also exercises the hydration-of-untracked-meta path because untracked files at main's working tree DO flow through. Captured as the FORGE-136 regression test pattern in `test/unit/workspace.test.ts`.

**Doc accuracy lesson** (Codex 2nd-pass nit). When documenting a filter implementation, describe the **mechanism** the code uses, not the **intent** it was written to satisfy. The original §Hydration prose said "only genuinely gitignored files survive" — the code actually filters on `!tracked.has(item.relative)`, which is broader. For forge's own repo the two sets collapse; for adopter repos with different gitignores they diverge silently. Reviewers (human or LLM) read the doc as a contract and will be wrong about edge cases your code DOES handle (or doesn't).

**Related learnings:**
- [[worktree-hydration-runbook]] — git-common-dir resolution is the related "where does main live" pattern
- [[worktrees-blind-to-gitignored-context]] — the original reason hydration exists at all
- [[re-hydration-must-preserve-tracked-marker-files]] — sibling lesson: hydration must respect what git already placed
- [[codex-finds-bugs-tests-dont]] — Codex's "untracked vs gitignored" doc-accuracy catch was the same class of independent-second-pass review that tests miss
