---
name: learn
description: Write a learning entry capturing what surprised us, what we'd do differently. Auto-suggested by /ship if task was notable.
tools: Read, Write, Bash(git*)
subagent: learning-curator
---

# /learn

Delegate to `learning-curator`.

## Triggers (any one makes the task "notable")

- Investigation took > 30 min
- > 2 fix attempts before success
- Surprised by behaviour
- Found a non-obvious gotcha
- Made a non-trivial trade-off
- Bootstrapped something new (test framework, CI, infrastructure)

## Process

1. Read the last commit + PR description + investigation file (if exists).
2. Extract:
   - What we expected
   - What actually happened
   - Why
   - What we'd do differently
3. Tag with relevant types.
4. **Resolve the canonical learnings path.** `docs/learnings/` is gitignored
   (forge-dogfood publish-hygiene rule), so its single source of truth is the
   **main checkout's** `docs/learnings/` tree — *not* the working directory.
   `/pickup-task` hydrates worktrees by `cp -r` from the main checkout
   (`skills/pickup-task/SKILL.md` lines 47–53), and `/learn` must mirror that
   contract on the write side. See `spec/SPEC.md §Learnings store` for the
   canonical-store rule and why.

   Resolve the main checkout's absolute path via `git rev-parse --git-common-dir`
   (which always resolves to the main checkout's `.git` from anywhere — main or
   worktree). Compare against `pwd -P` so symlinked paths (e.g. macOS
   `/var` ↔ `/private/var`) don't trigger a spurious double-write:

   ```bash
   GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
   MAIN_ROOT="$(cd "$(dirname "${GIT_COMMON_DIR}")" && pwd -P)"
   PWD_REAL="$(pwd -P)"
   QUARTER="2026-Q2"   # or current quarter, e.g. "$(date -u +%Y)-Q$((($(date -u +%m)-1)/3+1))"
   SLUG="kebab-case-slug-from-title"
   mkdir -p "${MAIN_ROOT}/docs/learnings/${QUARTER}"
   ```

5. **Refuse on collision.** If `${MAIN_ROOT}/docs/learnings/${QUARTER}/${SLUG}.md`
   already exists, stop and surface the conflict — pick a different slug, or
   `Edit` the existing learning instead of writing a new one. Do **not**
   silently overwrite a prior learning.

6. **Write the canonical record first** to the main checkout's absolute path
   using the `Write` tool. This is the load-bearing write; do not skip it even
   on errors elsewhere:

   ```
   Write tool → ${MAIN_ROOT}/docs/learnings/${QUARTER}/${SLUG}.md
   ```

7. **Mirror to the worktree path** only if `MAIN_ROOT != PWD_REAL` (i.e. you
   are running from a worktree, not the main checkout). The mirror exists so
   that `Read ./docs/learnings/${QUARTER}/${SLUG}.md` succeeds in the same
   session; it is not the canonical record. If the mirror write fails, the
   canonical write at step 6 is unaffected:

   ```
   if [ "${MAIN_ROOT}" != "${PWD_REAL}" ]; then
     mkdir -p "${PWD_REAL}/docs/learnings/${QUARTER}"
     # then: Write tool → ${PWD_REAL}/docs/learnings/${QUARTER}/${SLUG}.md
     # (same content as step 6)
   fi
   ```

8. Output the canonical path (and the mirror path when one was written), so
   the user can see exactly where the learning landed:

   ```
   ✓ learning written: ${MAIN_ROOT}/docs/learnings/${QUARTER}/${SLUG}.md
     mirrored to:      ${PWD_REAL}/docs/learnings/${QUARTER}/${SLUG}.md   (worktree)
   ```

## Format

```markdown
# {Slug title}
> {ISO date} · {LINEAR-ID} · tags: [foundation, testing]

## What we expected
[1-2 lines]

## What happened
[2-3 lines]

## Why
[1-2 lines]

## Next time
[1-2 lines]
```

## Retrieval

`/pickup-task` reads recent learnings tagged with the new task's type from the
main checkout's canonical store and injects them into context. The system gets
smarter over time. See `spec/SPEC.md §Learnings store` for the full
canonical-store contract.
