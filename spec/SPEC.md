# forge — SPEC (v-next)

> Drafted: 2026-05-09 · **Re-amended 2026-05-17 PM (team-mode minimum architecture — partially supersedes morning amendments throughout this doc)**
> Source: spec/PRD.md
> Architectural decisions: locked in PRD §"Locked architectural decisions" (Q1–Q8)
> Stack decisions: locked below in §"Stack" (S1–S6)

## Amendments (2026-05-17 PM — team-mode minimum architecture)

Driven by [docs/plans/team-mode-minimum-architecture.md](../docs/plans/team-mode-minimum-architecture.md) and the PRD's PM amendment of the same date. After four Codex consult rounds the closed-loop drift workflow was rolled back to a minimum-viable shape.

**Sections in this SPEC that are now partially or fully superseded (read this amendment before trusting them):**

| Section | Status |
|---|---|
| §Precedence rules (6-level chain) | **Superseded** — replaced with authority-by-field (see below) |
| §ADR layer (ephemeral) | **Deferred to v0.5 opt-in** — not in v0.4 scope |
| §`/update-spec --apply` journal | **Deferred to v0.5** with the ADR layer |
| §Module layout: `apply-decision.ts`, `amend-roadmap.ts` | **Deferred to v0.5** — remove from required src/cli/orchestrate/ surface |
| §Key flows: Flow 2 drift-routing block, "routing_hint" references | **Superseded** — no drift events, no routing in v0.4 |
| §Doctor enforcement: ADR-drafts and apply-journal scopes | **Dropped** — doctor scoped to SPEC↔code only |

**Sections that stay as written:**

| Section | Status |
|---|---|
| §Stack | Unchanged |
| §Data model: `settings.yaml`, `phases.yaml`, Tracker interface | Unchanged structurally; `phases.yaml` gains a `source` metadata stanza (see below) |
| §Task state, Lease record, Attempt event, JSONL log | Unchanged (FORGE-78 infra survives) |
| §Module layout (minus the deferred items above) | Unchanged |
| §Key flows: Flow 1 (init), Flow 3 (worker lifecycle minus drift), Flow 4 (settings), Flow 5 (migrate), Flow 6 (stopping) | Unchanged |
| §Security model, Env vars, Performance, Observability, Build/test/release, Cross-host parity | Unchanged |

### Authority by field (replaces the 6-level precedence chain)

The morning's linear precedence rule (`user > SPEC > PRD > phases > tracker > attempts`) is replaced with a matrix of ownership by concern:

| Artifact | Owns |
|---|---|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria |
| `plans/phases.yaml` | Local execution snapshot (derived from tracker; do not hand-edit) |
| Tracker issue body | Execution metadata: assignee, status, sequencing, live coordination |
| Source code | Implementation |

**Workers ask "whose field is this?" not "which artifact ranks higher?"** When a worker encounters apparent conflict, the resolution is whichever artifact owns the field in question (e.g., architecture → SPEC wins; assignment → tracker wins). There is no drift event, no `--apply` propagation, no forge-mediated escalation in v0.4.

### `phases.yaml` is a derived snapshot

`plans/phases.yaml` is written **only** by `/reconcile --pull` from the tracker. All other commands that change scope (`/decompose`, `/push-to-tracker`, and the v0.5 `/amend-roadmap`) write to the tracker first, then trigger reconcile.

The schema gains an optional `source:` block:

```yaml
source:
  tracker: linear              # 'linear' | 'github' | 'notion'
  project_id: <tracker-project-id>
  synced_at: 2026-05-17T15:30:00Z
  spec_revision: <git sha of HEAD when SPEC last touched OR content digest if SPEC untracked>
```

Every CLI verb that reads `phases.yaml` prints a one-line freshness summary to stderr before its main output:

```
phases.yaml: synced 47min ago from linear (SPEC@a3c2d1f)
```

When the source block is absent (pre-FORGE-113 files; never-synced repos), the line instead says:

```
phases.yaml: no source metadata (run forge orchestrate reconcile --pull to sync)
```

When `synced_at` is older than 24h, the line is prefixed with `⚠ STALE — ` so the staleness is visually prominent (CLI exit code stays 0; the file is still usable).

Not auto-sync; just honest staleness.

**`tracker_revision` is intentionally absent.** v0.4 has no consumer for an upstream-equality token (no doctor drift-check, no `/reconcile --pull --check`). If a consumer appears, the right shape is a `Tracker.getCurrentRevision()` adapter method (each tracker mints a cheap provider-native revision: Linear `max(updatedAt)`, GitHub list ETag, Notion timestamp). A canonical-projection hash bolted onto reconcile would ship the schema field without the live-drift capability. Filed as a follow-up issue (FORGE-123 — `Add Tracker.getCurrentRevision() for live drift detection`) for when v0.5+ wants it.

**Breaking change vs v0.3.x:** the top-level `tracker_project_id` field is removed from `PhasesSchema`; the value moves into `source.project_id`. `tracker_url` stays at the top level. Migration is automatic: the first `/reconcile --pull` after upgrade transplants the legacy key from the raw Document into `source.project_id` and deletes it. No adopter action required.

### SPEC changes — no contradiction gate in v0.4

SPEC edits flow through standard git: `git commit && git push`. Other engineers `git pull` and adapt their in-flight work. No `forge spec-push --affects` flag. No section ownership tags. No active-claim-overlap check. No proposal-object lifecycle. PR review is the **team's choice**, not forge's enforcement.

The single forge-side assist (informational, not gating): workers stamp `spec_revision` at claim time. On resume, the dispatch skill prints a notification if any commits to `spec/` have landed since claim. The worker proceeds regardless.

### Out of scope for v0.4 (re-listed for clarity)

- `templates/adr.template.md` + ephemeral ADR convention
- `/update-spec --draft` and `/update-spec --apply` skills
- `forge orchestrate apply-decision` verb + journal
- `/amend-roadmap` skill + verb
- `forge orchestrate worktree-drift-guard` verb
- Drift events, drift-routed questions, `QuestionIndex.drift_event_id`, `QuestionIndex.routing_hint`
- Section ownership tags (`<!-- forge:section affects=... -->`)
- Active worktree file-glob registry as architectural-safety gate
- LLM-classified contradiction detection
- `forge spec-push --affects` flag
- Forge-enforced PR review policy
- Server-side hooks / CI gates for SPEC changes

These remain valid v0.5+ opt-in features for teams that want formal RFC-like flows. The architecture supports their reintroduction; v0.4 just doesn't require them.

---

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
  // Added 2026-05-17 (closed-loop workflow control — minimal surface after dropping Feature 7)
  codex: z
    .object({
      auto_codex_enabled: z.boolean().default(true),         // in-skill auto-suggest at /plan-task end, ADR draft, pre-/ship
      auto_codex_token_cap: z.number().int().nonnegative().default(50_000),
    })
    .default({}),
  decisions: z
    .object({
      decision_dir: z.string().default('./spec/decisions'),    // where draft ADRs live (ephemeral)
      stale_draft_threshold_days: z.number().int().positive().default(7),
    })
    .default({}),
  doctor: z
    .object({
      spec_code_check_enabled: z.boolean().default(true),     // grep SPEC for symbols, check src/ for hits
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
```

### `phases.yaml` schema (zod)

> **Note (2026-05-17):** the canonical schema lives in `src/schemas/phases.ts`; the snippet below predates the FORGE-96 task-lifecycle additions and the FORGE-113 `source` block. See §`phases.yaml` is a derived snapshot above for the `source` block schema and freshness summary semantics. Broader refresh is filed as a follow-up.

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

export interface Issue {
  id: string;              // tracker-native ID
  identifier: string;      // human-readable ID, e.g. "FORGE-42"
  title: string;
  state: IssueState;
  blockerIds: string[];    // tracker-native IDs of blocking issues
  url?: string;
  forgeTaskId?: string;    // round-trip to phases.yaml ID via metadata
}

export interface CreateIssuePayload {
  title: string;
  body: string;
  forgeTaskId: string;
  ownerType: string;
  acceptance: string[];
  dependsOn: string[];     // forge task IDs; resolved to tracker IDs by adapter
}

export type ClaimResult =
  | { ok: true; tracker_version?: string }
  | { ok: false; reason: 'already_claimed' | 'version_conflict' | 'transient_error'; detail?: string };

export interface Tracker {
  readonly type: 'linear' | 'github' | 'notion';

  // Read
  listActiveIssues(): Promise<Issue[]>;

  // Claim / release — see ORCHESTRATOR.md "Tracker atomic claim"
  claim(issueId: string, runId: string): Promise<ClaimResult>;
  releaseClaim(issueId: string, runId: string): Promise<void>;

  // State mutation
  updateState(issueId: string, state: IssueState): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;

  // Body mutation (added 2026-05-17 for /apply-decision + /reconcile propagation)
  // Replaces the entire issue body. Adapter implementations must preserve the
  // trailing forgeTaskId footer added by createIssue() so the round-trip mapping
  // (tracker → forgeTaskId) keeps working. Caller is responsible for assembling
  // the new body content.
  updateIssueBody(issueId: string, body: string): Promise<void>;

  // Project bootstrap (from /push-to-tracker)
  createProject(name: string, description?: string): Promise<{ id: string; url: string }>;
  createIssue(payload: CreateIssuePayload): Promise<Issue>;
  setBlockedBy(issueId: string, blockerId: string): Promise<void>;

  // Diagnostics
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

**Per-adapter implementation notes:**

| Adapter | Auth mechanism | Claim strength | Mechanism | Race-loss detection |
|---|---|---|---|---|
| `LinearTracker` | `@linear/sdk` with `LINEAR_API_KEY` env var | **Strong CAS** | `IssueUpdate` mutation with `expectedVersion` matching the current issue version | API returns `VersionConflict`; race loser drops task, picks next ready |
| `GitHubTracker` | `gh` CLI (`gh auth status` validated at init) | **Weak — best-effort** | Two-step: (1) `gh issue edit --add-label forge:claimed-by:<run_id>`; (2) re-fetch via `gh issue view --json labels` and verify our label is present and no other `forge:claimed-by:*` label is present | Race loser sees another `forge:claimed-by:*` label, removes its own, drops task |
| `NotionTracker` | Notion MCP server (`mcp__claude_ai_Notion__*`) | **Weak — race-detect** | Set `forge_claimed_by` property to `<run_id>`, re-fetch page, verify `last_edited_time` matches our write | If `last_edited_time` advanced past our write, another writer raced — clear claim, drop task |

Cross-run ownership truth comes from the local lease (`.forge/orchestrator/tasks/<task_id>/lease.json`), not the tracker. The tracker is the eventually-consistent rendezvous point. See `ORCHESTRATOR.md` → "Tracker atomic claim — per-adapter capability matrix" for the full rationale.

### Task state (persistent, on-disk, CLI-owned)

State is owned by the `forge` CLI and persisted at `.forge/orchestrator/tasks/<task_id>/state.json`. See `ORCHESTRATOR.md` → "State machine" for the full diagram with transitions.

```ts
type TaskState = {
  version: 1;
  task_id: string;
  status:
    | 'unclaimed'
    | 'claimed'
    | 'dispatched'
    | 'running'
    | 'blocked_on_question'
    | 'awaiting_respawn'
    | 'ready_for_review'
    | 'reviewed'
    | 'shipped'           // terminal
    | 'cancelled'         // terminal
    | 'failed'            // terminal
    | 'abandoned';        // recoverable — lease expired
  current_attempt_id: string | null;
  attempts_count: number;
  updated_at: string;     // ISO 8601
};
```

### Lease record (one per task, atomic write)

```ts
type Lease = {
  version: 1;
  claim_id: string;          // UUIDv7
  task_id: string;
  attempt_id: string | null;
  owner_run_id: string;
  acquired_at: string;
  expires_at: string;        // acquired_at + lease_ttl_ms
  last_heartbeat_at: string;
  generation: number;        // incremented on steal
};
```

### Attempt event (append-only per attempt)

See `ORCHESTRATOR.md` → "Event types" for the full type. Events are written to `.forge/orchestrator/tasks/<task_id>/attempts/<attempt_id>/events.jsonl`.

### JSONL log entry

```ts
type LogEntry = {
  ts: string;              // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;           // e.g. 'worker.dispatched', 'worker.failed', 'settings.reloaded'
  taskId?: string;
  agentId?: string;
  fields?: Record<string, unknown>;
};
```

---

## Module layout

```
src/
  bin/
    forge.ts                  // CLI entry point (replaces bin/forge.js)
  cli/
    init.ts                   // `forge init` flow
    orchestrate/              // `forge orchestrate <verb>` — see ORCHESTRATOR.md "CLI surface"
      // Read-only verbs (no lease, no tracker mutation)
      doctor.ts               // (added 2026-05-17) read-only: drift diagnostics (SPEC↔code only — ephemeral ADRs don't need SPEC↔ADR check)
      status.ts               // snapshot of task state
      questions.ts            // list open questions
      phases.ts               // graph state inspection (read-only); accepts --ready filter
      attach.ts               // tail notifications stream
      // User-approved mutations (refuses without explicit approval token where applicable)
      claim.ts                // (renamed from next.ts; deprecated alias removed per user 2026-05-17 — sole user) claims a specific task via tracker CAS
      dispatch.ts             // register new worker attempt; refuses without valid claim_id
      heartbeat.ts            // renew lease
      question.ts             // worker writes question; accepts --drift-event-id + --routing-hint
      answer.ts               // supervisor answers question
      event.ts                // append to attempt event log; supports --type drift
      complete.ts             // finalize attempt with verdict
      cancel.ts               // cancel + flag cleanup
      gc.ts                   // reconciliation pass
      run.ts                  // run start/list
      apply-decision.ts       // (added 2026-05-17) CLI verb wrapping /update-spec --apply skill's mutations; reads journal, propagates accepted ADR to SPEC + PRD + phases.yaml + tracker bodies; invokes worktree-drift-guard; deletes ADR on success
      amend-roadmap.ts        // (added 2026-05-17) create new task atomically across phases.yaml + tracker
      reconcile.ts            // (added 2026-05-17) bi-directional phases.yaml ↔ tracker sync
      worktree-drift-guard.ts // (added 2026-05-17) flags active worktrees affected by /update-spec --apply or /amend-roadmap change; writes drift events + worker questions; --dry-run for preview (Codex I1)
    migrate.ts                // `forge migrate` for v0.2.1 → v-next
    doctor.ts                 // existing (top-level wrapper; delegates to orchestrate/doctor.ts)
    install.ts                // existing
    companions.ts             // existing
  core/
    settings.ts               // load + validate + hot-reload settings.yaml (extended with codex/decisions/doctor blocks)
    phases.ts                 // load + validate phases.yaml
    workspace.ts              // worktree create / cleanup / sanitize-id; canonical worktree path is `.forge/worktrees/<sanitized-id>/`
    logger.ts                 // chalk stdout + JSONL append
    secrets.ts                // dispatch to secret manager adapter
  orchestrator/
    state-machine.ts          // task / attempt / run state transitions (CLI-owned)
    leases.ts                 // claim, heartbeat, steal-after-expiry
    events.ts                 // attempt event log writers; notification stream writer; DriftEvent type
    gc.ts                     // deterministic reconciliation (see ORCHESTRATOR.md)
    overlap.ts                // write_globs overlap detection + hard-locked globals
    verdicts.ts               // CLI-verified verdict computation (tests, lint, diff, conflicts)
    adr.ts                    // (added 2026-05-17) ephemeral ADR reader/writer; frontmatter validator; apply-journal writer; DELETES ADR on successful apply
    precedence.ts             // (added 2026-05-17) compute artifact precedence (6 levels: user > spec > prd > phases > tracker > attempt); emit drift events
    drift.ts                  // (added 2026-05-17) doctor checks: SPEC↔code, stale ADR drafts, pending apply journals
  trackers/
    base.ts                   // Tracker interface + shared types (now includes updateIssueBody)
    linear.ts                 // LinearTracker via @linear/sdk
    github.ts                 // GitHubTracker via gh CLI
    notion.ts                 // NotionTracker via MCP
  secrets-managers/
    env-file.ts
    onepassword.ts
    aws-secrets.ts
    doppler.ts
    infisical.ts
  schemas/
    settings.ts               // SettingsSchema (zod) — extended with codex/decisions/doctor blocks
    phases.ts                 // PhasesSchema (zod)
    tracker.ts                // CreateIssuePayload etc. (zod for runtime checks)
    adr.ts                    // (added 2026-05-17) AdrFrontmatterSchema (zod) — ephemeral, no supersedes
    apply-journal.ts          // (added 2026-05-17) ApplyJournalSchema (zod) for /update-spec --apply resumability
  utils/
    paths.ts                  // sanitizeIssueId, validateUnderRoot
    yaml.ts                   // load + dump w/ comment preservation
    git.ts                    // execa-wrapped git ops (worktree add/remove)
templates/
  adr.template.md             // (added 2026-05-17) ephemeral ADR scaffold used by /update-spec --draft

test/
  unit/                       // *.test.ts; node:test + tsx
  integration/                // CLI harness via execa, scratch tmpdir
  e2e/                        // examples/ as fixture projects
```

### Worktree location convention

Worker worktrees live at `.forge/worktrees/<sanitized-id>/` (project-relative, inside the repo). This applies to **both** the autonomous orchestrator (`src/orchestrator/`) and the manual `/pickup-task` skill — there is one canonical location, owned by `src/core/workspace.ts`.

Rationale:
- Consistency between human and orchestrator flows (the same worktree path resolves the same way for both).
- Self-contained: removing the project directory cleans up all worktrees with it.
- Project-relative paths (no `../` math, no sibling-directory ambiguity).
- `.forge/` is already in `forge init`'s `.gitignore` block — worktree files do not appear in `git status` of the main checkout.

`forge init` extends this convention by writing tooling-exclude entries so ESLint / Prettier / TypeScript / Vitest skip `.forge/worktrees/`:
- `.eslintignore` and `.prettierignore` get a one-line append (if present).
- `tsconfig.json` and `vitest.config.*` get a copy-paste snippet emitted to `.forge/init-warnings.md` (forge never auto-edits JSON or TypeScript config files).

---

## Key flows

### Flow 1 — `forge init` (greenfield)

1. User runs `npx @firatcand/forge init [name]` in a directory
2. CLI checks: directory writable, not a forge framework repo (`package.json.name !== '@firatcand/forge'`)
3. `@inquirer/prompts` collects: project name, description, goal, tracker, secret manager, **primary_host_cli**, **review_host_cli** (must differ from primary; choose `none` to disable second-opinion review), `subagent_cap_per_main` (default 3), `retry_attempts` (default 10), `lease_ttl_ms` (default 30 min)
4. Tooling validation per tracker choice:
   - Linear → check `LINEAR_API_KEY` env var is set; the orchestrator uses `@linear/sdk` directly. (Linear MCP probe is also kept as a soft-warn since the user-facing `/push-to-linear` skill uses MCP, but it's NOT an orchestrator-runtime dependency.)
   - GitHub → run `gh auth status`; if missing, surface `brew install gh` link
   - Notion → check MCP installed (`claude mcp list` or platform equivalent); if missing, surface install link
5. If validation fails: offer "skip and configure later" (mark settings as unverified)
6. Scaffold project files:
   - Copy `templates/BRIEF.template.md` → `spec/BRIEF.md` (placeholders)
   - Copy `templates/PRD.template.md` → `spec/PRD.md`
   - Copy `templates/SPEC.template.md` → `spec/SPEC.md`
   - Copy `templates/DESIGN.template.md` → `spec/DESIGN.md`
   - Copy `templates/CRITICAL.template.md` → `CRITICAL.md`
   - Copy `templates/CLAUDE.project.template.md` → `CLAUDE.md`
   - Create `plans/tasks/.gitkeep`
   - Create `.forge/settings.yaml` from collected answers
   - Append forge entries to `.gitignore` (idempotent)
7. Print next-steps banner: `claude` then `/forge`
8. **Total elapsed time target: <30 s including validation**

### Flow 2 — `/forge orchestrate` dispatch loop (skill-driven, present→approve→claim) — rewritten 2026-05-17

There is **no long-running orchestrator process**. The `/forge orchestrate` skill runs inside the user's Claude Code or Codex main session and drives work via the `forge orchestrate <verb>` CLI. State lives on disk; the CLI is the source of truth.

**Binding principle (suggest-don't-force):** the skill calls `phases --ready` (read-only) first and presents ready tasks to the user for explicit approval; only after approval does it call `claim` and `dispatch`. No verb in this flow may straddle the read/mutate boundary. `dispatch` refuses without a valid `claim_id` from a prior user-approved `claim`.

Pseudocode for the dispatch skill (host-agnostic; the skill source compiles to host-native syntax in Phase 3):

```
on /forge orchestrate:
  1. ensure run: run_id = forge orchestrate run start --name "<user-readable>" --json
     // run start is a mutation, allowed because invocation of /forge orchestrate = explicit user approval to begin a run

  2. while active_subagents < subagent_cap_per_main:
       # Read-only: list ready tasks (deps shipped + merged + no worktree overlap)
       result = forge orchestrate phases --ready --run <run_id> --limit <cap - active> --json
       break if result.data.tasks.length == 0

       # Present to user — show task id, title, why-ready, overlap rationale
       present_to_user(result.data.tasks)
       user_selection = await user_input  // one of: task_id | "all" | "skip" | "stop"
       break if user_selection == "stop"
       continue if user_selection == "skip"

       selected = (user_selection == "all") ? result.data.tasks : [find_by_id(user_selection)]

       # Mutations only after user approval
       for task in selected:
         claim_result = forge orchestrate claim <task.id> --run <run_id> --json
         continue if claim_result.error == "version_conflict"  // tracker race; another main won

         worktree = ensure_worktree(task.id)
         attempt = forge orchestrate dispatch <task.id> --claim <claim_result.data.claim_id> --run <run_id> --worktree <path> --json
         dispatch_subagent({
           prompt: worker_prompt(task, attempt, worktree, prior_attempts),
           cwd_hint: worktree,
         })  // Task tool (Claude) or native subagent spawn (Codex); returns on completion or block
         handle_return(task, attempt, subagent_result)

  3. poll forge orchestrate questions --open --run <run_id> --json:
       for each open question:
         render question to user (decision_key, question, context, options, recommended_option_id, routing_hint?, drift_event_id?)
         # routing_hint set when worker emitted a drift event per §Precedence rules — supervisor routes through
         # /update-spec --draft + --apply or /amend-roadmap instead of answering directly
         if question.routing_hint:
           suggest_routing(question.routing_hint)  // e.g., "this is an architectural shift — run /update-spec --draft to formalize"
         answer = await user input
         forge orchestrate answer <question_id> --answer "<answer>"
         // task transitions to awaiting_respawn; next loop iteration picks it up

  4. when all tasks in this run are terminal:
       surface "All tasks shipped (or terminal). Run complete." with status table
       offer to start new run if more ready tasks exist (back to step 2 with user approval)
```

**Worker prompt content (simplified — ephemeral ADRs):** `worker_prompt(...)` includes task description (from phases.yaml), acceptance criteria, project conventions (CLAUDE.md), and the §Precedence rules block. **No ADR hydration** — ADRs are ephemeral and SPEC already reflects all accepted decisions. Workers read `spec/SPEC.md` for current architecture.

`handle_return` interprets the subagent's terminal output:

- `"Task <id> attempt <a>: ready_for_review"` → the worker has called `forge orchestrate complete`; CLI verifies the verdict; on success, task transitions to `ready_for_review` and is eligible for REVIEW dispatch on next loop iteration.
- `"Blocked on question <q>: <summary>"` → the worker has called `forge orchestrate question`; task is `blocked_on_question`; the next loop iteration's polling step surfaces the question.
- Subagent returns without calling `complete` or `question` (i.e., it crashed or was interrupted) → CLI detects lease still alive but no terminal event; gc on next pass marks attempt `abandoned` after lease expiry.

**Single-host mode:** if `agents.review_host_cli` is `null`, REVIEW dispatch is skipped. Tasks flow IMPLEMENT → SHIP directly. A one-time warning fires from the skill on first run.

### Flow 3 — Worker subagent lifecycle (per phase)

Workers are host-native subagents. The dispatch skill spawns them via the host's primitive (Claude's Task tool or Codex's subagent dispatch). Each phase is its own subagent dispatch — no shared state between subagents except the worktree.

#### Flow 3a — IMPLEMENT phase (primary host subagent)

1. Dispatch skill ensures worktree (`git worktree add` if not exists).
2. Skill calls `forge orchestrate dispatch <task_id> --run <run_id> --worktree <path>` → returns `attempt_id`.
3. Skill spawns a subagent with the `templates/worker-prompt.md` content, with placeholders filled from `phases.yaml`, prior attempts, and answered questions.
4. Subagent runs through the worker prompt:
   - Reads task description, acceptance criteria, conventions (CLAUDE.md / AGENTS.md).
   - Heartbeats every `heartbeat_interval_ms` via `forge orchestrate heartbeat`.
   - Implements the task. Logs `files_modified`, `commit`, `tests_run`, `lint_run` events via `forge orchestrate event`.
   - On architectural fork: writes question via `forge orchestrate question`, returns "Blocked on question <id>".
   - On completion: writes `verdict.json`, calls `forge orchestrate complete --verdict-file verdict.json`, returns "Task <id> attempt <a>: ready_for_review".
5. CLI's `complete` command independently verifies the worker's verdict (re-runs tests, re-runs lint, computes diff stats from git, checks for conflicts via `git merge-tree`). Worker self-report and CLI-verified record are both written. Only on verification success does task state advance to `ready_for_review`.

#### Flow 3b — REVIEW phase (secondary host subagent)

1. Dispatch skill detects `ready_for_review` tasks via `forge orchestrate phases --ready --phase review --run <run_id> --json` (read-only). REVIEW phase dispatch does NOT require fresh user approval per task — the original IMPLEMENT approval (Flow 2 step 2) covers the full IMPLEMENT→REVIEW→SHIP arc for that task. Skill calls `forge orchestrate dispatch <task_id> --phase review --claim <existing_claim_id>` to continue.
2. Skill spawns a review subagent in the **secondary host** (e.g., Codex when primary is Claude). Implementation: for Codex, the skill calls `codex` with a review prompt that includes the worktree's `git diff <base>...HEAD`. For Claude as reviewer (primary is Codex), the skill uses Claude's Task tool to spawn a second subagent on the same worktree.
3. Review subagent reads the diff, runs the host's `/review` skill against it, writes `review_verdict.json`:
   ```ts
   type ReviewVerdict = {
     version: 1;
     verdict: 'pass' | 'changes_requested';
     findings: { severity: 'block' | 'improvement'; path: string; line?: number; message: string }[];
     host: 'claude' | 'codex' | 'cursor' | 'gemini';
   };
   ```
4. Review subagent calls `forge orchestrate complete --phase review --verdict-file review_verdict.json` and returns.
5. CLI advances state:
   - `pass` → `reviewed`, eligible for SHIP.
   - `changes_requested` → back to `running`; new IMPLEMENT attempt dispatched with `priorReviewFindings` injected into the worker prompt. Attempt counter increments.

#### Flow 3c — SHIP phase (primary host subagent)

1. Dispatch skill detects `reviewed` tasks via `forge orchestrate phases --ready --phase ship --run <run_id> --json` (read-only). SHIP phase dispatch continues the IMPLEMENT→REVIEW→SHIP arc under the original IMPLEMENT approval; no fresh user approval required.
2. **Dependency check before dispatch:** CLI filters to tasks whose `depends_on` are all in `shipped` state with their PRs merged to base. Tasks with unmerged dependencies wait. (See ORCHESTRATOR.md → "Branch / PR integration topology".)
3. Skill spawns a primary-host subagent with a ship prompt:
   - Rebase onto latest base.
   - Final secrets scan.
   - Conventional-commit verification.
   - `gh pr create` (or tracker-equivalent).
   - Mark tracker issue `in_review`.
4. Subagent calls `forge orchestrate complete --phase ship --verdict-file ship_verdict.json` with the PR URL.
5. On success: task state → `shipped`; notification `shipped` emitted with PR URL.
6. On failure (rare; usually transient): retry with backoff. After `retry_attempts` failures: task `failed`, fatal notification.

#### Phase machine diagram

```
        ┌──────────────────────────────────────────┐
        │                                           │
        ▼                                           │
   [unclaimed] ──claim──▶ [running (impl)]         │ retry on
                                │                   │ changes_requested
                                │ verdict verified  │
                                ▼                   │
                          [ready_for_review]        │
                                │                   │
                          [running (review)]────────┘
                                │
                                │ pass
                                ▼
                            [reviewed]
                                │
                                │ all deps shipped + merged
                                ▼
                          [running (ship)]
                                │
                                │ PR opened, tracker updated
                                ▼
                            [shipped]
```

Failures at any phase enter the retry queue with exponential backoff (CLI-managed). After `agents.retry_attempts` total failures, the task is marked `failed` per `agents.on_persistent_failure`.

**Backoff formula:**
```
delay_ms = min(1000 * 2^(attempt - 1), retry_backoff_ms_max)
```

### Flow 4 — Settings loading

Settings are loaded by **every CLI invocation** from `.forge/settings.yaml`. No hot-reload mechanism needed — there's no long-running process to reload into. Each `forge orchestrate <verb>` call parses + validates settings, applies them, and exits. Changes to settings.yaml take effect on the very next CLI call.

For the dispatch skill specifically: the skill calls `forge orchestrate phases --ready` on every loop iteration, so a settings change is picked up at most one tick later.

### Flow 5 — `forge migrate` (v0.2.1 → v-next)

1. Read existing project files
2. Detect drift:
   - `spec/DESIGN.md` containing `@inherit` lines
   - References to `/push-to-linear` in skills, docs, comments
   - Missing `.forge/settings.yaml`
3. Generate proposed diff:
   - Replace `@inherit` lines with concrete project-owned content (using existing brand assets as reference if configured)
   - Update doc references `/push-to-linear` → `/push-to-tracker`
   - Synthesize `.forge/settings.yaml` from any existing config
4. Print diff with chalk; confirm with `@inquirer/prompts`
5. Apply on confirmation; back up originals to `.forge/backup-<timestamp>/`

### Flow 6 — Stopping work

There is no orchestrator process to pause or stop. The dispatch skill runs only while the user has it active in their main session; closing the session stops new dispatches.

To intervene on active work:

- **Cancel a specific task:** `forge orchestrate cancel <task-id> [--reason <text>]` — marks the current attempt `cancelled`, releases the lease, preserves the worktree for inspection. A worker subagent that is mid-flight on a cancelled task will fail its next heartbeat with `LEASE_RELEASED` and exit.
- **Stop the dispatch loop:** the user simply stops interacting with the skill in their main session. Already-dispatched subagents continue to completion (they don't observe parent intent until next heartbeat). To force-stop a worker immediately, cancel its task.
- **Multiple mains:** each main session is independent; stopping one main has no effect on another.
- **Recovery after stop:** any `unclaimed` or `awaiting_respawn` tasks resume on next `/forge orchestrate` invocation. `forge orchestrate gc` reconciles any stale state from the prior session.

---

## ADR layer (ephemeral — added 2026-05-17, simplified)

Architectural Decision Records (ADRs) are **ephemeral staging artifacts** for in-flight decisions. They live in `spec/decisions/` only while drafted and pending review. After `/update-spec --apply <slug>` propagates the decision to SPEC + PRD + phases + tracker, the ADR file is **DELETED**; rationale lives in the propagation commit message body.

**Why ephemeral, not append-only:** SPEC is the sole durable source of truth. Permanent ADR archives accumulate over time, add token-budget concerns for any agent reading them, and create a "two-source" problem. Git history (`git log -- spec/SPEC.md`) preserves rationale; commit messages on `/update-spec --apply` carry full Context + Decision + Alternatives + Consequences.

### Filesystem

```
spec/decisions/
  2026-05-17-suggest-dont-force.md      # in-flight; will be deleted on --apply
  templates/adr.template.md             # template scaffold (separate location, not deleted)
```

Naming convention: `<YYYY-MM-DD>-<kebab-slug>.md`. The slug becomes the identifier used in `/update-spec --apply <slug>`. No `ADR-NNN` numbering needed since ADRs don't persist (no need for sortable IDs across history).

### ADR template (`templates/adr.template.md`)

```markdown
---
slug: <kebab-slug>           # auto-filled from filename by /update-spec --draft
date: YYYY-MM-DD             # auto-filled
status: proposed             # user flips to "accepted" when ready for /update-spec --apply
affected_tasks: []           # tracker_issue_ids or phases.yaml task IDs
affected_spec_sections: []   # SPEC anchors, e.g. "spec/SPEC.md §CLI surface"
affected_prd_sections: []    # PRD anchors, e.g. "spec/PRD.md §Feature 2"
affected_phases_tasks: []    # phases.yaml task IDs whose ACs change
---

# {Decision title}

## Context
{what triggered this decision}

## Decision
{what we decided}

## Consequences
{positive + negative; what changes downstream}

## Alternatives considered
{briefly — options A, B, C with rejection reasons}
```

### Zod schema (`src/schemas/adr.ts`)

```ts
import { z } from 'zod';

export const AdrStatus = z.enum(['proposed', 'accepted', 'rejected']);
export type AdrStatus = z.infer<typeof AdrStatus>;

export const AdrFrontmatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: AdrStatus,
  affected_tasks: z.array(z.string()).default([]),
  affected_spec_sections: z.array(z.string()).default([]),
  affected_prd_sections: z.array(z.string()).default([]),
  affected_phases_tasks: z.array(z.string()).default([]),
});

export type AdrFrontmatter = z.infer<typeof AdrFrontmatterSchema>;
```

Note: no `id`, `supersedes`, or `superseded_by` fields. Ephemeral ADRs don't need a supersedes chain; if a decision is reversed, write a new ADR + apply it. The git log shows the sequence.

### Lifecycle

1. **proposed** — `/update-spec --draft` writes the file. User reviews + (optionally) runs `/codex review-decision`. User edits the draft to incorporate feedback.
2. **accepted** — User manually flips frontmatter `status: proposed → accepted` when ready to propagate. (No automated state machine; the workflow is suggest-not-enforce.)
3. **rejected** — User flips to `status: rejected` if they decide not to proceed; `forge orchestrate doctor` will warn after `decisions.stale_draft_threshold_days` (default 7) that a rejected ADR should be deleted manually.

`/update-spec --apply <slug>` requires `status: accepted`; refuses otherwise.

### `/update-spec --apply` journal (resumable — Codex C2)

The apply operation mutates 4 artifact classes (SPEC, PRD, phases.yaml, tracker bodies). To survive partial failures, the operation is journaled at `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`:

```ts
type ApplyJournalSchema = {
  version: 1;
  slug: string;
  started_at: string;            // ISO 8601
  spec_sections: Array<{
    ref: string;                 // e.g., "spec/SPEC.md#cli-surface"
    status: 'pending' | 'applied' | 'failed';
    applied_at?: string;
    error?: string;
  }>;
  prd_sections: Array<{ ref: string; status: 'pending' | 'applied' | 'failed'; applied_at?: string; error?: string }>;
  phases_tasks: Array<{ id: string; status: 'pending' | 'applied' | 'failed'; applied_at?: string; error?: string }>;
  tracker_issues: Array<{
    id: string;
    status: 'pending' | 'applied' | 'failed';
    applied_at?: string;
    error?: string;
    retries: number;
  }>;
  completed_at?: string;          // set when ALL entries are 'applied'; ADR file is deleted at this point
};
```

Workflow:

1. `/update-spec --apply <slug>` reads journal if it exists, else creates new
2. For each entry with `status: 'pending'`, perform the mutation, update entry to `applied` (or `failed` with error)
3. After all entries are `applied`, set `completed_at`, delete ADR file from `spec/decisions/`, archive journal under `.forge/orchestrator/global/update-spec-apply-journal/completed/<slug>.json`
4. `--resume` skips entries with `status: applied`; retries `pending` and `failed`
5. `--dry-run` shows the diff per artifact without writing journal or mutations

### Doctor checks for ADR layer (simplified — ephemeral model)

`forge orchestrate doctor` enforces:

- **Stale draft warning:** any ADR file in `spec/decisions/` (excluding templates) older than `decisions.stale_draft_threshold_days` triggers a warning (exit 1)
- **Pending apply journal:** any `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json` with entries in `pending` or `failed` triggers a warning to run `/update-spec --apply <slug> --resume` (exit 1)
- **No SPEC↔ADR check** (was a check under the append-only model; under ephemeral, SPEC IS the truth post-apply and ADR is gone)
- **SPEC↔code check** (preserved from earlier doctor): SPEC references to symbols grep to ≥1 hit in `src/` (exit 2 on drift)

---

## Precedence rules (added 2026-05-17, simplified — ephemeral ADRs)

This section operationalizes [PRD §Precedence rules](./PRD.md#precedence-rules-binding-contract--added-2026-05-17). Refer there for the binding ordering and policy. This section defines the TypeScript types and the resolver function.

**ADRs are NOT in the precedence chain.** They are ephemeral staging artifacts (see §ADR layer); SPEC is the sole durable architectural source of truth. Once `/update-spec --apply` runs, the ADR is deleted and its content lives in SPEC + the apply-commit message body.

### Drift event type

```ts
// src/orchestrator/events.ts (extended)

export type ArtifactKind =
  | 'user'        // current-session user instruction
  | 'spec'        // spec/SPEC.md
  | 'prd'         // spec/PRD.md
  | 'phases'      // plans/phases.yaml
  | 'tracker'     // tracker issue body (projection of phases.yaml)
  | 'attempt';    // older attempt notes

export type DriftEvent = {
  version: 1;
  kind: 'drift';
  from_artifact: ArtifactKind;  // the LOWER-precedence artifact whose content the worker would have to violate to honor `to_artifact`
  to_artifact: ArtifactKind;    // the HIGHER-precedence artifact the worker is honoring
  from_ref: string;             // e.g., "plans/phases.yaml#FORGE-91:acceptance[3]"
  to_ref: string;               // e.g., "spec/SPEC.md#cli-surface"
  detail: string;               // free text explaining the contradiction
  detected_by: 'worker' | 'doctor' | 'update-spec-apply' | 'reconcile';
  task_id?: string;
  attempt_id?: string;
  ts: string;                   // ISO 8601
};
```

Drift events are written to `.forge/orchestrator/tasks/<task_id>/attempts/<attempt_id>/events.jsonl` (worker-emitted) or to `.forge/orchestrator/global/drift-events.jsonl` (doctor/update-spec-apply/reconcile-emitted).

### Precedence resolver

```ts
// src/orchestrator/precedence.ts

export const PRECEDENCE_ORDER: ArtifactKind[] = [
  'user', 'spec', 'prd', 'phases', 'tracker', 'attempt'
];

export type ArtifactClaim = {
  kind: ArtifactKind;
  ref: string;
  content: string;
};

export type AuthorityResolution = {
  winner: ArtifactClaim;
  losers: ArtifactClaim[];
  drift_events: DriftEvent[];
};

/**
 * Given multiple artifacts claiming authority on the same question, returns
 * the highest-precedence one and emits drift events for each loser whose
 * content contradicts the winner.
 *
 * Caller is responsible for routing drift events to:
 *  - tasks/<id>/attempts/<id>/events.jsonl (when invoked from worker)
 *  - global/drift-events.jsonl (when invoked from doctor/apply-decision/reconcile)
 */
export function resolveAuthority(
  claims: ArtifactClaim[],
  context: { detected_by: DriftEvent['detected_by']; task_id?: string; attempt_id?: string }
): AuthorityResolution;
```

### When worker detects drift

Worker MUST emit a drift event and pause the attempt with state `blocked_on_question` rather than silently fixing. See PRD §Precedence rules for the routing decision (`/apply-decision` | `/amend-roadmap` | manual resolution).

### Doctor enforcement

`forge orchestrate doctor` reads all artifacts, runs `resolveAuthority()` for each cross-artifact claim it can detect, and exits:

- 0 = clean (no drift events emitted)
- 1 = warnings (advisory)
- 2 = drift detected (SPEC references symbols missing from `src/`; phases.yaml task IDs not in tracker)

---

## Auto-codex skill-level hooks (added 2026-05-17)

Feature 7 (host-level SessionStart/Stop/UserPromptSubmit hooks) was DROPPED 2026-05-17. The only host-integration retained is in-skill auto-codex suggestion, which fires inside skills at architectural decision points — NOT via host hooks.

| Trigger point (inside skill) | Suggested invocation |
|---|---|
| `/plan-task` exits with a plan | `/codex review-plan` |
| `/update-spec --draft` writes a draft ADR | `/codex review-decision` |
| `/ship` pre-PR finalize | `/codex review-impl` |

Each suggestion is a printed line at skill end: `"💡 Suggested next: /codex review-decision (run with FORGE_AUTO_CODEX=0 to disable)"`. User types or skips. No automatic execution.

Bounded by `codex.auto_codex_token_cap` in settings.yaml (default 50000 tokens/session). When budget exceeded, remaining auto-codex suggestions are skipped with a one-line warning. Env vars: `FORGE_AUTO_CODEX=0` disables; `FORGE_AUTO_CODEX_TOKEN_CAP=<n>` overrides settings.

### Why no host hooks

The original Feature 7 design installed Claude Code SessionStart/Stop/UserPromptSubmit hooks for automatic session re-grounding. After Codex review and user pushback (2026-05-17), this layer was dropped because:

1. **One-session-one-task workflow doesn't need it.** User opens Claude Code → picks up task via `/pickup-task` → ships task → closes session. The existing skill-end nudges + explicit `/status-check` cover re-grounding.
2. **Host hooks add platform fragility.** Claude Code hook shape/semantics change across versions; maintaining parity with Codex CLI hooks is moving target.
3. **The closed-loop drift workflow (Features 5+6) doesn't depend on host hooks.** Workers detect drift via §Precedence rules and emit events; `/update-spec --apply` invokes `worktree-drift-guard` directly.

If host-hook re-grounding becomes valuable later (e.g., for team workflows), it can be added as a separate feature without changing the v0.4 core.

---

## Skill ↔ verb contract (added 2026-05-17 per Codex I5)

Forge ships two parallel surfaces: **skills** (user-invoked via slash commands in the host CLI) and **CLI verbs** (`forge orchestrate <verb>` subcommands). Their relationship:

| Layer | Owns | Examples |
|---|---|---|
| **Skills** | UX, conversation, prompts, diff previews, user confirmation, multi-step orchestration | `/forge`, `/draft-prd`, `/pickup-task`, `/update-spec`, `/amend-roadmap`, `/reconcile`, `/ship` |
| **CLI verbs** | Deterministic state machine, atomic operations, machine-parseable I/O, no human prompts | `forge orchestrate claim`, `dispatch`, `heartbeat`, `complete`, `apply-decision`, `worktree-drift-guard` |

### The pattern

When a user invokes `/update-spec --apply <slug>`:

1. **Skill (interaction layer)** reads the draft ADR, computes the propagation diff, shows it to the user, gets per-artifact confirmation
2. **Skill calls** `forge orchestrate apply-decision --adr <slug> --confirmed-artifacts <list> --json`
3. **CLI verb (state machine)** executes the atomic writes, records the journal, returns `{ok, data}` envelope
4. **Skill** parses the JSON, prints success or surfaces failures with retry guidance

Skills are the CONVERSATION; verbs are the COMPUTATION. Skills can change without breaking the verb contract; verbs can be called directly (by scripts, by other skills) without going through a skill.

### Naming convention

- Skills use the natural-language form: `/update-spec --apply` (reads like English)
- Verbs use the snake-case form: `forge orchestrate apply-decision` (precise, scriptable)
- One skill can wrap multiple verbs (e.g., `/forge orchestrate` skill wraps `run start`, `phases --ready`, `claim`, `dispatch`, `heartbeat`, `complete`)
- One verb is often wrapped by exactly one skill, but can be called directly for testing or scripting

### Read-only vs mutate boundary stays at the verb layer

Skills can be either; their classification follows the verbs they wrap. `/status-check` wraps only read-only verbs (`status`, `questions`, `phases`, `doctor`) and is itself read-only. `/update-spec --apply` wraps mutate verbs and requires user confirmation per artifact.

---

## Integration points

### External tooling forge depends on

| Tool | Required for | Validation in init flow | Failure mode |
|---|---|---|---|
| `LINEAR_API_KEY` env var | Tracker = linear (orchestrator runtime) | Check env var presence at init via `getEnv` seam | Init prompts user to mint a Personal API Key at linear.app/settings/account/security |
| Linear MCP server | `/push-to-linear` skill (NOT orchestrator runtime) | Soft probe `claude mcp list` | Init shows soft-warn only; orchestrator does not depend on MCP |
| `gh` CLI | Tracker = github | `gh auth status` exit code 0 | Init prompts `brew install gh` + `gh auth login`, offers skip |
| Notion MCP | Tracker = notion | MCP server installed + healthcheck call | Init prompts to install MCP, offers skip-and-configure-later |
| Primary host CLI | Dispatch skill loaded into user's main session; spawns IMPLEMENT + SHIP subagents | `--version` exit code 0 | Init lists detected hosts; orchestrate skill warns if `agents.primary_host_cli` host isn't the host the skill is running in |
| Review host CLI (different from primary) | Dispatch skill spawns REVIEW subagent in secondary host (e.g. `codex` invoked from a Claude main) | `--version` exit code 0 | Init validates `review_host_cli !== primary_host_cli` and host is detected; warns if missing, allows skip-and-disable |
| `git` | Worktree management | `git --version` ≥ 2.20 | Init refuses; forge doesn't run on machines without git |
| Secret manager | Per `secrets.manager` choice | Per-manager probe (e.g. `op vault list`, `doppler --version`) | Init can mark unverified |

### Files forge owns

- `.forge/settings.yaml` (created by init, edited by user)
- `.forge/logs/orchestrate.jsonl` (append-only global event log, rotated when >100 MB)
- `.forge/orchestrator/runs/<run_id>/` (per-run metadata + notifications stream — see ORCHESTRATOR.md)
- `.forge/orchestrator/tasks/<task_id>/` (per-task state, lease, attempts — see ORCHESTRATOR.md)
- `.forge/worktrees/<sanitized-task-id>/` (worktree per task; cleaned via `forge orchestrate gc`)
- `.forge/backup-<timestamp>/` (migration backups)

All under `.forge/` to keep blast radius scoped. `.forge/` is gitignored by default in scaffolded `.gitignore`.

---

## Learnings store

`docs/learnings/{quarter}/{slug}.md` is forge's compound-learning corpus — short markdown records ("what we expected / what happened / why / next time") written by `/learn`, indexed by quarter, and re-injected as context by `/pickup-task` and `learning-curator`. The store is the load-bearing artifact behind ETHOS principle 5 (Compound Learning).

**Canonical location.** The single source of truth is the **main checkout's** `docs/learnings/` tree, addressed by absolute path `${MAIN_ROOT}/docs/learnings/` where `MAIN_ROOT = dirname(git rev-parse --git-common-dir)`. `git rev-parse --git-common-dir` resolves to the main checkout's `.git` directory from anywhere inside the repo — main or any worktree — so this idiom works uniformly. The same idiom anchors `/pickup-task`'s hydration step (see `skills/pickup-task/SKILL.md` lines 47–53).

**Worktree semantics.** `docs/learnings/` is **gitignored** under the forge-dogfood publish-hygiene rule (we use forge to build forge but don't ship internal product docs in the published npm package). Because the path is gitignored, `git worktree add` does not auto-populate it. Consumers and producers handle this asymmetrically:

- **Consumers (read).** `/pickup-task` hydrates a fresh worktree's `docs/learnings/` by `cp -r` from `${MAIN_ROOT}/docs/learnings/` at creation time, so `learning-curator` and any other reader sees the full corpus locally.
- **Producers (write).** `/learn` always writes the canonical record to `${MAIN_ROOT}/docs/learnings/{quarter}/{slug}.md` first, then mirrors the same content to the current worktree's path when `pwd -P != MAIN_ROOT`. Main-first ordering means a botched mirror write still leaves the canonical record intact. When `/learn` runs from the main checkout the two paths collapse to a single write.

The worktree's hydrated copy is a snapshot — it is allowed to drift from `${MAIN_ROOT}` during a long-lived worktree session, and the next `/pickup-task` re-hydrates fresh from main. The mirror write exists only so that same-session reads (`Read ./docs/learnings/...` from inside the worktree) succeed without round-tripping through the canonical path.

**Why not move out of the repo root.** Relocating `docs/learnings/` outside the repo (e.g. `~/.forge/projects/<slug>/learnings/`) would make it worktree-orthogonal by construction. That's a larger refactor (every skill that touches the dir must be updated, plus a migration for existing adopters) and is tracked separately. The dual-write contract is the minimal, fully-reversible fix that satisfies the canonical-store invariant without that surface area.

**Collision policy.** A write to a canonical path that already exists must refuse, not overwrite. Two learnings with the same slug indicate either a slug-derivation collision (which should be fixed by changing the title) or an intent to update an existing learning (which should be done via `Edit`, not `Write`).

**Cross-references.**
- Producer contract: `skills/learn/SKILL.md`
- Consumer contract: `skills/pickup-task/SKILL.md`
- Root-cause origin: `docs/learnings/2026-Q2/worktrees-blind-to-gitignored-context.md`
- Hydration runbook: `docs/learnings/2026-Q2/worktree-hydration-runbook.md`

---

## Security model

### What forge handles vs delegates

- **AI provider auth (Anthropic, OpenAI, etc.)** — DELEGATED to host CLIs. Forge never sees API keys. Workers spawn with the user's existing host session.
- **Tracker auth** — DELEGATED to adapter tooling: `gh` CLI for GitHub (no extra env), `@linear/sdk` + `LINEAR_API_KEY` env var for Linear (Personal API Key minted by user), Notion MCP for Notion (no secret manager needed). Linear was originally specced as "via MCP" but the orchestrator is a Node CLI, not an LLM host — using MCP would have required implementing OAuth device flow + token cache management for marginal benefit. See `docs/adapters/linear.md` for the rationale.
- **Secret manager auth** — DELEGATED to manager's own CLI/SDK (op CLI, doppler CLI, AWS SDK chain, etc.).
- **Forge-stored secrets** — none for trackers (all three delegate auth via CLI or MCP). The secret manager remains useful for adopter projects' own secrets (their API keys, etc.), not for forge core.

### Threat model and mitigations

| Threat | Mitigation |
|---|---|
| Path traversal via tracker-supplied issue IDs (worktree path injection) | `sanitizeIssueId(id)`: replace `[^A-Za-z0-9._-]` with `_`; `validateUnderRoot(path, root)` prefix-check after `path.resolve()` |
| Command injection via subprocess args | Use `execa` array form — never string concatenation; never pass user input to shell |
| Race on tracker claim | Per-adapter mechanism: Linear `expectedVersion` (strong CAS); GitHub label-add + verify-on-readback (weak, race-loss detected); Notion `last_edited_time` (race-detect-only). Local lease is the cross-run ownership truth. See ORCHESTRATOR.md → "Tracker atomic claim". |
| Secrets leaking to logs | Logger redacts known secret keys (env vars matching `*_KEY`, `*_TOKEN`, `*_SECRET`); JSONL write goes through redactor |
| Stale claim on crashed main / killed worker | Lease records `expires_at` + heartbeat. `forge orchestrate gc` (auto-run on every `next` and `status`) marks stale leases steal-eligible after `lease_ttl_ms + steal_grace_ms`. See ORCHESTRATOR.md → "Lease semantics". |
| Two mains on same project | Each has own `run_id`. Local lease enforces at-most-one-worker-per-task; tracker is rendezvous. See ORCHESTRATOR.md → "Multi-main coordination". |
| Worker subagent hangs | Heartbeat misses extend lease no further; lease expires; steal-after-expiry kicks in and a new attempt picks up the worktree. |
| Disk fill from worktrees | `forge orchestrate gc --remove-worktrees` removes worktrees of terminal tasks; runs on user opt-in (not automatic, to preserve forensics on cancelled tasks). |
| **Workflow isolation is not security isolation** | Documented honestly. Workers can read globally-readable files and env vars. Adopters needing true sandboxing must add OS-level isolation. See ORCHESTRATOR.md → "Tool-permission isolation". |
| Settings.yaml committed with secrets | Schema rejects any field matching `*_key`, `*_token`, `*_secret` in non-secrets sections; documented in init flow |

### Multi-host review (generalizes ETHOS principle 6)

ETHOS principle 6 ("Multi-model Second Opinion — Codex CLI on critical paths") **upgrades to**: every orchestrator-shipped task gets a review from the secondary host (`review_host_cli`), not just CRITICAL.md paths. The existing `/codex` skill becomes a special case where `review_host_cli == 'codex'`.

For interactive (non-orchestrator) work, `/codex` keeps its existing CRITICAL.md-only behaviour for backward compat. The new universal-review behaviour only triggers in the orchestrator's REVIEW phase (Flow 3b).

`/ship` enforces both: the in-host `/review` skill must have been run, and (when orchestrator-driven) the REVIEW phase verdict file must show `pass`.

---

## Environment variables (12-Factor)

Forge consumes:

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `FORGE_LOG_LEVEL` | no | One of `debug` / `info` / `warn` / `error` | `info` |
| `FORGE_NO_COLOR` | no | Disable chalk output | unset (color on) |
| `FORGE_PRIMARY_HOST_CLI` | no | Override `agents.primary_host_cli` from settings | from settings.yaml |
| `FORGE_REVIEW_HOST_CLI` | no | Override `agents.review_host_cli`; set to `none` to disable second-opinion | from settings.yaml |
| `FORGE_SETTINGS_PATH` | no | Override `.forge/settings.yaml` location | `./.forge/settings.yaml` |

Tracker / secret-manager adapters consume their own conventional vars (e.g. `ANTHROPIC_API_KEY` if `secrets.manager: env_file`, `OP_SERVICE_ACCOUNT_TOKEN` for 1Password). These are documented per-adapter in `docs/adapters/`.

---

## Performance targets

| Target | Threshold | Rationale |
|---|---|---|
| `npx @firatcand/forge --version` cold start | p95 < 500 ms | First-impression latency |
| `npm pack` size | unpacked ≤ 1 MB | Lightweight discipline (PRD constraint) |
| `forge init` end-to-end | p95 < 30 s | PRD acceptance criterion |
| Orchestrator dispatch loop overhead at idle | < 1% CPU on M-class laptop | Foreground process must coexist with editor |
| Worktree create | p95 < 2 s | User-visible per-task latency |
| Settings change → effect | ≤ next CLI invocation (every `forge orchestrate <verb>` re-reads settings) | By design |
| 10 concurrent workers steady state | < 200 MB orchestrator RSS | Worker subprocesses dominate; orchestrator stays small |

---

## Observability

### Log destinations

1. **stdout** — pretty output via `chalk`; user-facing during foreground orchestration
2. **`.forge/logs/orchestrator.jsonl`** — append-only structured JSONL; one entry per event; rotated at 100 MB
3. **Tracker comments** — orchestrator posts state-change comments on each issue (`claimed`, `succeeded`, `failed (attempt N)`, `blocked after N retries`)

### Key events to log

```
cli.invoked                 { verb, run_id?, task_id?, args_summary }
run.started                 { run_id, host, agent_id }
task.claimed                { task_id, run_id, claim_id, generation, tracker_version? }
task.lease_renewed          { task_id, attempt_id, expires_at }
task.lease_stolen           { task_id, from_generation, to_generation, by_run_id }
task.lease_released         { task_id, run_id, reason: 'completed'|'cancelled'|'expired' }
attempt.dispatched          { task_id, attempt_id, run_id, phase, worktree_path }
attempt.event_appended      { task_id, attempt_id, event_type }
attempt.question_written    { task_id, attempt_id, question_id, decision_key }
attempt.answer_recorded     { question_id, answered_at }
attempt.completed           { task_id, attempt_id, verdict, verdict_verified }
attempt.verdict_unverified  { task_id, attempt_id, verdict_field, worker_claim, cli_reality }
attempt.cancelled           { task_id, attempt_id, reason }
attempt.abandoned           { task_id, attempt_id, reason: 'lease_expired'|'worker_died' }
phase.transitioned          { task_id, from_state, to_state }
review.verdict              { task_id, verdict: 'pass'|'changes_requested', host, finding_count }
review.changes_requested    { task_id, findings_excerpt, attempt }
task.shipped                { task_id, run_id, pr_url, total_attempts }
task.failed                 { task_id, attempts, last_error_excerpt }
gc.divergence_detected      { task_id, local_state, tracker_state, action }
gc.action_taken             { task_id, action, dry_run: boolean }
tracker.error               { adapter, op, error_excerpt }
overlap.warning             { task_a, task_b, overlapping_globs }
overlap.blocked             { task_a, task_b, hard_lock_glob }
```

### `forge doctor` checks (existing command, extended)

- Settings file exists and validates
- Tracker reachable (via `healthCheck()`)
- Host CLI detected for configured `agents.primary_host_cli` and `agents.review_host_cli`
- Worktree root writable
- No orphan worktrees from prior runs (delegates to `forge orchestrate gc --dry-run`)
- Log file size sane
- `.forge/orchestrator/` state divergence summary (from `gc --dry-run`)

---

## Build, test, release

### Build
```
tsup src/bin/forge.ts src/index.ts \
  --format esm,cjs \
  --target node18 \
  --dts \
  --clean \
  --out-dir dist
```

`package.json` updates:
- `"main": "dist/index.cjs"` (consumer-facing API, if any)
- `"bin": { "forge": "dist/bin/forge.cjs" }`
- `"types": "dist/index.d.ts"`
- `"exports"`: dual ESM+CJS entry

`files` whitelist updated: `dist/`, `skills/`, `agents/`, `templates/`, `ETHOS.md`, `README.md`, `LICENSE`. (Source `src/` excluded; `lib/` deprecated and removed once migration is done.)

### Tests
- `node --test --import tsx test/unit/**/*.test.ts`
- Integration: spawn `tsx src/bin/forge.ts <subcommand>` in tmpdir; assert filesystem + exit codes
- E2E: `examples/` as fixture projects; one full lifecycle run on each tracker (Linear, GitHub, Notion) in CI matrix

### Release
- Git tag `v0.3.0` (this is v-next)
- `npm publish --access public`
- GitHub release with CHANGELOG.md entry
- Migration note for v0.2.1 users prominently in README

---

## Implementation strategy (TS migration)

The codebase migrates from JS to TS in this order, each landing as its own PR for reviewability:

1. **PR-1 — Build infra:** Add `tsup`, `tsconfig.json`, `tsx`, `@types/node`. Wire `npm run build`, `npm run typecheck`, `npm test`. Existing `bin/forge.js` stays.
2. **PR-2 — Schemas + utils:** New `src/schemas/`, `src/utils/`. No behavior change.
3. **PR-3 — Core (settings, phases, logger, workspace):** Migrate from `lib/`. Old `lib/` files deleted in same PR.
4. **PR-4 — Tracker adapter base + GitHubTracker:** First adapter end-to-end. Tested against a fixture repo.
5. **PR-5 — LinearTracker + NotionTracker.**
6. **PR-6 — Init flow (`src/cli/init.ts`):** Replaces inquirer prompts in old `bin/forge.js`.
7. **PR-7 — Orchestrator (dispatcher, worker, retry, signals).**
8. **PR-8 — Migrate command (`src/cli/migrate.ts`).**
9. **PR-9 — Polish: doctor extension, performance tests, docs, CHANGELOG.**

Each PR is decomposable and parallelizable in `phases.yaml`. PR-2 through PR-5 can run in parallel after PR-1.

---

## Out of scope (v-next)

(Carrying forward from PRD non-goals, plus SPEC-level additions:)

- Long-running orchestrator daemon (deleted in v2 — see ORCHESTRATOR.md "Changes from v1")
- `execa`-based subprocess workers (workers are host-native subagents)
- Provider API key / Agent SDK / pay-as-you-go usage anywhere in the runtime (subscription billing only)
- Trello / Jira / Asana adapters (Linear, GitHub, Notion supported; others deferred)
- Cross-machine orchestration
- Web dashboard / TUI (CLI `--json` output is the machine surface)
- Stacked-PR branch strategy (schema reserved, not implemented)
- Direct GitHub REST/GraphQL fallback (`gh` CLI required)
- Auto-merge of PRs (dependency-shipped check uses merged-to-base state — humans merge)
- Encrypted settings.yaml (secrets stay in secret manager)
- Skill portability across host CLIs (deferred to Phase 3)

---

## Open questions deferred to phases.yaml decomposition

(These are implementation-detail-level questions that don't change architecture; resolved during `/decompose` or in individual `/plan-task` artifacts.)

- Exact prompt forge sends to host CLI when dispatching a worker (templated in `templates/worker-prompt.md`)
- CHANGELOG migration message wording for v0.2.1 users
- Test fixture repos for the 3 tracker adapters (separate-repo or in-repo `examples/`?)
- Logging verbosity tier for redacted secrets (probably `debug` only)
- Whether `forge doctor` runs at the start of `forge orchestrate` automatically

---

## Cross-host parity matrix

Each feature must work on all four supported hosts:

| Feature | Claude Code | Codex CLI | Cursor | Gemini CLI |
|---|---|---|---|---|
| Skills install | ✅ verified | ✅ verified | ⚠️ unverified (existing) | ⚠️ unverified (existing) |
| Subagent dispatch primitive | ✅ Task tool (parent context) | ✅ native subagents (`agents.max_depth`, `spawn_agents_on_csv`) | ⚠️ — verify | ⚠️ — verify |
| Worker working directory | Prompt-level (`cd <worktree> &&` discipline; no native `cwd` per subagent) | Native (`--cd` on subagent spawn / `codex exec -C`) | ⚠️ | ⚠️ |
| Subscription billing for subagents | ✅ subagents bill against parent's interactive Claude Code session | ✅ ChatGPT Plus covers `codex` interactive + `codex exec` from same bucket | ⚠️ | ⚠️ |
| Init flow | ✅ identical | ✅ identical | ✅ identical | ✅ identical |
| `forge orchestrate` CLI surface | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic |
| Settings.yaml | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic |
| Tracker adapters | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic | ✅ host-agnostic |

Cursor + Gemini parity is a known gap from v0.2.1 README — **explicitly deferred** to a separate verification task in `phases.yaml`. v-next ships with Claude Code + Codex CLI verified for orchestration; Cursor + Gemini supported on a best-effort basis.
