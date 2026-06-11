# FORGE-109 — `forge migrate` (v0.2.x → v0.4 upgrade)

> Status: draft for Codex pre-opinion · Attempt 019eb63a-e036-7881-86c7-359806a0912d
> Architecture decisions confirmed by user 2026-06-11:
> 1. **Hybrid confirm UX** — chalk diff preview, then interactive y/N in a TTY; `--yes` and `--dry-run` flags for CI. Matches ticket "applies on accept" + upgrade's flag precedent.
> 2. **Missing settings.yaml → detect + delegate** — migrate reports it and points to `forge init`; never fabricates a config. Other signatures still migrate.
> 3. **`@inherit` → strip + marker + message** — line replaced with an HTML comment breadcrumb pointing at `/draft-design`; conversion itself stays /draft-design's job.
> 4. **Orphan orchestrator state → delegate to gc** — migrate detects legacy layouts and prescribes `forge orchestrate gc`; one owner for state reconciliation.

## What ships

| Artifact | Path |
|---|---|
| Entry + flow | `src/cli/migrate/migrate.ts` (detect → preview → confirm → backup → apply → report) |
| Pure detectors | `src/cli/migrate/drift-detect.ts` → `DriftSignature[]` |
| Pure rewriters | `src/cli/migrate/rewrites.ts` → `PlannedEdit { relPath, before, after, signature }` |
| Dispatch | `src/bin/forge.ts` — `else if (command === 'migrate')` before the unknown-command fallback + usage line |
| Tests | `test/unit/cli/migrate/migrate.test.ts` (+ drift-detect unit tests) with a v0.2.x fixture bootstrap |

Top-level command (like `init`/`upgrade`) — NOT an orchestrate verb; no CLI_VERBS/EXPECTED_BANDS registration (confirmed against registry.test.ts conformance scope).

## Drift signatures (detector → action)

| # | Signature | Detector | Action on apply |
|---|---|---|---|
| 1 | `missing-settings` | `.forge/settings.yaml` absent | Report + delegate: "run `forge init`". No write. Other signatures still proceed. |
| 2 | `settings-missing-blocks` | raw YAML top-level lacks any of `codex` / `decisions` / `doctor` | Insert the missing block(s) with the schema's documented defaults via the yaml Document API (`setIn`) — comment/order-preserving; then validate the WHOLE result against `SettingsSchema`; refuse this edit (manual-fix report) if the result still fails. |
| 3 | `design-inherit` | `^@inherit\s+…` lines in `spec/DESIGN.md` | Replace each line with `<!-- forge-migrate: '@inherit …' removed — pattern deleted in v0.4. Run /draft-design to generate a self-contained design system. -->` |
| 4 | `push-to-linear-refs` | literal `/push-to-linear` in scan scope (see below) | Textual rewrite → `/push-to-tracker` |
| 5 | `dropped-verbs` | in scan scope: `forge orchestrate next\b` → rewrite `claim`; `suggest-next` → rewrite `phases --ready`; `session-check` / `intent-detect` → **warn-only** (no auto-rewrite; ticket prescribes rewrites only for the renamed pair) |
| 6 | `missing-adr-template` | `templates/adr.template.md` absent | Copy from the installed package (reuse `locatePackageRoot` / template-loader machinery from upgrade/) |
| 7 | `legacy-orchestrator-state` | pre-v0.4 layout markers under `.forge/orchestrator/` (reuse gc's detector if exported; else its documented heuristic) | Report + delegate: "run `forge orchestrate gc --dry-run`". No write. |

**Scan scope for textual rewrites (4, 5):** root agent files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), `docs/**/*.md`, user skill trees (`.claude/**/*.md`, `.agents/**/*.md`, `skills/**/*.md`). Never `.git/`, `node_modules/`, `.forge/backup-*/`. Per-file size cap 1 MiB (skip + note). Symlinks refused per house style (lstat before read; skip with warning, never follow).

## Flow

1. Scan (pure, no writes) → `DriftReport`.
2. Nothing found → `✓ no v0.2.x drift detected — project is at v0.4 conventions` → exit 0.
3. Preview: chalk-colored per-file unified-style diff (red removed / green added) + delegated items listed separately ("manual follow-ups").
4. Gate: `--dry-run` → exit 0 after preview, no writes. `--yes` → proceed. TTY → y/N prompt (default N). Non-TTY without `--yes` → preview + exit 1 with `re-run with --yes` hint (abort-clean AC).
5. Backup: every to-be-modified file copied pristine to `.forge/backup-<ISO-timestamp>/<relPath>` BEFORE any write. Backup dir created only on accepted apply (reject leaves zero new state).
6. Apply: all edits via `writeAtomic`.
7. Report: per-signature ✓ lines + delegated follow-ups + backup path.

**Idempotency:** after a successful apply, detectors 2–6 find nothing (markers aren't re-flagged; blocks present; refs rewritten; template present). 1 and 7 are delegated reports — they repeat until the user runs init/gc, but cause no writes; exit stays 0 when only delegated items remain? **No** — exit 0 with the follow-up list (they're informational, not migrate's writes). Re-run after full follow-through → clean ✓.

## Failure / safety

- Reject (n / non-TTY) → no backup dir, no writes, exit 1.
- Apply is per-file writeAtomic after a full upfront backup; a crash mid-apply leaves originals in the backup dir and a re-run detects only the remaining signatures (each rewrite is idempotent on its own output).
- settings.yaml result re-validated against SettingsSchema before write (fail-closed → manual-fix report, other edits proceed).
- All paths `validateUnderRoot`; lstat symlink refusal on read AND write targets.

## Tests (v0.2.x fixture bootstrap: stale settings sans blocks, DESIGN with @inherit, CLAUDE.md + docs with /push-to-linear, custom skill with `forge orchestrate next` + `suggest-next` + `session-check`, no adr template)

1. Detect-all: every signature surfaces on the fixture (AC 1).
2. `--dry-run`: full preview, zero writes, exit 0.
3. Apply `--yes`: settings gains exactly the missing blocks (comments preserved, schema-valid); @inherit → marker; `/push-to-linear` → `/push-to-tracker` everywhere in scope; `next` → `claim`; `suggest-next` → `phases --ready`; `session-check` warned not rewritten; adr template copied byte-identical (ACs 2, 3).
4. Backup pristine: byte-compare originals (AC 4).
5. Reject (non-TTY, no --yes): exit 1, no writes, no backup dir (AC 5).
6. Idempotent: immediate second `--yes` run reports clean, writes nothing (AC 6).
7. Missing settings: delegated message, remaining signatures still applied.
8. Symlinked DESIGN.md: skipped with warning, not followed.
9. Oversized file in scan scope: skipped with note.

## Risks / notes

- v0.2.x settings may not parse under the current TrackerConfig shapes — block insertion works on the raw YAML Document precisely so we don't need a full parse first; final validation decides whether the result is announced as schema-valid or flagged for manual follow-up.
- `@inquirer/prompts` availability for the TTY confirm to be verified at implementation; fallback is node:readline (zero new deps — npm-size guardrail).
- gc detector reuse depends on what gc exports; worst case the heuristic is "presence of files gc's divergence table classifies as legacy v1" duplicated read-only.
