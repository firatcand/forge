# Release checklist

The manual pre-release ritual for publishing `@firatcand/forge`. CI proves the
*deterministic* surface on every PR (unit suite, the `e2e` job over the frozen
`examples/` fixtures across Node 22/24, build, smoke, pack, gitleaks). This
checklist covers what CI deliberately does **not**: live-LLM skill runs and
live-tracker API suites. Nothing here runs in CI — every step is a human gate.

> Why a manual lane (FORGE-110, Path C): the orchestrator's correctness is
> covered deterministically by the verb-layer harness + the adapter contract
> tests. Skill behavior (Claude/Codex driving the verbs) and real-tracker
> transport are validated by hand before each publish so CI never spends tokens
> or needs live credentials.

## 0. Pre-flight (automated gates must be green)

- [ ] `main` is green in CI (typecheck, test, **e2e** matrix, build, smoke,
      pack, gitleaks).
- [ ] `npm run typecheck` clean locally.
- [ ] `npm run build` succeeds locally.
- [ ] `npm test` 0 fail locally (the lifecycle file self-skips).
- [ ] `npm run test:pack` passes (confirms `spec/`, `plans/`, `docs/`,
      `.forge/`, `examples/` are all excluded from the tarball).

## 1. Live skill-driven greenfield run (Claude + Codex)

Drive a real greenfield project through the skills end-to-end against a live
host. This is the lane CI cannot cover — it exercises the skill prompts,
confirmation gates, and the auto-codex second-opinion hook.

- [ ] In a scratch directory, `forge init` and run the discovery interview
      (`/forge` → `/draft-prd` → `/draft-spec` → `/draft-design` →
      `/ingest-spec` → `/decompose` → `/push-to-tracker`). Confirm each artifact
      lands and the tracker receives the issues.
- [ ] Pick up and ship one task: `/pickup-task` → `/plan-task` → `/implement` →
      `/qa` → `/review` → `/ship`. Confirm the PR opens with a conventional
      commit and the critical-path `/second-opinion` (Codex) fires when a
      `CRITICAL.md` path is touched.
- [ ] Run the `/update-spec --draft` → flip to `accepted` → `/update-spec
      --apply <slug>` closed loop on the scratch project. Confirm the ADR is
      deleted, `spec/decisions/INDEX.md` gets the line, and the apply commit
      carries the ADR rationale.
- [ ] Run `/amend-roadmap` mid-flight and confirm the new task materializes in
      `phases.yaml` and the tracker, with the drift notice listing any active
      attempt.

`primary_host_cli: claude` + `review_host_cli: codex` is the supported pairing.
Cursor + Gemini are **verified-deferred** (no Cursor adapter yet; FORGE-160 adds
it first) — do not gate a release on them.

## 2. Live tracker integration suites

Run each adapter's real-API suite against a throwaway tracker. Setup and
cleanup details live in [test/integration/README.md](../test/integration/README.md);
the env gates are summarized here.

- [ ] **GitHub** — `FORGE_E2E_GITHUB=1 FORGE_E2E_REPO=<owner>/<throwaway> npm test`
- [ ] **Linear** — `FORGE_E2E_LINEAR=1 FORGE_E2E_LINEAR_TEAM_ID=<uuid> LINEAR_API_KEY=lin_api_xxx npm test`
- [ ] **Notion** — `FORGE_E2E_NOTION=1 FORGE_E2E_NOTION_DATABASE_ID=<uuid> npm test` (requires `ntn login`)
- [ ] **Codex harness smoke** — `FORGE_E2E_CODEX=1 npm test`
- [ ] (optional) **Gemini harness smoke** — `FORGE_E2E_GEMINI=1 FORGE_GEMINI_EXPERIMENTAL=1 npm test`

## 3. Deterministic fixture harness (sanity re-run)

CI already runs this, but re-run locally once before publish:

- [ ] `FORGE_E2E_FIXTURE=github node --test --import tsx test/integration/cli/orchestrate/lifecycle.e2e.test.ts`
- [ ] `FORGE_E2E_FIXTURE=linear  …` (same command, linear)
- [ ] `FORGE_E2E_FIXTURE=notion  …` (same command, notion)

Each must finish in well under 60s.

## 4. Version + publish

- [ ] Decide the semver bump (this repo IS the framework — every change is
      public API; bump accordingly).
- [ ] `npm version <patch|minor|major>` (tags the commit).
- [ ] `npm publish` (publishes the tarball; the `files` allowlist + the
      pack gate keep `examples/`, `spec/`, `plans/`, `docs/`, `.forge/` out).
- [ ] `git push --follow-tags`.
- [ ] Smoke the published artifact: `npx @firatcand/forge@latest --version` in a
      clean directory.
- [ ] In a real adopter repo: `forge upgrade` regenerates `.forge/CONTEXT.md`
      and CLAUDE.md import cleanly.
