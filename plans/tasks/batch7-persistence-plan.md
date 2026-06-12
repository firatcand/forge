# Batch 7 — persistence hardening (FORGE-118, FORGE-85)

**Branch:** `feat/hardening-persistence` · **Worktree:** `.forge/worktrees/FORGE-118`
**User decisions:** FORGE-118 = withRetry + dedup last-wins + claim-token CAS (provider-agnostic). FORGE-85 = soft rotation (one generation, readers merge).

## FORGE-118 — tracker body-mutation hardening (6 sub-items)

1. **withRetry sweep** — wrap the read AND write legs in `this.withRetry(op, …, this.retryOpts)` (model: linear listActiveIssues 647–671) for: Linear `setBlockedBy` (1060–1118), Linear `updateIssueBody` (1125–1167), GitHub `setBlockedBy` (837–913), GitHub `updateIssueBody` (920–989), AND GitHub `setClaimFence` (998–1046 — scout found it lacks the withRetry Linear's setClaimFence has; same inconsistency class, in scope). Tests: retry-on-RATE_LIMITED per method per adapter (5 tests minimum — sequenced mocks already support error-then-success).
2. **Footer dedup last-wins** — `src/trackers/footers.ts` `parseExtraForgeFooters` (139–150): dedup by KEY keeping the LAST occurrence; FIX the line-138 comment ("the serializer dedups upstream" — false). Round-trip test with seeded duplicate asserts single emission.
3. **Trailing-footer-block-only parsing** — same function: only PROMOTE `<!-- forge:* -->` comments from the trailing contiguous footer region at the END of the body (whitespace/comment-only tail) into managed footers. **Preservation policy (pre-review major): legacy NON-trailing forge comments are neither promoted NOR deleted — they stay in the body text verbatim** (the strip regexes used by serializeWithForgeFooters must be scoped the same way so a mid-body comment isn't stripped from the prose while no footer re-emits it — that would silently destroy legacy data). A fenced ```` ``` ````-block example mid-body must NOT round-trip into a real footer AND must remain in the body. Tests: fenced-block false positive (stays in body, no footer emitted); legacy mid-body real forge comment preserved in place; trailing footers still parsed; upsertClaimFooter round-trip unchanged.
4. **Claim-token CAS (user decision)** — `updateIssueBody(issueId, body, opts?: { expectedClaim?: ClaimFenceData })` on the Tracker interface (optional param, additive): when provided, the adapter parses the fresh-read body's `forge:claim` footer via `parseClaimFooter` (footers.ts 196–202) and REFUSES when a footer exists with a different `claimId` (footer absent or matching → proceed; the fence is advisory).
   - **Error code (pre-review major):** add `'CLAIM_MISMATCH'` to the TrackerErrorCode union in src/trackers/errors.ts — TrackerError has NO retriable flag; rely on the existing default non-retriable semantics and make sure withRetry's isRetriable classification does NOT retry it (test).
   - **Notion (pre-review major):** Notion's updateIssueBody does NOT use footers.ts (metadata lives in page properties) — the shared-check claim was wrong. Notion accepts the optional param in the signature but THROWS a typed not-supported TrackerError when expectedClaim is actually provided (honest failure, no silent ignore); property-scheme CAS is out of scope.
   - Linear + GitHub implement the real check. Callers are NOT wired in this batch (documented single-writer contract stands; mechanism + tests land now) — say so in the PR and the Tracker jsdoc. Tests: mismatching footer refused (both adapters), matching/absent proceeds, Notion throws when provided, CLAIM_MISMATCH never retried.
5. **Linear byte cap** — ticket premise is STALE: linear.ts 126–130 now documents the 65_536 cap as "sourced from observed validation errors". Keep the cap; verify the comment cites the sourcing claim clearly; no behavior change. Record the resolution in the PR (ticket option (a), already satisfied by the existing comment).
6. **README adapter-matrix AC** — OBSOLETE: Notion shipped (FORGE-117); docs/trackers/README.md 7–11 correctly lists all three live; no planned-not-launched state exists to flag. Record as overtaken-by-events in the PR; no edit.

## FORGE-85 — JSONL soft rotation (user decision)

- New settings field `agents.log_rotate_max_bytes: z.number().int().positive().default(10_485_760)` in AgentsSchema (settings.ts 91–201; `.default({})` on agents means NO SETTINGS_DEFAULT_BLOCKS change — verify).
- Shared helper (new `src/orchestrator/jsonl-rotate.ts` or colocated): `rotateIfNeeded(path, maxBytes)` — when the file's size ≥ maxBytes BEFORE an append, rename `<file>` → `<file>.1` (overwriting any prior `.1`; single generation) and start fresh. Rename-based, never copies.
- **Interprocess race guard (pre-review major):** rotation happens only while holding `<file>.rotate.lock` created O_CREAT|O_EXCL; if the lock exists → SKIP rotation for this append (someone else is rotating; a slight size overshoot is acceptable); re-stat the size UNDER the lock before renaming (double-check); remove the lock in finally; break stale locks older than ~30s. Two concurrent rotators must never destroy a generation (process B renaming A's fresh current over `.1`). Context that bounds the risk: events.jsonl is per-attempt and lease-fenced (effectively single-writer); claim-history.jsonl per-task can see acquire/steal/release from different processes — the lock-or-skip covers it. Test: simulated second rotator (pre-created lock) → append proceeds without rotating, no data loss.
- Writers: `appendAttemptEvent` (attempt-events.ts 62–154) and `appendClaimHistory` (leases.ts 342–374) call rotateIfNeeded before opening for append. appendClaimHistory stays best-effort (rotation failure swallowed like its writes); appendAttemptEvent surfaces rotation errors like its existing IO errors.
- Readers MUST merge rotated + current:
  - `readAttemptEvents` (attempt-events.ts 180–216): read `<file>.1` first (if present) then `<file>`, concatenated.
  - **`readLastClaimHistoryEntry` (leases.ts 297–338) — correctness-critical:** generation continuity breaks if rotation just happened and the last entry lives in `.1`. Walk current file backwards; if the current file is ENOENT, EMPTY, or has no parseable entry → fall back to `.1` (explicit ENOENT handling per pre-review). Tests: rotate-then-acquire continues the generation; rotation BETWEEN the current read and the fallback read still yields a generation (no perfect snapshot without locking — assert no RESET, not exact ordering).
- Threshold plumbed from settings where the writers have settings access; where they don't (deep orchestrator code), accept the value as a parameter with the schema default as fallback — keep the wiring minimal and explicit.
- gc note: with rotation, no "full log" divergence row is needed (self-healing) — record in PR (ticket asked to coordinate with gc; rotation obviates it).
- Tests: rotation triggers at threshold (size-seeded fixture), single generation (.1 overwritten on second rotation), readers merge both files in order, generation continuity across rotation, settings default + override parse.

## Gates

1. typecheck · 2. full suite 0 fail (baseline 2053/2027/26; expect +~15) · 3. lint · 4. build + doctor spec-code `drift: []`
5. Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8.

## Commit skeleton

```
fix(trackers): body-mutation hardening + JSONL soft rotation — FORGE-118/85

FORGE-118: withRetry on updateIssueBody/setBlockedBy (both adapters) +
  GitHub setClaimFence; footer dedup last-wins; trailing-footer-block-only
  parsing (fenced-code false positives eliminated); opt-in claim-token CAS
  on updateIssueBody (CLAIM_MISMATCH); Linear byte cap verified sourced
  (kept); README-matrix AC obsolete (Notion shipped)
FORGE-85: soft rotation for events.jsonl + claim-history.jsonl at
  agents.log_rotate_max_bytes (default 10 MB, single .1 generation);
  readers merge rotated+current; claim-generation continuity preserved
  across rotation
```
