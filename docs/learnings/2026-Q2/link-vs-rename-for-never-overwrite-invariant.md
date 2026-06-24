# `link(tmp, target)` + `unlink(tmp)`, not `rename`, when the invariant is "never overwritten"

> 2026-05-13 · FORGE-64 · tags: [filesystem, atomicity, race-condition, posix, spec-vs-implementation]

## What we expected
`spec/ORCHESTRATOR.md` §"File semantics" said: "All writes go to a `.tmp` sibling, `fsync`, then `rename` to the target." The very next row said `{question_id}.json` and `{answer_id}.json` are "never overwritten." Naive read: temp+fsync+rename gives us atomicity, and we'll layer a separate duplicate-id guard on top.

## What happened
POSIX `rename(2)` **silently overwrites** an existing target on Linux. So two concurrent writers contending on the same `question_id` would both pre-check that the target is absent, both `rename` their temp into place, and the second silently clobbers the first. The "never overwritten" rule is unenforceable with rename — any duplicate-id guard built on stat-then-rename has an open TOCTOU window between the two syscalls.

## Why
`rename` is the wrong primitive for this invariant. `link(tmp, target)` fails with `EEXIST` when the target exists, even under concurrent writes from different processes. Pair it with `unlink(tmp)` afterwards (link creates a second name for the same inode; unlink removes the temp name). The two-syscall cost buys OS-level enforcement of the invariant. Tradeoff: `link` is not supported on FAT/exFAT/some NFS — fine because `.forge/` lives next to `.git/` which already requires a local POSIX filesystem.

## Next time
Whenever a spec asserts a "never overwritten" / "exactly one writer wins" rule on filesystem state, the implementation primitive is `link`+`unlink`, not `rename`. The rename phrasing in any spec is a smell that the author was thinking about partial-write protection (which rename does give you) and conflated it with idempotence (which it doesn't). Update the spec at the same time as the code so the next reader doesn't have to discover the gap again. Also: test with `Promise.all` of N concurrent same-id writers and assert exactly one resolves — the easy bug is to test single-writer happy paths and assume concurrency works.
