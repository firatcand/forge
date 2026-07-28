// FORGE-152: single source of truth for the CLI surface rendered into
// `.forge/CONTEXT.md` by `forge upgrade` (Phase B) and by the dogfood
// script `scripts/forge-render-context.mjs` (Phase A interim).
//
// Adding a new orchestrate verb or skill?
//   1. Implement it (handler in src/cli/orchestrate/<verb>.ts or skill in skills/<name>/)
//   2. Register it in src/cli/orchestrate/index.ts VERBS map (verbs only)
//   3. Add an entry here
//
// The conformance tests in test/unit/cli/registry.test.ts assert (3) tracks (2)
// for orchestrate verbs — adding a verb to the dispatch map without listing
// it here fails CI. Slash commands are not auto-conformed because skills/
// is markdown that ships in the tarball and isn't structurally introspectable
// at runtime.

export interface RegistryEntry {
  readonly name: string;
  readonly summary: string;
}

// CLI verbs surfaced under `forge orchestrate <verb>`. Names are the literal
// dispatch key; for sub-verbs (e.g., `run start`), the name is the
// space-joined "<top> <sub>" form.
export const CLI_VERBS: readonly RegistryEntry[] = [
  // ── Read-only band ──
  {
    name: 'phases',
    summary: 'List tasks from phases.yaml (with --ready, filter to dispatchable + overlap-classified).',
  },
  {
    name: 'doctor',
    summary: 'Drift diagnostics (--scope spec-code|all; docs; hosts — non-blocking per-host reachability preflight).',
  },
  {
    name: 'questions',
    summary: 'List open worker questions (--json + --run <id> for skill consumption).',
  },
  {
    name: 'status',
    summary: 'Snapshot of task and run state.',
  },
  {
    name: 'dashboard',
    summary:
      'Cross-run cockpit: active sessions, open questions, ready/blocked, overlap + lease health.',
  },
  {
    name: 'review-queue',
    summary: 'List tasks awaiting review (state ready_for_review) with attempt + lease info.',
  },
  {
    name: 'inbox',
    summary: 'List parked tasks (blocked_on_question) with their correlated open questions.',
  },
  {
    name: 'scan',
    summary: 'Scan a task\'s owner fields (--task) or arbitrary text (--text) for injection patterns; report-only deterministic detection (never blocks, never emits events).',
  },
  {
    name: 'attach',
    summary: 'Tail per-run notifications.jsonl.',
  },
  {
    name: 'spec-diff',
    summary: 'Show spec/ commits since claim.spec_revision for a task.',
  },
  {
    name: 'guardrail-check',
    summary: 'Check whether a path falls under agents.preflight_globs (worker preflight).',
  },
  {
    name: 'review-compose',
    summary: 'Compose a machine Verdict from a primary review (+ optional second opinion); escalate or park when a human is required.',
  },
  {
    name: 'render-worker-prompt',
    summary: 'Render the worker prompt for a dispatched attempt (read-only).',
  },
  {
    name: 'run start',
    summary: 'Start a new orchestrator run (writes runs/<id>/manifest.json).',
  },
  {
    name: 'run list',
    summary: 'List orchestrator runs (--active filters to runs with traffic).',
  },
  {
    name: 'audit plan',
    summary: 'Plan a read-only audit: render one subagent prompt per (scope × dimension). Writes nothing.',
  },
  {
    name: 'audit collect',
    summary: 'Collect subagent findings (--findings-file), filter escapes/out-of-scope/protected, write the work-order to .forge/audits/<ts>/.',
  },
  {
    name: 'audit create-issues',
    summary: 'Render one tracker-issue spec per audit finding (--work-order); the /audit skill files them out-of-band with classification labels.',
  },
  // ── Mutating band ──
  {
    name: 'ensure-worktree',
    summary: 'Idempotently create + hydrate a worktree at .forge/worktrees/<task_id>/.',
  },
  {
    name: 'claim',
    summary: 'Atomically claim a task (tracker + local lease).',
  },
  {
    name: 'dispatch',
    summary: 'Register a new worker attempt (requires prior claim).',
  },
  {
    name: 'heartbeat',
    summary: 'Renew the lease (and on first call, transition dispatched → running).',
  },
  {
    name: 'question',
    summary: 'Write a worker question (atomically), transition to blocked_on_question.',
  },
  {
    name: 'answer',
    summary: 'Supervisor answers an open question.',
  },
  {
    name: 'event',
    summary: 'Append an event to the attempt log (accepts --type drift with --data JSON).',
  },
  {
    name: 'complete',
    summary: 'Finalize an attempt: write verdict + transition state per (verdict, phase).',
  },
  {
    name: 'ship',
    summary: 'Run the verb-only ship operation: verify, SHA-bound push, PR create-or-get, tracker in_review — reviewed → merge_pending.',
  },
  {
    name: 'cancel',
    summary: 'Cancel a task: state → cancelled (terminal), release lease, preserve worktree.',
  },
  {
    name: 'reconcile',
    summary: 'Bi-directional phases.yaml ↔ tracker sync (--pull | --push).',
  },
  {
    name: 'apply-decision',
    summary: 'Apply an accepted ephemeral ADR across SPEC/PRD/phases/tracker via a resumable journal.',
  },
  {
    name: 'amend-roadmap',
    summary: 'Create a new task mid-flight: tracker-first issue + relations, then materialize into phases.yaml via reconcile (resumable journal).',
  },
  {
    name: 'gc',
    summary: 'Run the deterministic reconciler: legacy v1 migration + 14-row divergence table (--dry-run plans); --remove-worktrees [--task <id>] removes terminal-task worktrees for /wrap-up.',
  },
  {
    name: 'second-opinion',
    summary: 'Dispatch a second-opinion review through review_host_cli (claude | codex | gemini); emits a ReviewVerdict envelope.',
  },
] as const;

// FORGE-200: Loom verbs surfaced under `forge loom <verb>`. Kept SEPARATE from
// CLI_VERBS (which CONTEXT.md renders as the orchestrate verb surface) — loom is
// its own top-level namespace, not an orchestrate sub-verb. The conformance test
// in test/unit/cli/registry-loom.test.ts asserts this list tracks the
// dispatchLoom verb map both directions.
export const LOOM_VERBS: readonly RegistryEntry[] = [
  {
    name: 'reindex',
    summary: 'Rebuild the local memory graph from plans/phases.yaml + docs/learnings/** (idempotent; --scope all).',
  },
  {
    name: 'recall',
    summary: 'Dependency-aware recall for a task (--task <id>): depends_on ancestors + learned_from learnings + FTS, structural ranked over FTS.',
  },
  {
    name: 'status',
    summary: 'Report loom.db node/edge counts, the by-kind breakdown (task/learning), and the resolved db path.',
  },
  {
    name: 'query',
    summary: 'Look up nodes by --id, --kind, or --title substring (>=1 filter required; combined with AND, bounded limit).',
  },
  {
    name: 'traverse',
    summary: 'Return the bounded reachable subgraph from --node over edges in both directions (--depth hops, node/edge capped).',
  },
  {
    name: 'doctor',
    summary: 'Graph health report: orphan edges, isolated nodes, stale FTS rows, and invalid node rows (exit 2 when any found).',
  },
] as const;

// User-facing slash commands shipped by the forge npm package under skills/.
// Summaries are intentionally one-sentence — the skill body owns the long
// form. Keep this list alphabetized within each band for review ergonomics.
export const SLASH_COMMANDS: readonly RegistryEntry[] = [
  // ── Spec authoring & ingestion ──
  {
    name: 'forge',
    summary: 'Run the forge discovery interview and produce spec/BRIEF.md (first command for a new project).',
  },
  {
    name: 'draft-prd',
    summary: 'Generate spec/PRD.md from BRIEF.md with a per-feature discovery loop.',
  },
  {
    name: 'draft-spec',
    summary: 'Generate spec/SPEC.md from PRD.md (orchestrates the software-architect skill when available).',
  },
  {
    name: 'draft-design',
    summary: 'Generate spec/DESIGN.md for the project (project-owned design system or external reference).',
  },
  {
    name: 'ingest-spec',
    summary: 'Validate that BRIEF/PRD/SPEC/DESIGN are complete and consistent; build CONTEXT.md.',
  },
  {
    name: 'decompose',
    summary: 'Break the validated spec into phases.yaml — a dependency graph of tasks with gate criteria.',
  },
  {
    name: 'push-to-tracker',
    summary: 'Push phases.yaml to the configured tracker (Linear / GitHub Issues / Notion).',
  },
  // ── Task execution loop ──
  {
    name: 'pickup-task',
    summary: 'Claim the next ready task and pin this session into its worktree.',
  },
  {
    name: 'plan-task',
    summary: 'Run Plan mode for the current task; produces a structured implementation plan.',
  },
  {
    name: 'implement',
    summary: 'Execute the approved plan from /plan-task. Refuses to run without an approved plan unless --quickfix.',
  },
  {
    name: 'qa',
    summary: 'Run the test suite, browser checks, and verify acceptance criteria.',
  },
  {
    name: 'review',
    summary: 'Run code-reviewer, security-auditor (on CRITICAL.md paths), and design-reviewer on the current diff.',
  },
  {
    name: 'auto-review',
    summary: 'Drain the review-queue: review each task awaiting review and advance or escalate it.',
  },
  {
    name: 'second-opinion',
    summary: 'Dispatch a second-opinion review through the configured review host (Claude, Codex, or Gemini).',
  },
  {
    name: 'drive',
    summary: 'Drive one ticket end-to-end: claim, plan, implement, verify, cross-review loop, ship, mark Done. Pair with native /goal for hands-off completion.',
  },
  {
    name: 'deliver',
    summary: 'Drive a whole phase or feature-set: themed batching over /drive, front-loaded architectural questions, phase-gate ceremonies, lossless resume. Pair with native /goal.',
  },
  {
    name: 'autopilot',
    summary: 'Take a product idea from discovery interview to a running delivery loop: drive the spec chain pausing only at human approval gates, then roll into /deliver. Pair with native /goal.',
  },
  {
    name: 'ship',
    summary: 'Push the branch, run final gates (tests, secrets scan, conventional commit), open the PR.',
  },
  {
    name: 'wrap-up',
    summary: 'End-of-task housekeeping after a PR merges: remove the worktree, delete the local branch, reconcile, and return to a clean main.',
  },
  // ── Diagnostics & recovery ──
  {
    name: 'inbox',
    summary: 'Drain parked decisions: a tagged digest of blocked questions; pick, deep-dive, and answer each.',
  },
  {
    name: 'audit',
    summary: 'Fan out N read-only subagents to audit the codebase for safe simplification; assemble a filtered work-order of findings. Writes no source.',
  },
  {
    name: 'investigate',
    summary: 'Trace data flow, test hypotheses, identify root cause (Iron Law of Investigation gate before /fix).',
  },
  {
    name: 'fix',
    summary: 'Apply a fix based on /investigate output. Refuses to run without a recent investigation.',
  },
  {
    name: 'reconcile',
    summary: 'Diff phases.yaml against tracker; pull tracker truth into phases.yaml or push the reverse.',
  },
  {
    name: 'amend-roadmap',
    summary: 'Create a new task mid-flight: collect fields, then a tracker-first atomic amend with a resumable journal.',
  },
  {
    name: 'update-spec',
    summary: 'Draft an ephemeral ADR (--draft) or propagate the accepted decision to SPEC/PRD/phases/tracker (--apply <slug>) via apply-decision.',
  },
  // ── Phase / retrospective ──
  {
    name: 'phase-gate',
    summary: 'Ceremony to advance from phase N to phase N+1 (gate criteria + retro + approval).',
  },
  {
    name: 'retro',
    summary: 'Write a phase retrospective. Auto-invoked by /phase-gate but can run standalone.',
  },
  {
    name: 'learn',
    summary: 'Write a learning entry capturing what surprised us and what we would do differently.',
  },
] as const;
