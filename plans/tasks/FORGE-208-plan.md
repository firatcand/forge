# FORGE-208 — symlink-safe writes (default-deny writeAtomic + upgrade skip policy)

**Branch:** `feat/FORGE-208-symlink-safe-writes` · **Worktree:** `.forge/worktrees/FORGE-208`
**User decision:** fix before the CLI-UX batch; ships as **0.4.2**. Conservative v1: skip-with-notice for symlinked root files; "manage resolved target with inode dedup" is v0.5 follow-up; hardlink awareness is an accepted documented gap.

## Change 1 — default-deny in the primitive (`src/core/fs-atomic.ts`)

`writeAtomic` gains an lstat preflight BEFORE writing the tmp file:
```ts
let st; try { st = lstatSync(absPath); } catch { /* absent — fine */ }
if (st?.isSymbolicLink()) throw new FsWriteError('SYMLINK_TARGET_REFUSED', `refusing to write ${absPath}: target is a symbolic link — renaming over it would destroy the link and materialize a divergent regular file`, { path: absPath });
```
- New `FsWriteError` in `src/core/errors.ts`, house style (code union `'SYMLINK_TARGET_REFUSED'`, `details: Record<string, unknown>`); mirror `WorkspaceError` (which already has the `SYMLINK_REJECTED` precedent).
- Regular-file and absent-target behavior unchanged. Unit tests in NEW `test/unit/core/fs-atomic.test.ts`: refuses symlink target (typed error, code, path in details); plain file still written atomically; absent target still created.
- **TOCTOU comment required** (pre-review minor): the lstat→rename window means a symlink swapped in between is still replaced — acceptable for a local CLI (matches migrate.ts's posture), but the primitive must carry a short comment so readers don't mistake this for a complete no-follow guarantee.

## Change 2 — caller policy matrix (every plausible-symlink call site)

| Site | Policy |
|---|---|
| upgrade.ts step 7 root-file loop (:252–264) | **lstat pre-check; skip + notice, exit 0.** `skipped: CLAUDE.md (symlink → <target>) — forge does not manage symlinked root files; managing the target if enabled` on stderr. `continue` the loop. Do NOT abort the whole upgrade. |
| upgrade.ts step 8 .gitignore (:270) | same skip + notice, exit 0 |
| upgrade.ts `applyAddAgent` (:352) | **hard refusal, exit 1** — explicit user request targeting a symlink; message in migrate-claudemd style ("resolve the symlink or replace with a regular file first") |
| upgrade.ts settings writes (:360, :424) | hard refusal, exit 1 (consistent with migrate-claudemd M2) |
| eject.ts root file (:317) + .gitignore (:334) | catch FsWriteError → skip + notice (eject of a symlinked file would destroy the link; the block lives in the target) |
| scaffold.ts `appendLineIfMissing` (:229) + .gitignore (:476) | catch FsWriteError → skip + warning into init-warnings surface |
| scaffold.ts staged `rmSync`+`renameSync` promotion (:433/:459) | **same class of bug bypassing writeAtomic** — add an lstat guard: if `dest` is a symlink, skip + warning (do not rmSync the link). Scout-found; in scope because the primitive fix doesn't cover it. |
| upgrade.ts `applyRemoveAgent` root-file path | **hard refusal, exit 1** when the root file is a symlink — its `unlinkSync`/rewrite would destroy the parity link; same message style as add-agent (pre-review major #3) |
| migrate-claudemd.ts (:350/:353/:356/:362) | **upfront preflight refusal** (pre-review major #1): extend its existing M1/M2 precondition block to ALSO lstat-check `.forge/CONTEXT.md`, `.forge/.version`, and `.gitignore` BEFORE any write (incl. the .bak) — hard refusal exit 1 in its house style. Prevents a mid-migration FsWriteError after partial writes. |
| upgrade.ts step 0 | **upfront `.forge/settings.yaml` lstat refusal before parsing** (pre-review major #2) — exit 1 before ANY mutation (CONTEXT/root files/.gitignore). Test must assert nothing was written. |
| scaffold.ts init-warnings.md (:542) | loud propagation (forge-owned) — classified for completeness (pre-review minor) |
| migrate.ts (:341) | already guarded by `verifyBeforeWrite` lstat refusal — NO change; add nothing |
| reconcile.ts phases.yaml, apply-decision.ts spec/PRD/INDEX/journals, manifest.ts, amend-roadmap journals, CONTEXT/.version writes | **let FsWriteError propagate loudly** — forge-flow files; a symlink there is exotic and a loud typed error with a self-explanatory message is the correct behavior. No per-site code. Verify each surface doesn't swallow the error silently (errors propagate through existing emit/fail paths). |

`recentlyWritten` interaction: a skipped (symlinked) root file must NOT be added to `changed`; dry-run must report the identical skip notice.

## Change 3 — preflight/dry-run visibility

- In step 7/8, the skip notice prints in BOTH dry-run and real mode (same line).
- Test: dry-run `changed` list + skip notices == real-run `changed` list + skip notices on the symlink fixture (the ticket's dry-run-parity AC).

## Tests (extend test/unit/cli/upgrade/upgrade.test.ts; model on its mkdtemp `bootstrap()` helper and migrate-claudemd's existing symlink tests)

1. **Type-preservation property:** bootstrap variant with `CLAUDE.md → AGENTS.md` symlink (symlinkSync), both agents enabled. Record `lstat` type for every path in the repo before `upgrade()`; assert types unchanged after; assert AGENTS.md (real file) got its prefix block; assert CLAUDE.md is STILL a symlink pointing at AGENTS.md; assert notice on stderr; assert CLAUDE.md not in `changed`.
2. **Idempotency property:** `upgrade()` twice == once — second run reports zero `changed` entries and identical file bytes — on (a) regular topology, (b) symlink topology.
3. Dry-run parity (Change 3 test).
4. `writeAtomic` unit trio (Change 1).
5. add-agent onto a symlinked root file → exit 1, message, no write.
6. settings.yaml symlink → upgrade refuses (exit 1) before mutating anything.
7. .gitignore symlink → skipped + notice, exit 0, link intact.
8. scaffold staged-promotion guard: dest symlink survives init re-run (skip + warning).
9. eject on symlinked CLAUDE.md → skip + notice, link intact.
10. upgrade with symlinked `.forge/settings.yaml` → exit 1 upfront, NOTHING written (assert CONTEXT.md/.version/root files all untouched).
11. remove-agent on a symlinked root file → exit 1, link intact.
12. migrate-claudemd with symlinked `.gitignore` (or CONTEXT.md) → upfront refusal, no partial writes (no .bak created).

## Gates

typecheck · full suite 0 fail (baseline 1967/1941/26) · lint · build + doctor spec-code `drift: []` · manual: build, create a /tmp fixture repo with the symlink convention, run real `node dist/bin/forge.cjs upgrade` → symlink intact, notice printed; run twice → second run no-op.
Implementer: Fable 5 subagent (core-primitive blast radius). Cross-review: GPT 5.5 ≥8 gate.

## Commit skeleton

```
fix(core): writeAtomic refuses symlinked targets; upgrade skips symlinked
root files — FORGE-208

- default-deny lstat preflight in the primitive (FsWriteError
  SYMLINK_TARGET_REFUSED) — rename-over-symlink destroyed the link and
  materialized divergent content (CLAUDE.md → AGENTS.md parity repos)
- upgrade step 7/8: skip + notice (exit 0); add-agent/settings: hard refusal;
  eject/init: graceful skip; scaffold staged-promotion bypass guarded too
- property tests: lstat type before==after on every touched path; upgrade
  twice==once; dry-run list parity
- accepted gap (documented): hardlinks break silently on rename (nlink>1
  preflight is follow-up scope)
```
