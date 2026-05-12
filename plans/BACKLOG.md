# Forge.Next Backlog

Items deferred from current phases. Triaged before next phase planning. Not committed; serves as a memory aid so good ideas surfaced during execution don't fall out of context.

## Phase 3 enhancement candidates

### `touches:` field for tasks → file-overlap detection in `/pickup-task`

Add an optional `touches: [paths]` field to each task in `plans/phases.yaml`. `/pickup-task` filters out tasks whose `touches` overlap with currently-claimed-and-in-flight tasks.

**Why:** Today `/pickup-task` only checks the dependency graph. Two tasks with no explicit `depends_on` but touching the same file can be claimed in parallel by different sessions → merge conflict at PR time. Phase 2 dodges this via clean decomposition (each tracker adapter in its own file), but it's a real edge case for repos with less disciplined decomposition.

**Scope:** ~30 lines in `skills/pickup-task/SKILL.md` + an optional field in `src/schemas/phases.ts`. Warning emitted if no eligible non-overlapping task remains but blocked tasks exist.

**Acceptance sketch:**
- Schema accepts optional `touches: string[]` (glob-friendly).
- `/pickup-task` skips tasks whose `touches` overlap with any in-flight task's `touches`.
- Falls back to "no eligible task" with clear reason if everything overlaps.

## Ergonomic enhancements (sandbox + worktree polish)

### `/pickup-task` should print sandbox-grant snippet

When `/pickup-task` creates a worktree, its "Next:" output should detect whether the user's sandbox is enabled and, if so, print the `sandbox.filesystem.allowWrite` entry they need to add. Otherwise the first `git commit` inside the worktree fails with a cryptic EPERM and the user has to diagnose it.

**Detection logic:** read merged settings (`~/.claude/settings.json` + project `.claude/settings.json`). If `sandbox.enabled === true` and `~/repos/<project>/.git` is not already in `sandbox.filesystem.allowWrite`, append a one-line note to the existing "Next:" block:

> Note: sandbox is enabled. Add `"~/repos/forge/.git"` to `sandbox.filesystem.allowWrite` in `.claude/settings.json` so git operations succeed inside this worktree.

**Scope:** ~15 lines in `skills/pickup-task/SKILL.md` + a tiny settings-resolver helper. No new dependencies.

### `forge init` should scaffold `.claude/settings.json` with worktree-aware sandbox config

When `forge init` scaffolds a new project, drop a `.claude/settings.json` template that pre-grants write access to the project's `.git/` directory. Adopters who later run `/pickup-task` + `git worktree` don't hit mystery permission errors when they flip sandbox on.

**Template content:**

```json
{
  "sandbox": {
    "enabled": false,
    "filesystem": {
      "allowWrite": ["~/repos/<PROJECT_NAME>/.git"]
    }
  }
}
```

`enabled: false` is the safe default — opt-in. `allowWrite` pre-filled with the project's `.git` path so flipping `enabled: true` later Just Works for the worktree workflow.

**Scope:** ~5 lines added to scaffolding in P2-T06 (init flow). Parameterize `<PROJECT_NAME>` from the prompt answers.

## Phase 3 / v-next+1 candidates (deferred from FORGE-18 on 2026-05-12)

### `1password` secret-manager adapter

Original FORGE-18 scope included 1password alongside env_file and doppler. Slimmed on 2026-05-12 — FORGE-18 ships env_file only, with the `SecretsManager` interface and `core/secrets.ts` factory in place so adding adapters later is purely additive.

**Scope:** ~200 LOC + tests. Shells to `op` CLI via execa. Key shape `<item>/<field>`; adapter prepends `op://<vault>/` from config. Adapter classifies its own provider errors (AUTH / NOT_FOUND / TRANSPORT) via a `classifyProviderError(stderr, exitCode)` helper, following the FORGE-14 EUREKA pattern. Healthcheck via `op vault get <vault>` with actionable details ("not signed in", "vault missing", "op not installed").

**Trigger to pull from backlog:** first adopter request, or once forge has any team-setup user.

**Sketch (collapsed from the original FORGE-18 plan §2.4 OnePasswordSecretsManager):**
- Constructor: `new OnePasswordSecretsManager(config: OnePasswordSecrets, logger: Logger)`
- `get(key)`: `execa('op', ['read', \`op://\${vault}/\${key}\`])` → `stdout.trim()`
- Error classification: stderr `not signed in` → AUTH; stderr `couldn't find|isn't an item` → NOT_FOUND; else TRANSPORT/UNKNOWN
- Healthcheck: `op vault get <vault>`; surfaces install link if `ENOENT`

### `doppler` secret-manager adapter

Same story — deferred from FORGE-18.

**Scope:** ~150 LOC + tests. Shells to `doppler` CLI. Respects `DOPPLER_PROJECT` and `DOPPLER_CONFIG` env overrides. Uses `--plain` flag to get raw value.

**Sketch:**
- Constructor: `new DopplerSecretsManager(config: DopplerSecrets, logger: Logger)`
- Env override: `process.env.DOPPLER_PROJECT || config.project`; same for `DOPPLER_CONFIG`
- `get(key)`: `execa('doppler', ['secrets', 'get', key, '--plain', '--project', project, '--config', config])` → `stdout.trim()`
- Error classification: stderr `not found|does not exist` → NOT_FOUND; `unauthorized|token expired` → AUTH; project/config mismatch → MISCONFIGURED
- Healthcheck: `doppler secrets --project <p> --config <c> --only-names` (single call verifies CLI + auth + project + config)

### Extract `BaseSecretsManager` abstract class

Triggered when the second secret-manager adapter (1password or doppler) lands. Shared concerns: logger injection, `wrapExecaError`, `normalizeError(op, err, hint)` — mirrors `BaseTracker`. Keeps the EUREKA invariant: BaseSecretsManager does NOT sniff provider errors; adapters classify their own.

### Naming rename `EnvFileSecrets` → `EnvFileSecretsConfig`

Currently the secrets config types use no suffix (`EnvFileSecrets`, `DopplerSecrets`, `Secrets`); the tracker config types use `Config` suffix (`LinearTrackerConfig`, `TrackerConfig`). Rename for symmetry.

**Scope:** ~6 references in `src/schemas/settings.ts` exports + downstream consumers. Pure rename. ~10 LOC touched across maybe 5 files. Best done as a focused chore-PR alongside another schema-touching change to amortize the test-revalidation cost.
