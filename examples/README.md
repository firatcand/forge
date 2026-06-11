# Forge examples

Three frozen mini-projects, one per tracker backend. Each is a complete,
minimal Forge layout: a `.forge/settings.yaml`, a deterministic
`plans/phases.yaml` (2 phases × 3 tasks, fixed ids `P1-T01`..`P2-T03`), a
compact `spec/` (BRIEF/PRD/SPEC/DESIGN — the SPEC carries two real headings so
`§`-anchors resolve), a copy of `templates/adr.template.md`, an empty
`spec/decisions/` directory, and a `CLAUDE.md` stub.

| Directory | Tracker | Notable settings |
|---|---|---|
| `greenfield-github/` | GitHub Issues | `tracker.config.repo: acme/greenfield` |
| `greenfield-linear/` | Linear | `tracker.config.team_id` |
| `greenfield-notion/` | Notion | `tracker.config.database_id` only |

## They are test fixtures AND living documentation

These trees serve two purposes:

1. **Living documentation.** They show adopters what a freshly decomposed Forge
   project looks like for each tracker — the shape of `settings.yaml`, the
   `source` stanza in `phases.yaml`, the spec layout, and where ephemeral ADRs
   land (`spec/decisions/`).

2. **E2E fixtures.** `test/integration/cli/orchestrate/lifecycle.e2e.test.ts`
   copies the selected fixture into a temp dir, `git init`s it, and drives the
   orchestrate verb surface against it (lifecycle chain, CAS race, the
   `/update-spec` closed loop, `reconcile --pull/--push`, `amend-roadmap`, and
   a `migrate` smoke). The file self-skips unless `FORGE_E2E_FIXTURE` is set to
   `github`, `linear`, or `notion`; CI runs all three across a Node version
   matrix (see `.github/workflows/ci.yml`, the `e2e` job).

Because they are fixtures, keep the task ids and the `source.synced_at`
timestamps deterministic — the harness normalizes dynamic fields (claim/attempt
UUIDs, lease expiries, regenerated `synced_at`) rather than byte-comparing
files, but stable inputs keep the assertions readable.

The examples are **excluded from the published npm tarball** (see
`package.json#files` and the `examples/` entry in `scripts/test-pack.mjs`'s
forbidden prefixes).
