# Worktrees

Forge uses git worktrees so that multiple Claude Code sessions can work on the same project at the same time without stepping on each other. If you've never used worktrees, this 30-second primer covers everything you need.

## What a worktree is

A worktree is a second checkout of the same repo, on a different branch, in a different directory — sharing the same `.git`. You can have one worktree on `feat/TLOG-103` while another is on `feat/TLOG-104`. Both can run `git log`, `git diff`, `git commit` independently.

It's like having two clones, except they share history. A commit on one worktree is instantly visible from the other (after `git fetch`-equivalent operations — but for local branches, instantly).

## Why forge uses them

The natural Claude Code workflow is one task per session. With branches alone, you'd have to `git stash` or commit-and-checkout to switch tasks. Worktrees mean each task gets its own directory and its own Claude session. You can run `/pickup-task` for two tasks in parallel, work on both, and `/ship` them independently.

## Directory layout

```
~/repos/
├── my-project/                          ← main checkout (on dev branch)
│   ├── .git/                            ← real .git directory
│   ├── src/
│   └── ...
│
└── my-project-worktrees/                ← sibling directory
    ├── TLOG-103/                        ← worktree for issue TLOG-103
    │   ├── .git                         ← FILE pointing to main .git
    │   ├── src/
    │   └── ...
    │
    └── TLOG-104/                        ← worktree for issue TLOG-104
        ├── .git
        └── ...
```

The `~/repos/{project}-worktrees/` directory is the convention. `/pickup-task` creates worktrees there automatically. You don't have to manage it manually.

## Common commands

```bash
# List all worktrees (run from any worktree of the project)
git worktree list

# Create a new worktree manually (forge does this for you via /pickup-task)
git worktree add ../my-project-worktrees/TLOG-105 -b feat/TLOG-105-foo dev

# Remove a worktree (after PR merged + branch deleted)
git worktree remove ../my-project-worktrees/TLOG-103

# Prune stale worktree refs (after manual deletes)
git worktree prune

# Forge convenience: clean up worktrees for branches gone upstream
source ~/.forge/lib/worktree-helpers.sh
worktree_cleanup            # dry-run
worktree_cleanup --apply    # actually remove
```

## Gotchas

**Shared hooks.** `.git/hooks/` lives in the main checkout and is shared. A pre-commit hook that runs `npm run lint` will execute in any worktree using that hook. Usually fine, sometimes confusing.

**Shared `.git`.** A `git gc` run in any worktree affects all worktrees. A `git reflog` shows commits from all branches across all worktrees. Generally helpful, occasionally surprising.

**Untracked files don't migrate.** A new file in `worktree-A/foo.txt` is invisible from `worktree-B/`. They live in different filesystem locations. Once you `git add` and commit, the commit is shared (after a `git fetch` or `git checkout` that updates the local branch).

**Two worktrees can't be on the same branch.** Git will refuse with "fatal: '<branch>' is already checked out at '<path>'". This is a feature — it prevents you from accidentally diverging the same branch in two places. If you need two worktrees on the same code, branch one of them: `git worktree add ../foo-2 -b experiment dev`.

**Stash isn't shared.** `git stash` is per-worktree on most git versions. If you stash in worktree A and check out worktree B, you won't see the stash. Use `git stash list` in the same worktree where you stashed.

**Hooks running in two worktrees simultaneously.** If you have two Claude sessions running tests in two worktrees at once, they share `node_modules` if you're using the main checkout's, but they each have their own working tree. With Vitest in watch mode in both, the watchers can fight. Either use separate node_modules per worktree, or run tests one at a time across worktrees.

## Cleanup discipline

Worktrees accumulate. After a PR merges and the branch is deleted on GitHub, the local branch and the worktree linger. The `worktree_cleanup` helper finds worktrees whose branches are gone upstream:

```bash
source ~/.forge/lib/worktree-helpers.sh
worktree_cleanup            # see what would be removed
worktree_cleanup --apply    # remove them
```

Or use the `commit-commands:clean_gone` skill (if you have the commit-commands plugin installed).

## When NOT to use a worktree

For tiny one-line fixes, the worktree overhead isn't worth it. Just commit on `dev` and ship. The principle is: worktrees are for tasks that will take more than 15 minutes and might be interrupted.
