# Batch 8 — settings/naming (FORGE-150, FORGE-161; FORGE-138 closes as dup)

**Branch:** `feat/hardening-settings-naming` · **Worktree:** `.forge/worktrees/FORGE-150`
**User decisions:** FORGE-150 ships NOW (overrides its v0.5 label) with the "everything is second-opinion, suggest is a mode" naming: `second_opinion.auto_enabled` + `FORGE_AUTO_SECOND_OPINION` + `forge second-opinion suggest`. Removal of legacy names: v0.5 (named in warnings).
FORGE-138 is a duplicate of shipped FORGE-124 (`rg auto_codex_token_cap src spec` = zero hits, verified) — no code; closes with the batch.

## FORGE-150 — second-opinion rename (deprecation-shimmed)

1. **Settings schema** (settings.ts 216–226, 274): add `SecondOpinionSchema = z.object({ auto_enabled: z.boolean().default(true) }).default({})` mounted as `second_opinion`. Legacy `codex` block: KEEP parsing but make it `.optional()` WITHOUT `.default({})` so it materializes only when present in the file. drift-detect.ts 83–87: SETTINGS_DEFAULT_BLOCKS replaces the `codex` entry with `second_opinion: { auto_enabled: true }`.
   - **Resolver changes ATOMICALLY with the schema change** (pre-review major): the sole unconditional `settings.codex` reader is codex-suggest.ts:135 — the new resolution (explicit `second_opinion.auto_enabled` → else `codex?.auto_codex_enabled` when block present → else true) lands in the SAME edit; `settings.codex` may now be undefined everywhere.
   - **Equality-invariant test rewritten deliberately** (pre-review major): migrate.test.ts currently asserts `parsed.codex` equals `SETTINGS_DEFAULT_BLOCKS.codex`; rewrite to assert `parsed.second_opinion` equals the new default block AND that `codex` is ABSENT from default parse output (optional, no default).
2. **CLI** (bin/forge.ts if/else chain, 165–169): new branch `command === 'second-opinion'` with subcommand `suggest <event>` (same behavior, file renamed/aliased to src/cli/second-opinion-suggest.ts or kept with both exports — implementer's call, keep diff readable). `codex-suggest` branch STAYS as a deprecation alias: prints ONE stderr warning (`forge codex-suggest is deprecated — use \`forge second-opinion suggest\`; removal in v0.5`) then delegates. `forge second-opinion` with no/unknown subcommand prints a small usage (exit 1) — do NOT collide with `forge orchestrate second-opinion` (different namespace, note in help text).
3. **Env**: read `FORGE_AUTO_SECOND_OPINION` first; legacy `FORGE_AUTO_CODEX` still honored — when the LEGACY var is the active disable source, print a one-line stderr deprecation note (suppressed by FORGE_QUIET=1). The printed suggestion line's disable hint becomes `FORGE_AUTO_SECOND_OPINION=0`.
4. **Migration** (drift-detect.ts detectSettings 243–321) — pre-review BLOCKER + major folded:
   - ONE COMPOSED EDIT: detectSettings produces a single settings finding whose `after` document reflects ALL settings changes together (legacy-rename mapping + any missing-block insertion). A file with `codex` but no `second_opinion` must yield ONE finding, not a rename finding plus a missing-block finding racing over the same file.
   - **Migrate KEEPS a mirrored `codex` block** (old-CLI compat, pre-review major): the edit writes `second_opinion.auto_enabled` from the legacy value AND retains `codex.auto_codex_enabled` mirrored to the same value (with a YAML comment `# legacy mirror — removed in v0.5`). An adopter on an old CLI then still honors their disable; block REMOVAL is v0.5's migrate. Doctor/deprecation messaging says "mirrored for compatibility; removed in v0.5".
   - Absent-both insertion seeds `second_opinion` only. FORGE-207 regex-codemod guards untouched (structured path).
5. **Doctor warning**: `orchestrate doctor` gains a warning when loaded settings carry a legacy `codex` block WITHOUT a `second_opinion` block ("legacy codex.* settings — run forge migrate; mirrored-compat removal in v0.5"). **Typed properly** (pre-review minor): extend the doctor result/warning type shape explicitly (warnings entries are typed, not bare strings pushed into a drift list). (No top-level doctor exists — orchestrate doctor is the doctor; record in PR.)
6. **Skills** (3 sites): plan-task:52, ship:64, update-spec:61 → `forge second-opinion suggest <event>`.
7. **SPEC.md**: §Auto-codex skill-level hooks (1034–1056) → retitle §Second-opinion suggest hooks; rewrite line 1044 (deferral sentence → shipped-in-FORGE-150 sentence with legacy-shim note); env table row 1205 → FORGE_AUTO_SECOND_OPINION primary with legacy row note; settings snippet 312–317 → second_opinion block (+ one-line legacy note).
8. **Tests**: both settings shapes parse with correct precedence (new wins; legacy-only honored; legacy false not silently lost); deprecation warnings fire exactly once per invocation (verb alias + env var); suggestion text snapshot (new hint); migrate rename detection round-trip (fixture with codex block → second_opinion in `after`, boolean preserved, false preserved); doctor legacy warning; skills' new invocation contract-tested if a pickup-task-style contract test pattern exists for these skills (check; else skip).

## FORGE-161 — tracked methodology-version pin

1. **Schema**: top-level `methodology_version: z.string().min(1).optional()` in SettingsSchema (tracked pin; absent = no warning, pre-pin repos stay quiet).
2. **Upgrade writes the pin** (upgrade.ts, near the .version stamps at 281/289): COMMENT-PRESERVING surgical edit — parse settings.yaml as a YAML Document, `setIn(['methodology_version'], bundledVersion)`, writeAtomic (FORGE-208 guards already cover the path). Do NOT reuse the applyAddAgent wholesale-rewrite pattern (it nukes adopter comments). **Ordering** (pre-review minor): the pin write happens AFTER any applyAddAgent/applyRemoveAgent settings rewrite in the same run (re-read the Document post-rewrite so neither write clobbers the other); add a test covering `upgrade --add-agent X` + pin in one run. Dry-run reports the would-be pin change; `changed` includes `.forge/settings.yaml` only when something actually changes.
3. **Warning hook** (bin/forge.ts after maybeWarnDrift:132): `maybeWarnMethodologyPin(command)` — best-effort read of `.forge/settings.yaml`: **lstat first (skip symlinks), size-bound the read (e.g. ≤256 KiB), yamlParse, and require `typeof methodology_version === 'string'`** before comparing (pre-review minor). Mismatch → one stderr line ("repo pins methodology X, installed CLI is Y — run forge upgrade (or align installs)"). Same suppressions as drift: skip for upgrade/migrate, FORGE_QUIET=1, swallow all errors. Absent file/field → silent.
4. **SPEC.md**: settings snippet gains the field; a short paragraph in the upgrade/§versioning area documents pin vs gitignored `.version` (pin = tracked, reviewable team contract; .version = local runtime marker).
5. **Tests**: upgrade stamps the pin and PRESERVES comments (fixture with comments asserts byte-survival of comment lines); mismatch warns once; match/absent silent; FORGE_QUIET suppresses; dry-run doesn't write.

## Gates

1. typecheck · 2. full suite 0 fail (baseline 2097/2071/26; expect +~15) · 3. lint · 4. build + doctor spec-code `drift: []`
5. Manual: `node dist/bin/forge.cjs second-opinion suggest plan-task` prints the new hint; `node dist/bin/forge.cjs codex-suggest plan-task` prints deprecation + the hint; `FORGE_AUTO_SECOND_OPINION=0` silences.
6. Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8.

## Commit skeleton

```
feat(cli): second-opinion naming + methodology pin — FORGE-150/161 (FORGE-138 dup-closed)

FORGE-150: second_opinion.auto_enabled / FORGE_AUTO_SECOND_OPINION /
  `forge second-opinion suggest` — legacy codex names honored with
  once-per-invocation deprecation warnings (removal v0.5); migrate renames
  the settings block; doctor flags legacy blocks; skills + SPEC updated
FORGE-161: tracked methodology_version pin in settings.yaml — upgrade
  stamps it comment-preservingly; CLI warns on pin↔installed mismatch
  (best-effort, FORGE_QUIET-suppressible)
FORGE-138: duplicate of FORGE-124 (token cap already removed) — verified
  rg-clean, closed without code
```
