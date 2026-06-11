# Batch 1 — worktree hardening fixes (FORGE-139 / 140 / 142 / 70)

Consolidated plan for a themed batch of four S-sized hardening tickets, implemented
in worktree `.forge/worktrees/FORGE-139` on branch `feat/hardening-worktree-fixes`.

Gates: `npm run typecheck` clean, full `npm test` 0 fail, `npm run lint` no errors.

---

## FORGE-139 — `gc --remove-worktrees` orphan branches

### Defect evidence
- `src/cli/orchestrate/gc.ts` `runRemoveWorktrees()` calls
  `cleanup(cand.task_id, { root, deleteBranch: false })` (line ~713). By design
  (FORGE-116 delta 6) the verb removes the worktree only and never touches the
  branch. The existing test `remove-worktrees: happy path — shipped task removed,
  branch SURVIVES` asserts this.
- Consequence: when a worktree is removed but its `feat/<id>` branch was created
  by `ensure-worktree` and is now fully merged into `main` (the shipped case),
  the local branch lingers forever. Over many tasks these accumulate.
- The divergence reconciler's `prune_branch` row (row 9, `src/orchestrator/gc.ts`)
  only fires from a tracker snapshot, which the CLI shim currently builds empty —
  so it never prunes these branches either.

### Fix (minimal, contract-consistent — verb must NEVER `-D`)
- Add a `deleteMergedBranch?: boolean` option to `workspace.cleanup()`. When set
  (and `deleteBranch` is not), after the worktree is removed it runs
  `git branch -d <branch>` (safe, merged-only `-d`, never `-D`). If git refuses
  (branch not fully merged), it is reported as `branchDeleted: false` plus a new
  `branchRetainedReason` field — NOT an error. The existing `deleteBranch` (`-D`)
  path is untouched (only explicit callers use it; the verb does not).
- Extend `CleanupResult` with `branchRetainedReason?: string`.
- Add an opt-in `--prune-merged-branches` flag to `gc --remove-worktrees`
  (`src/cli/orchestrate/index.ts`). When present, `runRemoveWorktrees` calls
  `cleanup(..., { deleteBranch:false, deleteMergedBranch:true })` and records a
  `branchDeleted` / `branchRetained` field per result in the envelope. Default
  (flag absent) is unchanged — branch survives.
- Extend `RemoveWorktreesResult` with `branchDeleted?: boolean` and
  `branchRetainedReason?: string`. Plumb the new option through
  `OrchestrateGcOptions.pruneMergedBranches`.

### Tests (`test/unit/cli/orchestrate/gc.test.ts`)
- `remove-worktrees: --prune-merged-branches deletes a fully-merged branch` —
  merged `feat/WT-...` branch is `-d` deleted after removal.
- `remove-worktrees: --prune-merged-branches RETAINS an unmerged branch (never -D)` —
  branch with unmerged commits survives, `branchRetained` reported, exit 0.
- `cleanup — deleteMergedBranch deletes merged, retains unmerged` (workspace.test.ts).

---

## FORGE-140 — `ensure-worktree --repo-root` relative-path fix

### Defect evidence
- `src/cli/orchestrate/ensure-worktree.ts` resolves `repoRoot = path.resolve(opts.repoRoot)`.
  `path.resolve` with a single relative arg anchors on the implicit
  `process.cwd()`. The dispatcher (`DispatcherOpts.cwd`) injects a cwd that is the
  contract anchor for every other flag (`resolveForgeDir(rest, opts.cwd)`), but
  the ensure-worktree handler never forwards `opts.cwd` and the runner ignores it.
- When the injected cwd differs from `process.cwd()` (tests, future embedders, a
  caller that chdir'd), a relative `--repo-root` resolves against the wrong base →
  worktree placed under the wrong tree / manifest `sourceMainWorktree` wrong.

### Fix
- Add optional `cwd?: string` to `EnsureWorktreeArgsSchema` (defaults to
  `process.cwd()` inside the runner — preserves today's behavior).
- Resolve repo root against that cwd: `path.resolve(cwd, opts.repoRoot)`.
- Handler forwards `opts.cwd` into `runOrchestrateEnsureWorktree`.

### Tests (`test/unit/cli/orchestrate/ensure-worktree.test.ts`)
- `ensure-worktree: relative --repo-root resolves against injected cwd, not process.cwd` —
  pass a relative repoRoot + an injected cwd pointing at the real repo while
  process.cwd() is elsewhere; assert the worktree lands under the real repo.

---

## FORGE-142 — hydration must skip git submodules

### Defect evidence
- `src/core/workspace.ts` `planCopyRecursive()` recurses every subdirectory of the
  hydration roots (`plans/`, `docs/learnings/`). A git submodule is a directory
  whose `.git` is a FILE (a `gitdir:` pointer), not a directory. If a submodule
  lives under a hydration root, the walk copies the submodule's `.git` pointer
  file and its entire working tree into the new worktree — corrupting/mis-copying
  the submodule (the copied `.git` pointer is meaningless in the new location).

### Fix
- Add `isSubmoduleDir(dir)` helper: a directory containing a `.git` entry that is
  a FILE (not a dir) is a submodule boundary. `planCopyRecursive` skips recursing
  into such directories entirely (the directory itself is not copied).

### Tests (`test/unit/workspace.test.ts`)
- `create — hydration skips a git submodule directory under plans/` — simulate a
  submodule (`plans/vendor/.git` is a FILE) with a tracked-looking file inside;
  assert none of the submodule's contents appear in the hydrated worktree and the
  rest of `plans/` still hydrates.

---

## FORGE-70 — `/pickup-task` must install deps in the fresh worktree

### Defect evidence
- `skills/pickup-task/SKILL.md` creates + hydrates the worktree (step 5) then jumps
  straight to learnings + a `cd … && claude` next-step block. It never instructs
  installing dependencies. `node_modules` is gitignored and NOT hydrated (hydration
  covers only spec/plans/learnings/settings), so the fresh worktree has no deps and
  the first `/plan-task` → build/test commands fail.

### Fix (SKILL doc only)
- Add a new step after worktree creation: detect the package manager from the
  lockfile present in the worktree and run the frozen-install:
  - `package-lock.json` → `npm ci`
  - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
  - `yarn.lock` → `yarn install --immutable`
  - `bun.lockb` → `bun install`
  Note the same-machine speed alternative: symlink `node_modules` from the main
  checkout instead of a full install.
- Document the gc/wrap-up interaction: a symlinked or installed `node_modules` is
  gitignored, so FORGE-116's `gc --remove-worktrees` cleanup() GITIGNORED_LOSS
  check will refuse removal if it sees a node_modules symlink. Pre-cleanup step:
  remove the `node_modules` symlink (or let the operator) before `/wrap-up` runs
  `gc --remove-worktrees`.

### Tests
- Doc-only change. Add a contract assertion to the existing
  `test/unit/skills/wrap-up-contract.test.ts` neighbor if a pickup-task contract
  test exists; otherwise assert SKILL.md contains the package-manager detection
  matrix + node_modules cleanup note via a small content test.
