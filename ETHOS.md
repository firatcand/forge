# Forge — Ethos

The 8 principles that govern how forge skills behave. These aren't decorations — they're enforced through skill instructions, CLAUDE.md rules, and CI gates.

## 1. Boil the Lake — refuse weak inputs

A weak spec produces weak tasks produces weak code. Forge refuses to proceed when inputs are incomplete:

- `/ingest-spec` validates that PRD, SPEC, and DESIGN have all required sections filled
- `/decompose` will not generate phases.yaml from an incomplete spec
- The framework prefers a 60-minute conversation upfront over a 6-hour rewrite later

When in doubt, demand more clarity. Half-done specs are the most expensive thing in software.

## 2. Iron Law of Investigation — no fixes without root-cause analysis

Three failed fix attempts is the limit. After that, stop and investigate fresh.

`/fix` checks for a recent `/investigate` artifact. Investigation means: traced the data flow, tested at least one hypothesis, identified the root cause. Not "I think it's probably the X."

This rule exists because thrash on fixes is the most demoralising kind of engineering work, and most fixes-on-fixes are caused by skipping investigation.

## 3. Confusion Protocol — clarify, don't guess

When an architectural decision is ambiguous, all forge subagents stop and ask. They never default-pick. The format is:

> I see two viable approaches here:
> 
> A. [option A] — trade-off X
> B. [option B] — trade-off Y
> 
> Which do you want?

This is borrowed directly from gstack. It exists because Claude defaulting to its preferred pattern silently is one of the most common ways code drifts from intent.

## 4. Test-or-die — every PR ships with tests

`/ship` blocks the PR if:
- New code has zero new tests (allowlist for pure styling/copy)
- Bug fix has no regression test reproducing the bug
- Test framework isn't bootstrapped — `/qa` offers to bootstrap before continuing

The `qa-engineer` subagent generates regression tests automatically when `/qa` finds a bug.

## 5. Compound Learning — every notable task writes a learning

A task is "notable" if any of: investigation took >30 min, >2 fix attempts, surprised by behaviour, found a non-obvious gotcha, made a non-trivial trade-off.

`/learn` writes a 5-10 line learning to `docs/learnings/{quarter}/{slug}.md`, tagged. `/pickup-task` retrieves relevant learnings before the next task starts. The system gets smarter on your codebase over time.

This is the "compound" in compound engineering. Without it, every task is greenfield.

## 6. Multi-model Second Opinion — Codex CLI on critical paths

For changes touching paths in your project's `CRITICAL.md`, `/ship` requires `/codex` to have reviewed.

`/codex` shells out to your Codex CLI for an adversarial review from a different model. Two perspectives catch what one misses — especially on auth, billing, security, and infrastructure.

## 7. Plan Mode Mandatory — no multi-file changes without /plan-task

`/implement` checks for an approved plan at `plans/tasks/{LINEAR-ID}.plan.md`. If none exists, it refuses to run.

The plan includes: changed files (predicted), data flow, edge cases, test strategy. The user approves before `/implement` unlocks. Single-file changes <50 lines can override with `/implement --quickfix` and a justification.

## 8. 12-Factor Env Discipline — air-gap dev/prod

`/setup-repo` enforces:
- `.env*` in `.gitignore`
- `.env.example` with all required keys (no values)
- GitHub Environments configured: `development` (auto), `production` (manual approval gate)
- Secrets scanned with `gitleaks` in CI

`/ship` runs a final secrets scan on the diff. Hardcoded API keys, tokens, or credentials block the ship.

---

## How these principles relate

The first three (Boil the Lake, Iron Law, Confusion Protocol) protect against bad inputs and bad reasoning. The next three (Test-or-die, Compound Learning, Multi-model) protect against bad outputs. The last two (Plan Mode, Env Discipline) are tactical: discipline that pays for itself within days.

Together they enforce a simple bet: structure at the front saves rework at the back. Most products fail because of decisions made unclearly in the first 48 hours. Forge tries to make those decisions visible, persisted, and revisitable.
