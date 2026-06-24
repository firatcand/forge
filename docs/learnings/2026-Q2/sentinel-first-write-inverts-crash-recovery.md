# Sentinel-first write order inverts crash recovery when the sentinel is the comparison key
> 2026-05-21 · FORGE-153 · tags: [backend, cli, atomicity, codex-review, file-io]

## What we expected
The design plan said: "stamp `.forge/.version` BEFORE rewriting `.forge/CONTEXT.md` so a mid-flight crash leaves the next `upgrade` in a state where the SHA mismatch alone triggers a re-run (idempotent recovery)." That sounded right — `.version` is the cheap stamp, write it first as a sentinel so the bigger file's mismatch signals incomplete work to the next invocation. I copied the pattern into `upgrade.ts` with a comment crediting plan §4c.

## What happened
Codex's round-1 review caught the inversion. The edit-detection logic in the same function uses `versionsMatch = (onDisk.version === bundledVersion)` as a guard. Post-crash with sentinel-first order:
- `.forge/.version` = bundled (just written before crash)
- `.forge/CONTEXT.md` = stale (write didn't happen)
- Next `upgrade`: `versionsMatch=true` + SHA mismatch → refuses as "user edit" with exit 1

Recovery requires `--force`, which is the opposite of idempotent. Three full test files (1471 tests, 30 of them upgrade-specific) didn't catch this because none of them simulated the post-crash state.

## Why
Sentinel-first works when the sentinel is purely informational (the next invocation reads it and acts on it, but no other code interprets it). It inverts when other logic uses the sentinel as a comparison axis. In this case the edit-detection's `versionsMatch` predicate treats the sentinel as ground-truth ("if .version matches bundled, the file SHOULD be clean"), so the sentinel-first crash state looks identical to "user edited the file post-upgrade." There's no way to tell apart "I crashed mid-write" from "the user deliberately edited" without an additional in-progress marker.

The fix is to write the comparison-bearing file (`CONTEXT.md`) FIRST using `writeAtomic` (rename-based, so partial writes are impossible). Then stamp the sentinel. Crash between the two leaves CONTEXT.md correct and `.version` stale → the next upgrade's `else` branch sees SHA-match and silently bumps the stamp. Idempotent.

## Next time
Before adopting a "stamp sentinel first" pattern, check: **does any other code path use the sentinel as a comparison or guard?** If yes, the sentinel-first order will misclassify crash states. Default to writing the comparison-bearing content first, then the sentinel — the rename-atomicity of `writeAtomic` makes the content write effectively transactional, so the only crash window is between content-done and sentinel-done, which is exactly the state your existing logic should handle as "stale-but-clean."

Also: when copying a rationale comment from a plan doc, treat the comment as a claim to verify against the current code, not a fact. Plans assume an idealized impl; deviations elsewhere in the same function can invalidate the rationale (see [[plan-rationale-rot-when-deviating]]).
