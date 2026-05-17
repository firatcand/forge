# Lifecycle

Forge's lifecycle has four bands: **IDEA → TASK → PHASE → PROD**. Each band has a small set of skills that gate access to the next.

```
┌─────────────────────────────── IDEA band ───────────────────────────────┐
│                                                                          │
│   /forge ──→ /draft-prd ──→ /draft-spec ──→ /draft-design  (optional)    │
│                                       │                                  │
│                                       ▼                                  │
│                                /ingest-spec                              │
│                                       │                                  │
│                                       ▼                                  │
│                                  /decompose                              │
│                                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
                              /setup-repo
                                   │
                                   ▼
                            /push-to-tracker  (optional, recommended)
                                   │
                                   ▼
┌─────────────────────────────── TASK band ───────────────────────────────┐
│                                                                          │
│   /pickup-task ──→ /plan-task ──→ /implement ──→ /review                 │
│                                                       │                  │
│        ┌──────────────────────────┐                   ▼                  │
│        │ /investigate ──→ /fix    │                  /qa                 │
│        │  (when bugs surface)     │                   │                  │
│        └──────────────────────────┘                   ▼                  │
│                                                  /codex (if critical)    │
│                                                       │                  │
│                                                       ▼                  │
│                                                    /ship                 │
│                                                       │                  │
│                                                       ▼                  │
│                                                  /learn (if notable)     │
│                                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                              (loop until phase done)
                                   │
                                   ▼
┌────────────────────────────── PHASE band ────────────────────────────────┐
│                                                                          │
│                          /phase-gate phase-N                             │
│                                  │                                       │
│                                  ▼                                       │
│                              /retro phase-N                              │
│                                  │                                       │
│                                  ▼                                       │
│                          (advance to phase N+1)                          │
│                                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
                                  PROD
```

Each skill is documented below: when to invoke, inputs required, outputs produced, what gates from it.

---

## IDEA band

### `/forge`

- **When to invoke:** very first thing for any new project. Once. (Or with `--refine [section]` to re-interview a weak section.)
- **Inputs:** none — you arrive with a sentence in your head.
- **Outputs:** `spec/BRIEF.md` answering 6 forcing questions (pain, advantage, smallest scope, non-goals, north star, kill criteria).
- **Unlocks:** `/draft-prd`. Until BRIEF exists, `/draft-prd` refuses.

### `/draft-prd`

- **When to invoke:** after `/forge` produces a BRIEF and you've reviewed it.
- **Inputs:** `spec/BRIEF.md`. Optionally orchestrates the user's `product-spec` skill if installed at `~/.claude/skills/product-spec/`.
- **Outputs:** `spec/PRD.md` with problem, target user, acceptance criteria, non-goals, success metrics, constraints, user flows.
- **Unlocks:** `/draft-spec` and `/draft-design`.

### `/draft-spec`

- **When to invoke:** after PRD exists.
- **Inputs:** `spec/PRD.md`. Reads `~/.claude/CLAUDE.md` for `stack_preferences`. Optionally orchestrates `software-architect` skill.
- **Outputs:** `spec/SPEC.md` with stack, data model, key flows, integration points, security model, env vars, performance targets, observability.
- **Unlocks:** `/ingest-spec`.

### `/draft-design` (optional)

- **When to invoke:** for UI-heavy products. Skip for pure CLI/library projects.
- **Inputs:** `spec/PRD.md`, brand_book, design_system, voice_register from `~/.claude/CLAUDE.md` `brand_assets:` block.
- **Outputs:** `spec/DESIGN.md` using the `@inherit` pattern to reference brand assets without duplicating.
- **Unlocks:** nothing additional — `/ingest-spec` validates DESIGN if present.

### `/ingest-spec`

- **When to invoke:** after BRIEF + PRD + SPEC (+ DESIGN) are written and reviewed.
- **Inputs:** all spec docs.
- **Outputs:** validation report. On success: `spec/CONTEXT.md` synthesizing all four into one canonical reference.
- **Unlocks:** `/decompose`. On failure: lists missing or inconsistent sections; blocks `/decompose`.

### `/decompose`

- **When to invoke:** after `/ingest-spec` passes.
- **Inputs:** `spec/CONTEXT.md`.
- **Outputs:** `plans/phases.yaml` — a DAG of tasks across Phase 1 / 2 / 3, each with id, title, type, priority, depends_on, estimate, owner_type, acceptance criteria.
- **Unlocks:** `/setup-repo` and `/push-to-tracker`.

### `/setup-repo`

- **When to invoke:** once, before the first task.
- **Inputs:** working directory (project), `spec/SPEC.md` (for env vars).
- **Outputs:** GitHub repo created, branch protection set up on `main`, GitHub Environments (development, production), CI workflows copied in, `CLAUDE_CODE_OAUTH_TOKEN` secret set, `.env.example` populated.
- **Unlocks:** standard git/PR workflows.

### `/push-to-tracker`

- **When to invoke:** after `/decompose` and `/setup-repo`.
- **Inputs:** `plans/phases.yaml`, `.forge/settings.yaml` `tracker.type` (linear | github | notion), and per-tracker tooling reachable (Linear MCP / `gh` CLI / Notion MCP).
- **Outputs:** tracker project (Linear Project / GH Milestone / Notion DB), per-phase grouping, issues per task with `blocks` relations (or body-footer equivalent on GH), GitHub link configured for Linear. `phases.yaml` updated with `tracker_project_id` + per-task `tracker_issue_id` (plus legacy `linear_*` aliases when `tracker.type === 'linear'`, removed in v0.4.0).
- **Unlocks:** `/pickup-task` (which queries the tracker for the next available task).

---

## TASK band

### `/pickup-task`

- **When to invoke:** start of every new task.
- **Inputs:** configured tracker (or `phases.yaml` if no tracker is configured).
- **Outputs:** picks next available task (status Todo, all dependencies Done), sets it to In Progress, creates a worktree at `.forge/worktrees/{TICKET}/`, retrieves recent learnings tagged with the task's type.
- **Unlocks:** `/plan-task` in the new worktree.

### `/plan-task`

- **When to invoke:** in the new worktree, before any code edits.
- **Inputs:** the Linear task description and acceptance criteria.
- **Outputs:** `plans/tasks/{LINEAR-ID}.plan.md` with files to change, data flow, edge cases, test strategy, open questions. Delegated to the relevant specialist subagent (frontend-dev, backend-dev, db-architect, etc.).
- **Unlocks:** `/implement` after user approval of the plan.

### `/implement`

- **When to invoke:** after the plan is approved and committed.
- **Inputs:** `plans/tasks/{LINEAR-ID}.plan.md`.
- **Outputs:** committed code that follows the plan, with conventional commit messages.
- **Quickfix override:** `/implement --quickfix "<one-line justification>"` for single-file changes <50 lines.

### `/investigate` (when bugs surface)

- **When to invoke:** before any bug fix. Required by the Iron Law.
- **Inputs:** the bug report or failing test.
- **Outputs:** `plans/tasks/{LINEAR-ID}.investigation.md` with repro steps, hypotheses tested, root cause identified, proposed fix approach.
- **Unlocks:** `/fix`.

### `/fix`

- **When to invoke:** after `/investigate` produces a fresh (<24h) investigation file.
- **Inputs:** the investigation file.
- **Outputs:** minimal fix matching root cause + regression test pinning the original buggy behavior. Conventional commit `fix(scope): description`.

### `/review`

- **When to invoke:** after `/implement` (or `/fix`).
- **Inputs:** `git diff main...HEAD`.
- **Outputs:** findings from `code-reviewer`, plus `security-auditor` (if diff touches `CRITICAL.md` paths) and `design-reviewer` (if task type is design or frontend). Categorized as Block / Improvement / Nit.
- **Unlocks:** `/qa` once Blocks are resolved.

### `/qa`

- **When to invoke:** after `/review` Blocks resolved.
- **Inputs:** project test suite, Playwright (if applicable), PRD acceptance criteria.
- **Outputs:** test results. Bootstraps test framework if missing. Generates regression tests for bug fixes (Test-or-die enforcement).
- **Unlocks:** `/ship` once tests are green.

### `/codex` (when critical)

- **When to invoke:** if the diff touches paths in `CRITICAL.md`. `/ship` will refuse without it.
- **Inputs:** Codex CLI installed and authenticated. Current diff.
- **Outputs:** Codex's adversarial review of the diff, flagging issues a different model's training distribution catches.
- **Unlocks:** removes the `/ship` block on critical-path changes.

### `/ship`

- **When to invoke:** after all gates pass.
- **Inputs:** current branch, working tree.
- **Outputs:** `git push origin HEAD`, `gh pr create` with Linear ID in title, PR body templated. Linear issue auto-moves to In Review via native sync.
- **Unlocks:** `/learn`.

### `/learn` (when notable)

- **When to invoke:** if anything was notable (investigation > 30 min, > 2 fix attempts, surprised by behavior, found gotcha, made trade-off, bootstrapped infrastructure). `/ship` suggests this if it suspects notability.
- **Inputs:** commit history, investigation file, PR description.
- **Outputs:** `docs/learnings/{quarter}/{slug}.md` — 5–10 lines: what we expected, what happened, why, next time. Tagged for retrieval.
- **Unlocks:** future `/pickup-task` runs surface this learning when relevant.

---

## PHASE band

### `/phase-gate phase-N`

- **When to invoke:** when all phase-N tasks are Done.
- **Inputs:** `plans/phases.yaml`, Linear (cycle status), `gate_check_command` from phases.yaml.
- **Outputs:** runs `gate_check_command`, generates `docs/retros/phase-{N}.md`, demands explicit y/N approval. On approval: closes Linear cycle, activates next, marks phase complete in phases.yaml, commits retro.
- **Unlocks:** the next phase's tasks become claimable via `/pickup-task`.

### `/retro phase-N`

- **When to invoke:** auto-invoked by `/phase-gate`. Standalone use is rare.
- **Inputs:** Linear (closed tasks in cycle), git log, learnings from the cycle.
- **Outputs:** `docs/retros/phase-{N}.md` synthesizing what shipped, decisions made, scope changes, learnings, what to do differently.

### `/sync-status`

- **When to invoke:** rarely. Linear ↔ GitHub native sync handles drift automatically; the GitHub tracker reads issue state directly. Use when manual closes happen out-of-band.
- **Inputs:** `plans/phases.yaml`, `.forge/settings.yaml`.
- **Outputs:** `phases.yaml` updated to match the tracker; drift report.

---

## Common deviations

**Skipping `/draft-design`.** Pure CLI tools, libraries, and developer tooling don't need a DESIGN doc. Skip it. `/ingest-spec` doesn't require DESIGN.

**`--quickfix` override on `/implement`.** Single-file CSS tweaks, copy changes, or bug fixes <50 lines can skip `/plan-task` with a justification. Don't abuse this — three quickfixes in a row probably means the work is bigger than expected.

**Skipping `/codex` on critical paths.** Don't. The 30-second cost of running it has saved entire incidents in dogfooding. If Codex is unavailable (no membership, offline), document why in the PR description.

**Manual tracker status moves.** If a teammate closes an issue manually outside `/ship`, run `/sync-status` to reconcile. Otherwise the next `/pickup-task` may show stale state.

**Pre-existing repos.** `/setup-repo` is idempotent — it skips repo creation if origin exists, but still applies branch protection and workflows. Useful for adopting forge on an in-flight project.

**Multiple worktrees in flight.** Forge expects this. Different terminals, different worktrees, different Claude sessions. The shared `.git` keeps history consistent.
