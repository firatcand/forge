# Philosophy

Forge is a forcing function for structured ambition. It exists because the marginal cost of doing things well — with Claude Code in the loop — has collapsed, but the marginal cost of doing things badly hasn't. Bad specs still produce bad products. Bad investigations still produce bad fixes. The dominant constraint is no longer typing speed; it's discipline.

This document expands each principle from `ETHOS.md` with the failure mode it prevents, the mechanism that enforces it, a worked example, and the cases where the principle should NOT apply.

---

## 1. Boil the Lake — refuse weak inputs

### What failure mode this prevents

The most expensive software is software built from a vague spec. A founder describes "a tool that helps with X" and 6 weeks later they have something that vaguely helps with X but doesn't quite solve the problem they had in mind. They didn't lie about what they wanted — they just didn't know yet.

The classic pattern: vague brief → ambitious PRD that splits the difference between three interpretations → architecture that supports all three → code that does each one badly. By the time the founder uses it, they realize the actual problem was a fourth thing that none of these solve. Now they're 6 weeks in with a codebase shaped against them.

### The mechanism

Three gates enforce input quality:

- `/forge` won't write a BRIEF until all six forcing questions have concrete answers.
- `/ingest-spec` won't pass validation until BRIEF + PRD + SPEC have all required sections filled and cross-document consistency holds.
- `/decompose` refuses to generate `phases.yaml` from a spec that hasn't passed `/ingest-spec`.

Each gate is loud about what's missing. They don't soften, they don't infer.

### Worked example

Founder runs `/forge` and answers Q1 ("what pain") with "people want a better project tracker." `/forge` pushes back: "People wanting is not pain. Tell me about a specific moment, a specific user, a specific workaround." Founder thinks for 90 seconds and produces: "Last Tuesday I tried to switch from project A to project B mid-flow and gave up because Toggl took 5 clicks. I went the rest of the day without logging." That answer is concrete, grounded, and actionable. The PRD that follows can target a measurable improvement.

### When NOT to apply

For tiny one-off scripts (a 50-line CLI that scrapes one site once) the BRIEF→PRD→SPEC ceremony is overkill. Run `/implement --quickfix` with a one-line justification and skip the gates. Forge isn't a religion. The principle applies when the cost of being wrong about scope is high.

---

## 2. Iron Law of Investigation — no fixes without root-cause analysis

### What failure mode this prevents

The "fix-fix-fix" cycle. A bug appears. The first fix changes a symptom but not the cause. The second fix breaks an adjacent feature. The third fix is a workaround that lives in the codebase forever, alongside an artifact comment that says `// TODO: figure out why this is needed`. Three failed fixes mean the engineer didn't understand the bug, not that the bug was hard. Doubling down without understanding produces a worse outcome each iteration.

### The mechanism

`/fix` requires a recent (`<24h`) `plans/tasks/{LINEAR-ID}.investigation.md` file. The file must include: repro steps, hypotheses tested, root cause identified. After three failed fix attempts, `/fix` refuses to run again until a fresh `/investigate` produces a new investigation file.

This is less about ceremony and more about creating a forcing function for the engineer to *stop and think* before doubling down.

### Worked example

A user reports that `tl report` shows wrong totals after midnight. First attempt: add `Z` to the timestamp parsing — totals still wrong. Second attempt: switch from `Date.now()` to `dayjs().valueOf()` — totals still wrong. At this point the engineer is tempted to try a third fix. The Iron Law says: stop. Run `/investigate`. Investigation reveals: the SQL query uses `started_at >= ?` with a parameter computed in local time, but `started_at` is stored in UTC. The fix is one-line in the *parameter computation*, not the date library. Total time saved: ~2 hours.

### When NOT to apply

True one-character typo fixes (a `+` should be a `-`) don't need investigation — they need a regression test. The Iron Law applies when there's any ambiguity about *why* the bug happens.

---

## 3. Confusion Protocol — clarify, don't guess

### What failure mode this prevents

Silent default-picking. Claude is excellent at producing reasonable code, but "reasonable" is path-dependent. If your codebase uses one auth pattern and Claude defaults to another, you'll get drift. After 20 commits of drift, the codebase has two auth patterns. Then someone adds a third. By month three, you have a museum of partial implementations.

### The mechanism

Every forge subagent has a "Confusion Protocol triggers" section listing the decisions where it MUST stop and ask. The format is fixed:

> I see two viable approaches here:
>
> A. [option A] — trade-off X
> B. [option B] — trade-off Y
>
> Which do you want?

This is borrowed from gstack. It exists because agents are trained to be helpful, and helpful sometimes means picking and moving on. Forge subagents are trained to recognize when picking would be a guess.

### Worked example

`backend-dev` is asked to implement a new API endpoint. The codebase has both REST and JSON-RPC handlers. The new endpoint could go either way. The agent stops and asks: "I see both REST (POST /api/billing/charge) and JSON-RPC (POST /rpc with method: 'billing.charge') in this repo. Which pattern should I follow?" The user picks REST in 5 seconds. No drift.

### When NOT to apply

The Confusion Protocol fires when there is genuine ambiguity. If the codebase clearly uses one pattern and the new code obviously fits it, don't manufacture a question. The bar is: would two competent engineers reading the same context pick differently?

---

## 4. Test-or-die — every PR ships with tests

### What failure mode this prevents

The "I'll add tests later" flywheel. Tests deferred are tests never written. After a few rounds of "later" the codebase reaches the state where adding tests requires refactoring, refactoring requires tests to verify it, and the founder simply stops and ships untested code forever.

The dangerous variant is bug fixes without regression tests. The bug recurs in 6 months, the engineer fixes it again, and nobody realizes it's the same bug because there's no test pinning the behavior.

### The mechanism

`/ship` blocks the PR if:

- New code has zero new tests (allowlist for pure styling/copy)
- Bug fix has no regression test reproducing the bug
- Test framework isn't bootstrapped (`/qa` will offer to bootstrap before continuing)

The `qa-engineer` subagent generates regression tests automatically when `/qa` finds a bug.

### Worked example

A frontend bug is fixed by changing a CSS class. `/ship` notices new code in `Button.tsx` and asks: "Is there a test for the new behaviour?" Engineer says: "It's just a class change." `/ship` checks: did the diff modify behaviour, or only presentation? If presentation only, allow. If behaviour (e.g., new prop, new conditional rendering), block until a test exists. The test does not need to be huge — a single `expect(button).toHaveClass('primary')` is enough to pin it.

### When NOT to apply

Pure typo fixes in copy (changing "Submit" to "Send"). Pure refactors that pass existing tests unchanged. Documentation. The principle is about *behavior*, not *files changed*.

---

## 5. Compound Learning — every notable task writes a learning

### What failure mode this prevents

Every task being greenfield. Without a memory, every database migration starts from "what was the gotcha last time?" — answered by guessing, by re-reading docs, or by re-discovering the gotcha. With a memory, the next task that touches the same area gets the prior learning injected automatically.

### The mechanism

`/learn` writes a 5–10 line learning to `docs/learnings/{quarter}/{slug}.md`, tagged. `/pickup-task` reads recent learnings tagged with the new task's type from the last 90 days and injects them into the implementer's context. The system gets smarter on your codebase over time.

A task is "notable" if any of: investigation took >30 min, >2 fix attempts, surprised by behavior, found a non-obvious gotcha, made a non-trivial trade-off.

### Worked example

While bootstrapping Supabase RLS for the first time, the engineer discovers that Supabase's auto-generated TypeScript types omit columns gated by RLS unless the policy includes a specific role. They write a learning tagged `[supabase, rls, typegen]` describing the workaround. Six weeks later, a different task touches RLS — `/pickup-task` surfaces this learning before planning starts. The engineer doesn't rediscover it.

### When NOT to apply

Routine tasks where nothing was learned. The principle is to capture the *non-obvious* — not to log every commit.

---

## 6. Multi-model Second Opinion — Codex CLI on critical paths

### What failure mode this prevents

Single-model blind spots. Claude is excellent, but every model has consistent gaps. Subtle race conditions in auth code, unnecessary blocking in event handlers, off-by-one bugs in time-window logic — these are the failures where a different model with a different training distribution catches what Claude missed.

### The mechanism

For changes touching paths in your project's `CRITICAL.md` (typically: auth, billing, webhooks, infrastructure, schema migrations), `/ship` requires `/codex review` to have run. `/codex` shells out to your Codex CLI for an adversarial second look.

### Worked example

A change to the billing webhook handler. Claude's implementation handles the happy path and the documented Stripe failure modes. `/codex review` flags: "Stripe occasionally retries the same webhook within 100ms; this code uses an in-memory dedupe set that resets on cold start. On serverless, this could fire the same charge twice." Claude could have caught this; sometimes it does. Two passes raise the floor.

### When NOT to apply

Non-critical paths (UI components, internal tooling, test infrastructure) don't need a second opinion. The principle targets code where a missed bug is expensive — auth, money, data integrity, security.

---

## 7. Plan Mode Mandatory — no multi-file changes without /plan-task

### What failure mode this prevents

The "unfold" pattern. An engineer starts on a task, makes a change, realizes another file needs changing, makes that change, realizes a third file is involved. By the end, the diff is sprawling, the original intent is fuzzy, and the review takes 4× longer than the work.

Plan mode forces the engineer to predict the file set before touching code. The act of predicting catches "wait, this is bigger than I thought" — the cheapest moment to course-correct is *before* the first edit.

### The mechanism

`/implement` checks for an approved plan at `plans/tasks/{LINEAR-ID}.plan.md`. If none exists, it refuses to run. The plan includes: changed files (predicted), data flow, edge cases, test strategy. The user approves before `/implement` unlocks.

Single-file changes <50 lines can override with `/implement --quickfix` and a justification.

### Worked example

A "small" task to add a feature flag turns out to require: schema migration (db), feature-flag util (lib), new API endpoint (api), new UI toggle (frontend), new test fixtures (test). Plan mode surfaces all five files before any edits. The user reads the plan and notices that the schema migration is risky — rather than block on it, they split the task into two: add the util and UI behind a hardcoded flag first, ship; do the migration in a separate task with a backout plan.

### When NOT to apply

Single-file CSS tweaks. Renaming a single variable. Updating a copy string. The principle targets work that's likely to sprawl, not work that's bounded.

---

## 8. 12-Factor Env Discipline — air-gap dev/prod

### What failure mode this prevents

Secrets in code. Credentials in Slack messages. The `.env` that gets committed "just for now." Production keys used in dev because the dev keys never got created. Each of these is a category of bug that's expensive when it bites and easy to prevent up front.

### The mechanism

`/setup-repo` enforces:

- `.env*` in `.gitignore`
- `.env.example` with all required keys (no values)
- GitHub Environments configured: `development` (auto-deploy), `production` (manual approval gate)
- Secrets scanned with `gitleaks` in CI

`/ship` runs a final secrets scan on the diff. Hardcoded API keys, tokens, or credentials block the ship.

### Worked example

An engineer pastes a temporary Stripe test key into `lib/billing.ts` to debug a webhook locally. They forget to remove it. `/ship` runs `gitleaks` on the diff, finds the pattern, blocks the PR with the file and line number. Engineer removes the key, replaces with `process.env.STRIPE_KEY`, reruns. Total cost: 30 seconds. Cost if the key had landed in main: revoking the key, rotating in 4 environments, auditing access logs, ~2 hours minimum.

### When NOT to apply

Local-only tools that don't ship. Examples (`forge` itself runs only on the maintainer's machine, but the principle is still applied because forge is a public repo). When the tool is genuinely private and won't be shared, the discipline is optional — but cheap to keep.

---

## How forge differs from gstack and Compound Engineering

**gstack** is the closest sibling. Forge borrows the skill-as-specialist pattern, the Iron Law of Investigation, the Confusion Protocol, and AI Slop detection. What forge adds:

- Phase decomposition with a dependency graph (`phases.yaml`). gstack stays at the per-task level.
- Linear ↔ GitHub native sync as the durable task system.
- Brand-book inheritance (`@inherit`) for design-system reuse across projects.

**Every's Compound Engineering plugin** contributed the 80/20 plan-heavy thesis and the compound learning loop. What forge adds:

- Stack-agnostic templates (Compound Engineering ships with Next.js + Supabase opinions).
- Phase gate ceremony (`/phase-gate`) as a hard checkpoint, not just a soft prompt.

**Paperclip** contributed the orchestration mental model — separate specialists, coordinator on top. What forge avoids: heavyweight infrastructure. No queues, no servers, no daemons. Everything is markdown + bash + git.

Forge is opinionated about *how to use Claude Code* and unopinionated about *what to build with it*. That asymmetry is the design.
