# SPEC.md beats Linear AC when they disagree
> 2026-05-12 · FORGE-14 · tags: [spec, linear, process, dogfooding, foundation]

## What we expected
Linear FORGE-14 AC1 said the Tracker interface had 8 methods. We expected the ticket's acceptance criteria to be authoritative.

## What happened
spec/SPEC.md line 179 actually specifies 9 methods (adds `healthCheck`). Plan v1 reconstructed the interface from the Linear AC because SPEC.md is gitignored and invisible in worktrees. Plan v2 reconciled to SPEC's 9 once the file was located at `/Users/firatcandogan/repos/forge/spec/SPEC.md`. We shipped 9 and corrected Linear AC post-ship.

## Why
Forge dogfoods itself: `spec/` is gitignored by design, so worktrees never carry SPEC.md. Linear ACs are written before SPEC stabilizes and drift. The ticket looked authoritative but wasn't.

## Next time
Always read `/Users/firatcandogan/repos/forge/spec/SPEC.md` from the main repo before treating any Linear AC as ground truth. If they disagree, SPEC wins and the AC gets updated.
