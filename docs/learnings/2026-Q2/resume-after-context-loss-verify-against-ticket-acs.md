# Resume after context loss: verify the branch against the ticket's ACs, not the branch name
> 2026-05-28 · FORGE-121 · tags: [integration, testing, workflow]

## What we expected
After an API 400 (corrupted thinking block) + `/clear` wiped the conversation, a single dangling `isScalar` import on the branch looked like an interrupted title-formatting edit. I reconstructed that intent, got user sign-off on it, and started implementing.

## What happened
The guess was wrong. Reading FORGE-121 from the tracker mid-`/ship` revealed its real acceptance criteria: preserve `depends_on` **block-style + per-item inline comments** on `--pull` — nothing to do with titles. The branch name ("preserve-reconcile-pull-formatting") was broader than and diverged from the ticket. We nearly opened a PR under FORGE-121 whose ACs were unmet.

## Why
A reconstructed narrative — and a branch name — are not the spec. The dangling import *was* genuinely the start of the depends_on work, but its purpose was only knowable from the ticket body. Compounding it: yaml v2 `map.set(key, str)` on an *existing* key mutates the node in place and preserves its quote style, so the "title-formatting" hypothesis wasn't even a real bug to begin with.

## Next time
On resuming lost-context work, diff the branch's actual changes against the tracker's acceptance criteria **before** building more or shipping — pull the ticket first, treat the branch name as a hint only. And when a fix makes a function "set-like," audit every producer/consumer for set-faithfulness: Codex needed three rounds here because the same re-diff-loop class hid first in the in-place writer (existing duplicates), then in the tracker-input mapper (`mapBlockerIdsToTaskIds` not deduping).
