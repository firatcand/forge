# forge

> **Note:** This is the forge repo itself. Iterating on this repo means iterating on the framework — every change ships to `npm publish @firatcand/forge` and lands on adopter machines via `npx @firatcand/forge`. Treat all changes as public-API.

## Stack
<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->

## Branch strategy
- `main` → integration (protected, PRs only)
- `feat/{LINEAR-ID}-{slug}` → working branches in worktrees, PR'd into `main`

## Commands
- Build: `npm run build`
- Test: `npm test`
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Dev: `npm run dev`

## Conventions
<!-- Project-specific. Examples: -->
- Functional components only, no class components
- Always handle errors explicitly — no silent catches
- New API routes must have input validation
- See `spec/` for full conventions

## Forge principles (auto-applied — see [Forge ETHOS.md](https://github.com/firatcand/forge/blob/main/ETHOS.md))
1. Boil the Lake — refuse weak inputs
2. Iron Law of Investigation — no fixes without RCA
3. Confusion Protocol — clarify, don't guess
4. Test-or-die — every PR ships with tests
5. Compound Learning — capture notable learnings
6. Multi-model Second Opinion — Codex on critical paths
7. Plan Mode Mandatory — no multi-file changes without /plan-task
8. 12-Factor Env Discipline — never commit secrets

## Critical paths
<!-- Files matching these patterns trigger /codex auto-review on /ship -->
See CRITICAL.md
