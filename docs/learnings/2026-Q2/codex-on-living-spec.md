Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/firatcandogan/repos/forge-worktrees/FORGE-80
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/firatcandogan/.codex/memories]
reasoning effort: none
reasoning summaries: none
session id: 019e326f-f0e0-77f1-8773-7b40a25b6e55
--------
user
Second opinion on a real architectural fork in the forge framework. Forge is a TypeScript framework that orchestrates autonomous engineering tasks (Claude Code, Codex) against trackers (Linear, GitHub, Notion). It's used to build itself. The user is pushing back on a design choice and wants an outside view before we commit either way.

## The framework's current architecture

Specification documents (`spec/BRIEF.md`, `spec/PRD.md`, `spec/SPEC.md`, `spec/DESIGN.md`, and project-specific docs like `spec/ORCHESTRATOR.md`) are produced by one-shot skills (`/forge`, `/draft-prd`, `/draft-spec`, `/draft-design`) at project start. There is NO `/update-spec` or `/amend-spec` skill. `spec/ORCHESTRATOR.md` literally self-describes as "frozen reference."

The dependency graph (`plans/phases.yaml`) is generated once by `/decompose` from SPEC. There is no `/re-decompose` or `/sync-phases-from-tracker` skill.

`/push-to-tracker` copies `phases.yaml` task content (title, description, AC) into Linear issues. After that, Linear issues become the live source of truth — operators edit ticket bodies mid-flight to rescope (see `FORGE-72` "⚠ SCOPE EXPANDED" header, `FORGE-22` "⚠ FUNDAMENTALLY RESCOPED" header in this repo). Those edits do NOT flow back to phases.yaml or SPEC.

`docs/learnings/` is the de facto running log of "what we actually figured out" — but it's append-only commentary, not a structured update mechanism. The SPEC remains the project-start snapshot.

So the de-facto data-staleness order over a multi-month project is:
- Code: ground truth
- Linear: live, but only at the task level
- docs/learnings/: accumulated commentary
- phases.yaml: stale from /decompose onward (content), still accurate for dependency graph
- SPEC: stale by month 2+

## The user's pushback

The user says (paraphrased): "SPEC should be a living document. SPEC and phases.yaml being out of date causes problems when agents pick up tasks — the agent doesn't know what to base its mental model on. When I change an architectural decision mid-flight, that change needs to land in the SPEC, not just in a Linear ticket comment, so the next agent that picks up dependent work sees the new architecture."

This is for autonomous-agent workflows specifically. Agents read SPEC as part of context hydration for planning (`/pickup-task` copies `spec/` into worktrees; `/plan-task` reads spec for design grounding).

## The question

1. Is the current "frozen SPEC + live tracker + accumulated learnings" design defensible at scale for an autonomous-agent framework? Walk through the failure mode the user is describing: agent picks up a task whose dependencies have shifted architecturally since project start. What context does the agent see, and what is it likely to produce?

2. If the design is wrong (or has a meaningful gap), what's the actual right move? Options I can think of:
   (a) **Add `/update-spec` skill** — explicit, intentional editing. Operator updates SPEC when architectural decisions shift. No auto-sync. Cost: discipline burden on the operator (will they actually do it?).
   (b) **Make Linear the SPEC** — delete SPEC entirely after `/decompose`, treat the cumulative ticket history as the spec. Cost: ticket history is hard to read as a coherent architecture.
   (c) **Versioned SPEC sections** — each architectural decision gets a dated subsection with a "supersedes" link, like ADRs. Cost: schema-heavier, but auditable.
   (d) **`forge orchestrate doctor` style drift detection** — surface "SPEC §X references symbol Y that no longer exists" or "Linear ticket FORGE-N rescoped 14 days ago, SPEC unchanged" as flags, not auto-edits. Cost: needs an inferable diff between code and SPEC, which is hard.
   (e) **Status quo + structured learnings** — keep SPEC frozen, but require `docs/learnings/{task-id}.md` whenever a rescope happens, with an explicit "this supersedes SPEC §X" header. Cost: still requires operator discipline; just shifts WHERE the discipline is enforced.

3. Are there other framings I'm missing? What does the literature on architecture-decision-records say about this? What do mature autonomous-agent codebases do?

4. Specific to the FORGE-80 task in flight right now (rewrite `/sync-status` to be a phase-completion + orphan diagnostic): should I block shipping FORGE-80 to address this larger concern, or ship FORGE-80 and file the spec-staleness concern as a follow-up (P2/P3)? FORGE-80 doesn't touch the spec-update gap; it's purely about phase-level status diagnostics.

## Files to read before answering

- `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/spec/ETHOS.md` if present (project principles)
- `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/spec/SPEC.md` first 200 lines (sense of how SPEC is structured)
- `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/spec/ORCHESTRATOR.md` first 50 lines (the "frozen reference" header)
- `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/docs/learnings/2026-Q2/` listing (sense of what the learnings store looks like)
- `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/skills/draft-spec/SKILL.md` and `/Users/firatcandogan/repos/forge-worktrees/FORGE-80/skills/decompose/SKILL.md` (sense of how the upstream skills work)

## What I want from you

Answer the 4 questions in order. Confidence 1-10 on each. Specific examples grounded in this repo where possible. Under 800 words. Be direct — if the user is right, say so. If the user is wrong, defend the current design. If the truth is somewhere in between, draw the line precisely.
codex
I’ll read the requested repo context first, then give you the architectural read in the four-part structure you asked for. Since this is a design question and not a library/API question, I’m not invoking Context7.
exec
/bin/zsh -lc "test -f spec/ETHOS.md && sed -n '1,220p' spec/ETHOS.md || true" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
exec
/bin/zsh -lc "sed -n '1,200p' spec/SPEC.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
 succeeded in 0ms:
# forge — SPEC (v-next)

> Drafted: 2026-05-09
> Source: spec/PRD.md
> Architectural decisions: locked in PRD §"Locked architectural decisions" (Q1–Q8)
> Stack decisions: locked below in §"Stack" (S1–S6)

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js ≥18 (LTS) | engines field in package.json |
| Language | TypeScript | strict mode; ESM |
| Build | `tsup` | dual ESM+CJS output → `dist/` |
| Type check | `tsc --noEmit` | CI gate |
| Tests | `node:test` + `tsx` | built-in test runner; tsx for TS execution |
| YAML | `yaml` (eemeli/yaml) | comment preservation on round-trip |
| Schema validation | `zod` | for settings.yaml, phases.yaml, tracker payloads |
| Process management | `execa` | invoking `gh`, `git`, secret-manager CLIs (NOT host CLIs — workers are host-native subagents, see ORCHESTRATOR.md) |
| CLI prompts | `@inquirer/prompts` | already in v0.2.1 |
| Output styling | `chalk` | already in v0.2.1 |
| File ops | `fs-extra` | already in v0.2.1 |
| Logging | stdout + chalk + JSONL | append-only `.forge/logs/orchestrator.jsonl` |
| Frontend | N/A | CLI tool only |
| Backend / Database / Auth / Hosting | N/A | runs entirely on user's machine; AI auth delegated to host CLIs; tracker auth delegated to adapter tooling |

**Net new deps (runtime):** `yaml`, `zod`, `execa`
**Net new deps (dev):** `typescript`, `tsup`, `tsx`, `@types/node`
**Total package size impact:** ~150 KB unpacked (well under the 1 MB ceiling from PRD)

---

## Data model

### `.forge/settings.yaml` schema (zod)

```ts
import { z } from 'zod';

export const SettingsSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  tracker: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('linear'),
      config: z.object({ team_id: z.string() }),
    }),
    z.object({
      type: z.literal('github'),
      config: z.object({ repo: z.string() /* owner/repo */ }),
    }),
    z.object({
      type: z.literal('notion'),
      config: z.object({ database_id: z.string() }),
    }),
  ]),
  secrets: z.discriminatedUnion('manager', [
    z.object({
      manager: z.literal('env_file'),
      env_file_path: z.string().default('./.env.local'),
    }),
    z.object({ manager: z.literal('1password'), vault: z.string() }),
    z.object({
      manager: z.literal('aws_secrets'),
      region: z.string(),
      prefix: z.string().optional(),
    }),
    z.object({
      manager: z.literal('doppler'),
      project: z.string(),
      config: z.string(),
    }),
    z.object({
      manager: z.literal('infisical'),
      workspace_id: z.string(),
      env: z.string(),
    }),
  ]),
  agents: z
    .object({
      // Host CLI selection — see ORCHESTRATOR.md "Phase machine"
      primary_host_cli: z
        .enum(['claude', 'codex', 'cursor', 'gemini'])
        .default('claude'),
      review_host_cli: z
        .enum(['claude', 'codex', 'cursor', 'gemini'])
        .nullable()
        .default('codex'),

      // Subagent dispatch cap per main session (enforced by dispatch skill)
      subagent_cap_per_main: z.number().int().positive().default(3),

      // Lease management — see ORCHESTRATOR.md "Lease semantics"
      lease_ttl_ms: z.number().int().positive().default(1_800_000),        // 30 min
      heartbeat_interval_ms: z.number().int().positive().default(300_000), // 5 min
      steal_grace_ms: z.number().int().positive().default(300_000),        // 5 min after expiry

      // Retry policy
      retry_attempts: z.number().int().nonnegative().default(10),
      retry_backoff_ms_max: z.number().int().positive().default(300_000),
      on_persistent_failure: z
        .enum(['notify', 'block_task', 'move_to_next'])
        .default('notify'),

      // Question budgets — see ORCHESTRATOR.md "Question lifecycle"
      question_timeout_ms: z.number().int().positive().default(1_800_000),
      question_max_attempts: z.number().int().nonnegative().default(3),
      question_budget_soft: z.number().int().nonnegative().default(3),
      question_budget_hard: z.number().int().nonnegative().default(6),

      // Worktree + branch strategy
      worktree_root: z.string().default('./.forge/worktrees'),
      branch_strategy: z.enum(['merge-to-main', 'stacked']).default('merge-to-main'),

      // Preflight + overlap detection — see ORCHESTRATOR.md "Worker prompt template" and "File-glob declarations"
      preflight_globs: z.array(z.string()).default([
        'src/index.ts', 'src/schemas/**', 'src/bin/**', 'src/cli/**',
        'src/trackers/base.ts', 'src/cli/migrate.ts', 'spec/**',
        'CRITICAL.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'phases.yaml',
      ]),
      hard_lock_globs: z.array(z.string()).default([
        'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
        'tsconfig.json', 'phases.yaml', 'src/index.ts',
        'migrations/**', 'prisma/schema.prisma',
      ]),
    })
    .refine(
      (d) => d.review_host_cli === null || d.review_host_cli !== d.primary_host_cli,
      { message: 'review_host_cli must differ from primary_host_cli (or be null to disable second-opinion review)' }
    )
    .refine(
      (d) => d.branch_strategy === 'merge-to-main',
      { message: 'stacked branch strategy is reserved but not implemented in v-next' }
    )
    .default({}),
  design: z
    .object({
      mode: z.enum(['project_owned', 'reference_external']).default('project_owned'),
      reference: z.string().optional(),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
```

### `phases.yaml` schema (zod)

```ts
export const TaskSchema = z.object({
  id: z.string(),                    // forge-internal stable ID, e.g. "P1-T03"
  title: z.string(),
  description: z.string().optional(),
  owner_type: z.enum(['frontend', 'backend', 'db', 'devops', 'qa', 'security', 'design', 'integration']),
  acceptance: z.array(z.string()),   // testable bullets
  depends_on: z.array(z.string()).default([]),  // other task IDs
  estimate: z.string().optional(),   // free text

  // Optional: file globs this task is expected to write. Enables
  // overlap detection at dispatch time. See ORCHESTRATOR.md "File-glob
  // declarations + overlap detection". When omitted, the orchestrator
  // assumes worst-case overlap and serializes more conservatively.
  write_globs: z.array(z.string()).optional(),

  // Optional: per-task question budget override.
  question_budget: z.object({
    soft: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
  }).optional(),
});

export const PhaseSchema = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  gate_criteria: z.array(z.string()),
  tasks: z.array(TaskSchema),
});

export const PhasesSchema = z.object({
  version: z.literal(1),
  phases: z.array(PhaseSchema),
});
```

### Tracker adapter interface (TypeScript)

```ts
// src/trackers/base.ts

export type IssueState =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'
  | 'blocked';


exec
/bin/zsh -lc "sed -n '1,50p' spec/ORCHESTRATOR.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
# forge — ORCHESTRATOR architecture (v2)

> Drafted: 2026-05-13 (v1 — daemon design)
> Revised: 2026-05-14 (v2 — CLI-as-control-plane + skill-as-dispatch)
> Scope: contract for the orchestrator subsystem (Phase 2 tasks FORGE-20, FORGE-21, FORGE-31, FORGE-32, FORGE-22, FORGE-65).
> Status: frozen reference. Every Phase 2 implementation task is built against this spec. Changes here require re-review of any unfinished task.
>
> **v2 changes:** The daemon process and `execa`-based subprocess workers are deleted. Workers are now host-native subagents (Claude Code's Task tool / Codex's native subagent dispatch). State lives in a stateless CLI control plane plus durable on-disk state. See "Changes from v1" at the end for the rationale and a point-by-point mapping.

## Purpose

forge's orchestrator turns the dependency graph in `phases.yaml` into shipped PRs, with a human in the loop on architectural decisions and autonomy on tactical ones. It is structured as three layers:

1. **Control plane** — the `forge` CLI. Stateless on-demand commands that own durable state on disk: task/attempt/run state machines, leases, atomic file ops, tracker CAS, schema validation, gc reconciliation. Source of truth.
2. **Dispatch layer** — a host-specific skill (`/forge orchestrate` in Claude Code; equivalent in Codex). Thin. Reads the next ready task from the CLI, dispatches a worker via the host's native subagent primitive, relays open questions to the user, records answers, polls for completion. Has no persistent state of its own.
3. **Worker layer** — a host-native subagent prompt template. Receives a task, works in an isolated worktree, calls CLI commands to register questions and report verdicts, returns to the parent skill on completion or block.

The design satisfies three constraints:

1. **Two-host parity.** Claude Code and Codex CLI users get equivalent UX. The CLI is identical across hosts; the dispatch layer is one thin per-host skill; the worker prompt is portable text with host-specific dispatch glue.
2. **Subscription billing only.** Workers are subagents in the user's interactive main session, billed against the user's Claude / ChatGPT Plus subscription. The orchestrator never spawns headless host CLI processes (`claude -p`, `codex exec`) and never uses provider API keys or Agent SDK quota.
3. **Human-in-the-loop on architecture.** Workers escalate decisions that affect public API shape, file lifecycle, deprecation strategy, exported-symbol naming, scope, or error semantics across module boundaries. They decide autonomously on tactical matters (variable names, internal helpers, log format, test fixture shape).

## Architectural primitives

The orchestrator is **not** a long-running process. It is three layered surfaces:

| Layer | Responsibility | Owner module |
|---|---|---|
| **CLI control plane** | State machine, leases, atomic file ops, tracker CAS, schema validation, gc reconciliation, status snapshots, event log | `src/cli/orchestrate/*.ts`, `src/orchestrator/state/*.ts`, `src/orchestrator/leases/*.ts` |
| **Skill dispatch layer** | Read ready tasks, dispatch subagents, relay questions to the user, record answers, poll completion | `skills/forge-orchestrate/SKILL.md` (host-specific files compiled from a shared source in Phase 3) |
| **Worker subagent** | Implement a task in a worktree, call CLI to register questions/verdicts, return to parent on completion or block | `templates/worker-prompt.md` (loaded into every subagent dispatch) |

The three are file-disjoint. They share contracts (schemas, filesystem layout, event types) defined in this document. The CLI is the only surface that mutates persistent state. Skills and workers call the CLI; they never read or write `.forge/orchestrator/` directly.

## Write-surface contract (who may write what under .forge/)

Workers, skills, and the CLI have different write authority. The contract:

| Path | Worker may write | Skill may write | CLI writes |
|---|---|---|---|
| `.forge/orchestrator/tasks/<t>/state.json` | ❌ | ❌ | ✅ (only via state-machine transitions) |
| `.forge/orchestrator/tasks/<t>/lease.json` | ❌ | ❌ | ✅ (only via lease verbs) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/manifest.json` | ❌ | ❌ | ✅ (on `dispatch`) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/events.jsonl` | ✅ via `forge orchestrate event` | ❌ | ✅ for events the CLI observes |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/save-point.md` | ✅ direct write | ❌ | — |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/verdict.json` | ✅ direct write (advisory; CLI verifies) | ❌ | — |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/verdict.verified.json` | ❌ | ❌ | ✅ (only on `complete` after verification) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/questions/<q>.json` | ✅ via `forge orchestrate question` | ❌ | ✅ for CLI-validated writes |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/answers/<q>.json` | ❌ | ❌ | ✅ on `answer` verb |

exec
/bin/zsh -lc 'find docs/learnings/2026-Q2 -maxdepth 1 -type f -print | sort' in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
docs/learnings/2026-Q2/ac-as-unit-test-vs-it-already-exists.md
docs/learnings/2026-Q2/chalk-v5-cjs-bundle-double-wrap.md
docs/learnings/2026-Q2/cli-subprocess-mock-pattern.md
docs/learnings/2026-Q2/codex-catches-semantic-bugs-shape-mocks-miss.md
docs/learnings/2026-Q2/codex-caught-silent-no-op-placeholder.md
docs/learnings/2026-Q2/codex-finds-bugs-tests-dont.md
docs/learnings/2026-Q2/codex-on-security-paths-even-when-critical-md-stale.md
docs/learnings/2026-Q2/codex-state-version-refinement-load-bearing.md
docs/learnings/2026-Q2/codex-vs-code-reviewer-find-different-things.md
docs/learnings/2026-Q2/dirent-isfile-for-destructive-listings.md
docs/learnings/2026-Q2/dual-control-precedence-trap.md
docs/learnings/2026-Q2/exported-fixture-helper-not-self-invoking.md
docs/learnings/2026-Q2/gh-cli-flag-spelling-vs-api-enum.md
docs/learnings/2026-Q2/grep-for-all-comparisons-not-just-named-helpers.md
docs/learnings/2026-Q2/id-in-path-and-payload-must-agree.md
docs/learnings/2026-Q2/integration-tests-need-production-shaped-inputs.md
docs/learnings/2026-Q2/link-vs-rename-for-never-overwrite-invariant.md
docs/learnings/2026-Q2/mcp-handles-auth-is-narrower-than-it-sounds.md
docs/learnings/2026-Q2/mcp-tool-name-family-confusion.md
docs/learnings/2026-Q2/multi-model-review-catches-distinct-bug-classes.md
docs/learnings/2026-Q2/node-test-mock-method-cannot-patch-frozen-fs-namespace.md
docs/learnings/2026-Q2/parallel-tasks-need-barrel-conflict-prediction.md
docs/learnings/2026-Q2/preserve-invariants-without-shared-base-class.md
docs/learnings/2026-Q2/schema-utf16-caps-dont-bound-utf8-byte-size.md
docs/learnings/2026-Q2/scope-cut-worldview-check-before-multi-adapter-stdlib.md
docs/learnings/2026-Q2/ship-gates-missed-build-step.md
docs/learnings/2026-Q2/smoke-job-needs-external-deps-installed.md
docs/learnings/2026-Q2/spec-api-reality-check-before-design.md
docs/learnings/2026-Q2/spec-beats-linear-ac.md
docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md
docs/learnings/2026-Q2/tsdown-engines-floor-binding.md
docs/learnings/2026-Q2/typescript-overload-discriminator-unsoundness.md
docs/learnings/2026-Q2/widening-shared-regex-is-security-audit-trigger.md
docs/learnings/2026-Q2/worktree-hydration-runbook.md
docs/learnings/2026-Q2/worktrees-also-blind-to-node-modules.md
docs/learnings/2026-Q2/worktrees-blind-to-gitignored-context.md

exec
/bin/zsh -lc "sed -n '1,240p' skills/draft-spec/SKILL.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
---
name: draft-spec
description: Generate spec/SPEC.md from spec/PRD.md. Orchestrates the user's software-architect skill if available, otherwise guides Claude through the SPEC template.
tools: Read, Write, Edit
---

# /draft-spec

## Preconditions

`spec/PRD.md` must exist (Gate 2 must have passed).

## Orchestration

1. Read `spec/PRD.md`
2. Read `~/.claude/CLAUDE.md` for any stack_preferences block
3. Check if user has a `software-architect` skill available — if yes, invoke it with PRD + stack preferences
4. If not, use `templates/SPEC.template.md` and guide Claude through filling sections
5. Invoke `security-auditor` subagent in advisory mode for the chosen stack — get security model recommendations
6. Write to `spec/SPEC.md`

## Required SPEC sections

- Stack (runtime, frontend, backend, db, hosting, auth)
- Data model (tables, relationships, indexes)
- Key flows (numbered steps with edge cases)
- Integration points (external services)
- Security model (authN, authZ, sensitive data handling)
- Environment variables (12-Factor compliant — names + descriptions)
- Performance targets (p95 metrics)
- Observability (logs, metrics, errors)

## Stack choice ceremony

If SPEC implies a tech stack not yet committed, invoke Confusion Protocol:
- List 2-3 viable options
- Show concrete trade-offs
- Stop and ask user to pick before writing

## Output

Print confirmation + Gate 3 instructions.

exec
/bin/zsh -lc "sed -n '1,260p' skills/decompose/SKILL.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
---
name: decompose
description: Break the validated spec into phases.yaml — a dependency graph of tasks across Phase 1/2/3 with gate criteria, owner types, and acceptance criteria.
tools: Read, Write, Edit
subagent: product-decomposer
---

# /decompose

Delegate to the `product-decomposer` subagent.

## Preconditions

`spec/CONTEXT.md` must exist.

## Algorithm

1. Identify the smallest end-to-end working slice → Phase 1
   - Phase 1 goal is always: "skeleton works end-to-end with mock/seed data"
2. Identify the core feature loops → Phase 2
   - Phase 2 goal: "real users can complete the primary JTBD"
3. Identify polish + launch prep → Phase 3
   - Phase 3 goal: "quality bar for public launch"

## Per-task fields

- id (P{phase}-T{nn})
- title (verb + noun, max 8 words)
- description (1 paragraph)
- type (foundation | data | backend | frontend | design | infra | content | integration)
- priority (P0 | P1 | P2)
- depends_on (list of task IDs)
- estimate (S | M | L | XL)
- owner_type (which subagent picks this up)
- acceptance_criteria (concrete, testable)

## Hard rules

- No XL tasks ship — split them
- Every phase has explicit gate_criteria
- Dependency graph must be a DAG (validator catches cycles)

## Refinement

Show YAML to user, ask for one round of edits. Then write to `plans/phases.yaml`.

Print: "phases.yaml written. /push-to-tracker unlocked. Gate 4 — review the breakdown."

codex
The repo matches your premise so far: `SPEC.md` is explicitly drafted from PRD decisions, `ORCHESTRATOR.md` calls itself frozen, and `/decompose` writes a one-time DAG. I’m checking the relevant learnings names now because they look like they already encode some scars around SPEC vs tracker precedence.
exec
/bin/zsh -lc "sed -n '1,220p' docs/learnings/2026-Q2/spec-beats-linear-ac.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
# SPEC.md beats Linear AC when they disagree
> 2026-05-12 · FORGE-14 · tags: [spec, linear, process, dogfooding, foundation]

## What we expected
Linear FORGE-14 AC1 said the Tracker interface had 8 methods. We expected the ticket's acceptance criteria to be authoritative.

## What happened
spec/SPEC.md line 179 actually specifies 9 methods (adds `healthCheck`). Plan v1 reconstructed the interface from the Linear AC because SPEC.md is gitignored and invisible in worktrees. Plan v2 reconciled to SPEC's 9 once the file was located at `/Users/firatcandogan/repos/forge/spec/SPEC.md`. We shipped 9 and corrected Linear AC post-ship.

## Why
Forge dogfoods itself: `spec/` is gitignored by design, so worktrees never carry SPEC.md. Linear ACs are written before SPEC stabilizes and drift. The ticket looked authoritative but wasn't.

## Next time
Always read `/Users/firatcandogan/repos/forge/spec/SPEC.md` from the main repo before treating any Linear AC as ground truth. If they disagree, SPEC wins and the AC gets updated.

exec
/bin/zsh -lc "sed -n '1,220p' docs/learnings/2026-Q2/spec-api-reality-check-before-design.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
# Verify SPEC's API assumptions against the provider's real surface before designing around them

> 2026-05-13 · FORGE-16 · tags: [spec, api-verification, planning, foundation, dogfooding, eureka-preservation]

## What we expected
SPEC.md line 207 said LinearTracker should claim issues via "custom field `forge_claimed_by` (string), atomic via Linear's optimistic concurrency (revisions)". The plan would design the atomic-claim primitive around that mechanism, exactly as written. Sibling adapter `GitHubTracker` shipped against a SPEC that matched API reality, so the assumption was that SPEC would track reality here too.

## What happened
A planning-phase verification step (read Linear's GraphQL schema at `linear/linear@master/packages/sdk/src/schema.graphql`) found that `IssueUpdateInput` has **no** `revision` / `expectedRevision` / `customFields` / `metadata` field. Linear's revision counter exists in their database but is not exposed in the public API. SPEC was describing a mechanism that cannot be built. Pivoted to label-based claim + lexicographic tiebreak (same primitive `GitHubTracker` uses) before any code was written, then amended SPEC.md post-ship in six places to match shipped reality.

## Why
SPECs are written before adapter implementations and tend to describe the intended semantic ("atomic claim") in provider-shaped vocabulary the SPEC author guesses from documentation skimming. Provider docs frequently expose internal capabilities the public API doesn't. Designing around the SPEC text without API verification means designing around a phantom feature — caught only at implementation time, often after wasted plan/design work. The inverse of `spec-beats-linear-ac.md` (SPEC drift toward AC): here SPEC drifted *away* from API reality.

## Next time
For any adapter task whose SPEC references a provider capability (revision-based CAS, custom fields, native relations, webhooks, optimistic concurrency, partial updates) — **fetch the provider's actual schema/SDK types and grep for the named feature in the planning step**, before drafting per-method data flow. If absent, surface the divergence as a §11 EUREKA, pick a working primitive, and amend SPEC post-ship. Cheap to do in CC-minutes; saves multi-hour pivots. Generalizes to: don't trust upstream docs/specs that describe a provider's API surface — verify against the provider's type definitions before locking design.

exec
/bin/zsh -lc "sed -n '1,220p' docs/learnings/2026-Q2/scope-cut-worldview-check-before-multi-adapter-stdlib.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
# Worldview check before building multi-adapter stdlib

> 2026-05-12 · FORGE-18 · tags: [scope, architecture, slim-then-expand, planning, foundation]

## What we expected
Build 3 secret-manager adapters (env_file + 1password + doppler, ~700 LOC, 3pt) per the original SPEC.md plan.

## What happened
Paused mid-plan to ask "why are we building this?" — triggered a worldview check: is forge a scaffolder, a runtime stdlib, or both? SPEC implies both, but only env_file is needed to validate the abstraction. Slimmed to 1 adapter (~250 LOC, 1pt).

## Why
Multi-adapter abstractions are bets on an interface shape. If the shape is wrong, you've wasted N adapters' worth of code. Validating with the simplest provider first costs the least and de-risks the abstraction. CLI-drift and maintenance burden scale linearly with adapter count.

## Next time
Before any multi-adapter / multi-provider layer: ship 1 provider that exercises the full interface (factory + classify-error + happy + sad paths). Keep interface + factory shapes additive-friendly. Defer providers 2..N until adopter pull is real. State the worldview question explicitly in the plan — "what is this tool, and does this feature fit that worldview?"

exec
/bin/zsh -lc "sed -n '1,220p' docs/learnings/2026-Q2/worktree-hydration-runbook.md" in /Users/firatcandogan/repos/forge-worktrees/FORGE-80
 succeeded in 0ms:
# Worktree hydration runbook: the four paths to copy after `git worktree add`

> 2026-05-13 · FORGE-64 · tags: [worktree, pickup-task, dogfooding, runbook, follow-up]

## What we expected
`/pickup-task` per the skill text copies `plans/phases.yaml` into a fresh worktree (the FORGE-62 fix). That should be enough for `/plan-task` to read scope and start working.

## What happened
On FORGE-64, `/plan-task` still ran into input blindness — the planner needed `spec/SPEC.md` and `spec/ORCHESTRATOR.md` to design against; both are gitignored and absent from the fresh worktree. The skill copy step also doesn't include `plans/tasks/*.plan.md` (so the next `/implement` precondition would fail) or `docs/learnings/2026-Q2/*` (so the learning-curator finds nothing to inject). Manual `cp` of all three trees brought the worktree up to a usable state.

## Why
`worktrees-blind-to-gitignored-context.md` flagged the root cause structurally; this is the concrete operational follow-up. The exhaustive hydration set is: `spec/*.md` (BRIEF, CONTEXT, DESIGN, PRD, SPEC — ORCHESTRATOR.md happens to be tracked), `plans/phases.yaml`, `plans/tasks/*.plan.md`, and `docs/learnings/**/*.md`. Anything less and the downstream skills hit a wall they can't resolve themselves.

## Next time
Fold the full hydration set into `pickup-task`'s SKILL.md so the next worktree is usable out of the box. Until then, the runbook is one line:
```
cp spec/*.md "$WT/spec/" ; cp plans/phases.yaml "$WT/plans/" ; cp plans/tasks/*.plan.md "$WT/plans/tasks/" 2>/dev/null ; cp -r docs/learnings/* "$WT/docs/learnings/"
```
Also: write new learnings to the **main worktree's absolute path**, not `./docs/learnings/`, so they survive worktree cleanup. The inverse-failure half of the original learning bites just as hard as the input-blindness half.

web search: 
web search: Architecture Decision Records keep updated superseded status Michael Nygard ADR
codex
**1. Is Current Design Defensible? Confidence: 8/10**

Partly, but not as the primary context model for autonomous agents.

A frozen SPEC is defensible as a historical baseline: “what we thought at project start.” It is not defensible as the planning substrate if agents are instructed to hydrate from it months later.

The failure mode is real:

1. Agent picks up a dependent task.
2. `/pickup-task` hydrates `spec/`, `plans/phases.yaml`, task plan files, and learnings.
3. The agent sees `SPEC.md` as authoritative-looking architecture. In this repo it literally says decisions are “locked” from PRD.
4. It also sees `ORCHESTRATOR.md` saying “frozen reference” and “Every Phase 2 implementation task is built against this spec.”
5. Linear may contain the real rescope, but only at task granularity.
6. Learnings may contain hints, but they are append-only and not a coherent architecture update.

Likely output: the agent overfits to stale architecture, treats Linear rescope as local exception, misses cross-task consequences, or produces a hybrid design. Your own learnings already show both sides: `spec-beats-linear-ac.md` says SPEC won over Linear; `spec-api-reality-check-before-design.md` says SPEC was wrong and had to be amended after implementation. That inconsistency is dangerous for agents because they need a deterministic precedence rule.

The user is right about the gap.

**2. Right Move? Confidence: 9/10**

Do not make Linear the SPEC. Do not delete SPEC. Do not rely only on learnings.

The right move is a hybrid of **(a), (c), and (d)**:

- Add `/update-spec`.
- Make updates explicit and reviewed.
- Use versioned architectural decision sections or ADR-style records.
- Add drift diagnostics that flag stale SPEC/Linear/code relationships without auto-editing.

Concretely:

1. Keep `SPEC.md` as the coherent current architecture.
2. Add `spec/adr/` or `spec/decisions/`.
3. When architecture changes, create a dated decision record with:
   - status: accepted / superseded
   - context
   - decision
   - consequences
   - supersedes: `SPEC §X`, `ADR-N`
   - affected tasks: `FORGE-22`, etc.
4. `/update-spec` applies the accepted decision back into `SPEC.md` or adds a visible “Current Architecture Overrides” section near the top.
5. `forge orchestrate doctor` flags likely drift:
   - Linear issue contains `SCOPE EXPANDED`, `RESCOPED`, `supersedes SPEC`, but SPEC has no corresponding update.
   - learnings mention “amended SPEC post-ship” but no diff exists.
   - SPEC references symbols/modules removed from code.

This gives agents a clean read path: current SPEC first, ADRs for why, Linear for task scope, learnings for operational scars.

**3. Missing Framings / ADR Literature / Mature Agent Codebases? Confidence: 7/10**

The missing framing is: this is not “living doc vs frozen doc.” It is **snapshot spec vs decision log vs operational task state**. Those are different artifacts.

ADR practice generally says decisions should be small, dated, immutable except for status, and superseded by later decisions rather than silently rewritten. EdgeX’s ADR docs, for example, list statuses such as proposed, accepted, rejected, deprecated, and superseded. MADR similarly emphasizes superseding records. See: https://docs.edgexfoundry.org/4.0/design/adr/ and https://adr.github.io/madr/

For autonomous-agent systems, the maturity pattern is less settled. The stronger systems tend to keep a canonical protocol/spec plus explicit versioning and compatibility notes. Google’s A2A project, for example, has a canonical protocol specification rather than relying on issue history as architecture: https://github.com/a2aproject/A2A/blob/main/docs/specification.md

So I would not copy “mature agent codebases” wholesale; the field is too young. Copy older architecture governance: canonical current docs plus append-only decisions plus drift tooling.

**4. Should FORGE-80 Block? Confidence: 8/10**

No. Ship FORGE-80.

FORGE-80 is about rewriting `/sync-status` into phase-completion plus orphan diagnostics. It does not worsen the spec-update gap, and it may actually create the right surface area for future drift diagnostics.

But file the spec-staleness concern immediately as a follow-up, probably P2, not P3. It is architectural hygiene with direct agent-output consequences. I would phrase it as:

“Add explicit architecture drift/update workflow: `/update-spec` + ADR-style supersession records + doctor warnings for Linear rescope without SPEC/ADR update.”

Do not let this block the current diagnostic work unless FORGE-80 bakes in a precedence rule saying `phases.yaml` or SPEC are always authoritative. If it only reports phase completion and orphan state, ship it.
tokens used
33,125
**1. Is Current Design Defensible? Confidence: 8/10**

Partly, but not as the primary context model for autonomous agents.

A frozen SPEC is defensible as a historical baseline: “what we thought at project start.” It is not defensible as the planning substrate if agents are instructed to hydrate from it months later.

The failure mode is real:

1. Agent picks up a dependent task.
2. `/pickup-task` hydrates `spec/`, `plans/phases.yaml`, task plan files, and learnings.
3. The agent sees `SPEC.md` as authoritative-looking architecture. In this repo it literally says decisions are “locked” from PRD.
4. It also sees `ORCHESTRATOR.md` saying “frozen reference” and “Every Phase 2 implementation task is built against this spec.”
5. Linear may contain the real rescope, but only at task granularity.
6. Learnings may contain hints, but they are append-only and not a coherent architecture update.

Likely output: the agent overfits to stale architecture, treats Linear rescope as local exception, misses cross-task consequences, or produces a hybrid design. Your own learnings already show both sides: `spec-beats-linear-ac.md` says SPEC won over Linear; `spec-api-reality-check-before-design.md` says SPEC was wrong and had to be amended after implementation. That inconsistency is dangerous for agents because they need a deterministic precedence rule.

The user is right about the gap.

**2. Right Move? Confidence: 9/10**

Do not make Linear the SPEC. Do not delete SPEC. Do not rely only on learnings.

The right move is a hybrid of **(a), (c), and (d)**:

- Add `/update-spec`.
- Make updates explicit and reviewed.
- Use versioned architectural decision sections or ADR-style records.
- Add drift diagnostics that flag stale SPEC/Linear/code relationships without auto-editing.

Concretely:

1. Keep `SPEC.md` as the coherent current architecture.
2. Add `spec/adr/` or `spec/decisions/`.
3. When architecture changes, create a dated decision record with:
   - status: accepted / superseded
   - context
   - decision
   - consequences
   - supersedes: `SPEC §X`, `ADR-N`
   - affected tasks: `FORGE-22`, etc.
4. `/update-spec` applies the accepted decision back into `SPEC.md` or adds a visible “Current Architecture Overrides” section near the top.
5. `forge orchestrate doctor` flags likely drift:
   - Linear issue contains `SCOPE EXPANDED`, `RESCOPED`, `supersedes SPEC`, but SPEC has no corresponding update.
   - learnings mention “amended SPEC post-ship” but no diff exists.
   - SPEC references symbols/modules removed from code.

This gives agents a clean read path: current SPEC first, ADRs for why, Linear for task scope, learnings for operational scars.

**3. Missing Framings / ADR Literature / Mature Agent Codebases? Confidence: 7/10**

The missing framing is: this is not “living doc vs frozen doc.” It is **snapshot spec vs decision log vs operational task state**. Those are different artifacts.

ADR practice generally says decisions should be small, dated, immutable except for status, and superseded by later decisions rather than silently rewritten. EdgeX’s ADR docs, for example, list statuses such as proposed, accepted, rejected, deprecated, and superseded. MADR similarly emphasizes superseding records. See: https://docs.edgexfoundry.org/4.0/design/adr/ and https://adr.github.io/madr/

For autonomous-agent systems, the maturity pattern is less settled. The stronger systems tend to keep a canonical protocol/spec plus explicit versioning and compatibility notes. Google’s A2A project, for example, has a canonical protocol specification rather than relying on issue history as architecture: https://github.com/a2aproject/A2A/blob/main/docs/specification.md

So I would not copy “mature agent codebases” wholesale; the field is too young. Copy older architecture governance: canonical current docs plus append-only decisions plus drift tooling.

**4. Should FORGE-80 Block? Confidence: 8/10**

No. Ship FORGE-80.

FORGE-80 is about rewriting `/sync-status` into phase-completion plus orphan diagnostics. It does not worsen the spec-update gap, and it may actually create the right surface area for future drift diagnostics.

But file the spec-staleness concern immediately as a follow-up, probably P2, not P3. It is architectural hygiene with direct agent-output consequences. I would phrase it as:

“Add explicit architecture drift/update workflow: `/update-spec` + ADR-style supersession records + doctor warnings for Linear rescope without SPEC/ADR update.”

Do not let this block the current diagnostic work unless FORGE-80 bakes in a precedence rule saying `phases.yaml` or SPEC are always authoritative. If it only reports phase completion and orphan state, ship it.
