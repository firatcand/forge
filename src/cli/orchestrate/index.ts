// Verb-table dispatcher for `forge orchestrate <verb> [...]`.
//
// Replaces the legacy if-chain. Adding a new verb means: (1) write the verb
// handler module, (2) register it here with its band metadata, (3) write its
// help string in help.ts. The dispatcher walks the registry for --help so the
// classification table cannot drift from the implementation.

import { fail, emit } from '../envelope.ts';
import { TASK_ID_RE as SHARED_TASK_ID_RE } from '../../schemas/task-id.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import { runOrchestrateAnswer } from './answer.ts';
import { runOrchestrateAttach } from './attach.ts';
import { runOrchestrateGc } from './gc.ts';
import { runOrchestrateQuestions } from './questions.ts';
import { runOrchestrateSpecDiff } from './spec-diff.ts';
import { runOrchestrateStatus } from './status.ts';
import { parseFlag, firstPositional } from './flags.ts';
import { phasesHandler } from './phases.ts';
import { doctorHandler } from './doctor.ts';
import { runStartHandler } from './run-start.ts';
import { runListHandler } from './run-list.ts';
import { claimHandler } from './claim.ts';
import { dispatchHandler } from './dispatch.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { questionWriteHandler } from './question-write.ts';
import { eventHandler } from './event.ts';
import { completeHandler } from './complete.ts';
import { cancelHandler } from './cancel.ts';
import { applyDecisionHandler } from './apply-decision.ts';
import { amendRoadmapHandler } from './amend-roadmap.ts';
import { runOrchestrateReconcile } from './reconcile.ts';
import { guardrailCheckHandler } from './guardrail-check.ts';
import { reviewComposeHandler } from './review-compose.ts';
import { ensureWorktreeHandler } from './ensure-worktree.ts';
import { renderWorkerPromptHandler } from './render-worker-prompt.ts';
import { secondOpinionHandler } from './second-opinion.ts';
import { dashboardHandler } from './dashboard.ts';
import { modelsHandler } from './models.ts';
import { routeHandler } from './route.ts';
import { reviewQueueHandler } from './review-queue.ts';
import { inboxHandler } from './inbox.ts';
import { auditPlanHandler, auditCollectHandler, auditCreateIssuesHandler } from './audit.ts';

export type VerbBand = 'read' | 'mutate';

// FORGE-134: per-verb flag declaration. `takesValue: true` marks a flag whose
// NEXT token is its value (so a `--help`/`-h` sitting in that value position is a
// value, never a help request). `takesValue: false` is a boolean flag. The
// declared set must MATCH what the handler actually parses (parseFlag → value,
// hasFlag → boolean) so the value-aware --help interceptor cannot misclassify.
export interface FlagDecl {
  readonly flag: string; // canonical long form WITHOUT leading dashes, e.g. 'scope'
  readonly takesValue: boolean;
  readonly description: string;
  readonly aliases?: ReadonlyArray<string>; // other long names that map to the same flag
  readonly valueLabel?: string; // display label for the value, default '<value>'
}

export interface VerbHandler {
  readonly band: VerbBand;
  readonly synopsis: string;
  readonly flags?: ReadonlyArray<FlagDecl>;
  readonly run: (rest: readonly string[], opts: DispatcherOpts) => Promise<{ exitCode: number }>;
}

export interface DispatcherOpts {
  readonly cwd: string;
}

export type VerbRegistry = Map<string, VerbHandler | Map<string, VerbHandler>>;

// ── Adapter wrappers for the 6 pre-existing verbs ────────────────────────────
// Each wrapper extracts flags into the verb's existing options shape, calls
// the verb's runner, and returns { exitCode }.

const questionsHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List open worker questions (--json + --run <id> for skill consumption).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const runId = parseFlag(rest, 'run') ?? parseFlag(rest, 'run-id');
    const result = runOrchestrateQuestions({
      open: hasFlag(rest, 'open'),
      forgeDir,
      json: hasFlag(rest, 'json'),
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const answerHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Supervisor answers an open question.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const questionId = firstPositional(rest) ?? '';
    const optionId = parseFlag(rest, 'option') ?? '';
    const note = parseFlag(rest, 'note');
    const result = runOrchestrateAnswer({
      questionId,
      optionId,
      forgeDir,
      ...(note ? { note } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const statusHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Snapshot of task and run state.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    // FORGE-149: --run is an alias for --run-id (ORCHESTRATOR.md documents --run).
    const runId =
      firstPositional(rest) ?? parseFlag(rest, 'run-id') ?? parseFlag(rest, 'run');
    const result = runOrchestrateStatus({
      forgeDir,
      json: hasFlag(rest, 'json'),
      includeWarnings: hasFlag(rest, 'include-warnings'),
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const attachHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Tail per-run notifications.jsonl.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    // FORGE-149: --run is an alias for --run-id (declared in FLAG_DECLS.attach
    // and documented in ORCHESTRATOR.md). The handler MUST honor it, else the
    // advertised alias silently no-ops and attach falls back to the latest run.
    const runId =
      firstPositional(rest) ?? parseFlag(rest, 'run-id') ?? parseFlag(rest, 'run');
    const result = await runOrchestrateAttach({
      forgeDir,
      follow: true,
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const gcHandler: VerbHandler = {
  band: 'mutate',
  synopsis:
    'Run the deterministic reconciler: legacy v1 migration + 14-row divergence table (--dry-run plans); --remove-worktrees [--task <id>] [--prune-merged-branches] removes terminal-task worktrees.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const dryRun = hasFlag(rest, 'dry-run');

    // ── `--remove-worktrees` — mutually exclusive early mode (FORGE-116) ──
    if (hasFlag(rest, 'remove-worktrees')) {
      // No other gc flags may combine with this mode. Allowed companions are
      // exactly: --task <id>, --dry-run, --json, and --forge-dir.
      const ALLOWED = new Set([
        'remove-worktrees',
        'task',
        'dry-run',
        'json',
        'forge-dir',
        // FORGE-139 — opt-in safe merged-branch reclaim (`git branch -d`).
        'prune-merged-branches',
      ]);
      for (const arg of rest) {
        if (!arg.startsWith('--')) continue;
        const name = arg.slice(2).split('=')[0]!;
        if (!ALLOWED.has(name)) {
          const envelope = fail(
            'INVALID_ARGS',
            `forge orchestrate gc --remove-worktrees: unknown or incompatible flag '--${name}'. ` +
              `In this mode only --task <id>, --dry-run, --json, and --prune-merged-branches are accepted.`,
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
      }
      // Fix 4 (FORGE-116): reject any positional argument in --remove-worktrees
      // mode. The accepted surface is exactly --task <id>, --dry-run, --json,
      // --forge-dir. A positional (any token not starting with '--' and not the
      // value of a flag that consumes the next token) is not part of this surface.
      {
        const valueFlags = new Set(['task', 'forge-dir']); // flags that consume next token
        let i = 0;
        while (i < rest.length) {
          const a = rest[i]!;
          if (a.startsWith('--')) {
            const name = a.slice(2).split('=')[0]!;
            // If it's a value-consuming flag in `--flag value` form, skip the value token too.
            if (valueFlags.has(name) && !a.includes('=')) {
              i += 2;
            } else {
              i += 1;
            }
          } else {
            // Positional token.
            const envelope = fail(
              'INVALID_ARGS',
              `forge orchestrate gc --remove-worktrees: unexpected positional argument '${a}'. ` +
                `This mode accepts no positional arguments; use --task <id> to scope to a single task.`,
              false,
            );
            return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
          }
        }
      }
      // --task, if present, must carry a value that passes the task-id format.
      // Fix 1 (FORGE-116): validate BEFORE any path construction so that a value
      // like `../..` is rejected with INVALID_ARGS rather than escaping .forge/worktrees.
      // Single source of truth (FORGE-130) — the handler pre-validates with
      // the SAME shape the verb enforces; no local regex.
      const TASK_ID_RE = SHARED_TASK_ID_RE;
      let scopedTask: string | undefined;
      if (hasFlag(rest, 'task')) {
        const value = parseFlag(rest, 'task');
        if (value === undefined || value.length === 0 || value.startsWith('--')) {
          const envelope = fail(
            'INVALID_ARGS',
            "forge orchestrate gc --remove-worktrees: --task requires a value (the task id).",
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
        if (!TASK_ID_RE.test(value)) {
          const envelope = fail(
            'INVALID_ARGS',
            `forge orchestrate gc --remove-worktrees: --task value '${value}' is not a valid task id. ` +
              `Expected: a path-safe id — alphanumeric start, then letters/digits/./_/- (max 64); see src/schemas/task-id.ts.`,
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
        scopedTask = value;
      }
      const result = await runOrchestrateGc({
        forgeDir,
        dryRun,
        removeWorktrees: true,
        json: hasFlag(rest, 'json'),
        ...(hasFlag(rest, 'prune-merged-branches') ? { pruneMergedBranches: true } : {}),
        ...(scopedTask !== undefined ? { removeWorktreesTask: scopedTask } : {}),
      });
      return { exitCode: result.exitCode };
    }

    const result = await runOrchestrateGc({ forgeDir, dryRun });
    return { exitCode: result.exitCode };
  },
};

const specDiffHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Show spec/ commits since claim.spec_revision for a task (or --all-active for every active claim).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = firstPositional(rest) ?? '';
    const json = hasFlag(rest, 'json');
    const allActive = hasFlag(rest, 'all-active');
    const repoRoot = parseFlag(rest, 'repo-root');
    const result = await runOrchestrateSpecDiff({
      taskId,
      forgeDir,
      json,
      ...(allActive ? { allActive } : {}),
      ...(repoRoot ? { repoRoot } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const reconcileHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Bi-directional phases.yaml ↔ tracker sync (--pull | --push).',
  async run(rest, opts) {
    const result = await runOrchestrateReconcile({
      cwd: opts.cwd,
      argv: rest,
    });
    return { exitCode: result.exitCode };
  },
};

// ── Per-verb flag declarations (FORGE-134) ───────────────────────────────────
// Reality-matched: each entry mirrors the parseFlag (value) / hasFlag (boolean)
// / firstPositional (positional) calls in the verb's handler. Most read/mutate
// handlers accept `--forge-dir <path>` via resolveForgeDir(); declared per verb.
// `--json` is declared where the handler reads it. Aliases (e.g. --run/--run-id)
// are ONE entry with `aliases`. Positionals are NOT flags and are noted in the
// synopsis, not here.

const FD: FlagDecl = { flag: 'forge-dir', takesValue: true, description: 'Path to the .forge directory (default <cwd>/.forge).', valueLabel: '<path>' };
const JSON_FLAG: FlagDecl = { flag: 'json', takesValue: false, description: 'Emit a stable JSON envelope on stdout.' };

const FLAG_DECLS: Record<string, ReadonlyArray<FlagDecl>> = {
  phases: [
    { flag: 'ready', takesValue: false, description: 'Filter to dispatchable, overlap-classified ready tasks.' },
    { flag: 'phase', takesValue: true, description: 'Phase filter: implement | review | ship.', valueLabel: '<phase>' },
    { flag: 'blocked-by', takesValue: true, description: 'Only tasks depending on this task id.', valueLabel: '<task-id>' },
    { flag: 'limit', takesValue: true, description: 'Cap the number of tasks returned.', valueLabel: '<n>' },
    { flag: 'run', takesValue: true, description: 'Scope to a run id.', aliases: ['run-id'], valueLabel: '<id>' },
    { flag: 'include-warnings', takesValue: false, description: 'With --ready --json, add auto-gc cheap divergences as a warnings array.' },
    JSON_FLAG,
    FD,
  ],
  status: [
    { flag: 'run', takesValue: true, description: 'Run id to inspect (default: latest).', aliases: ['run-id'], valueLabel: '<id>' },
    { flag: 'include-warnings', takesValue: false, description: 'With --json, add auto-gc cheap divergences as a warnings array.' },
    JSON_FLAG,
    FD,
  ],
  dashboard: [JSON_FLAG, FD],
  models: [
    { flag: 'refresh', takesValue: false, description: 'Validate --file and write the catalog cache.' },
    { flag: 'file', takesValue: true, description: 'With --refresh, the agent-compiled catalog JSON to validate + write.', valueLabel: '<json>' },
    { flag: 'availability', takesValue: false, description: 'Probe per-host reachability (bin --version + env + file-exists; no paid call). Mutually exclusive with --refresh.' },
    JSON_FLAG,
    FD,
  ],
  'review-queue': [JSON_FLAG, FD],
  route: [
    { flag: 'task', takesValue: true, description: 'Task id (phases id or tracker issue id) to route.', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id — records a model_routed event when a lease is held.', valueLabel: '<attempt-id>' },
    JSON_FLAG,
    FD,
  ],
  inbox: [JSON_FLAG, FD],
  questions: [
    { flag: 'open', takesValue: false, description: 'Only open (unanswered) questions.' },
    { flag: 'run', takesValue: true, description: 'Scope to a run id.', aliases: ['run-id'], valueLabel: '<id>' },
    JSON_FLAG,
    FD,
  ],
  doctor: [
    { flag: 'scope', takesValue: true, description: 'Drift scope: spec-code (default) | all | docs (non-blocking docs-coverage over the branch diff).', valueLabel: '<scope>' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    { flag: 'base', takesValue: true, description: 'With --scope docs: base ref for the diff (default origin/main→main→merge-base). Compares committed-vs-base only.', valueLabel: '<ref>' },
    JSON_FLAG,
    FD,
  ],
  attach: [
    { flag: 'run', takesValue: true, description: 'Run id whose notifications.jsonl to tail.', aliases: ['run-id'], valueLabel: '<id>' },
    FD,
  ],
  'spec-diff': [
    { flag: 'all-active', takesValue: false, description: 'List every active task (dispatched|running|blocked_on_question) whose claim predates a spec/ change.' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    JSON_FLAG,
    FD,
  ],
  'guardrail-check': [
    { flag: 'path', takesValue: true, description: 'Path to check against preflight globs.', valueLabel: '<path>' },
    { flag: 'task', takesValue: true, description: 'Task id (records a guardrail_checked event with --attempt).', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    JSON_FLAG,
    FD,
  ],
  'review-compose': [
    { flag: 'primary', takesValue: true, description: 'JSON file with the primary (Claude) ReviewVerdict, or a second-opinion envelope.', valueLabel: '<file>' },
    { flag: 'second-opinion', takesValue: true, description: 'JSON file with a second-opinion ReviewVerdict (or envelope); absent → null.', valueLabel: '<file>' },
    { flag: 'branch', takesValue: true, description: 'Branch name (passed into ComposeCtx).', valueLabel: '<str>' },
    { flag: 'summary', takesValue: true, description: 'Verdict summary (passed into ComposeCtx).', valueLabel: '<str>' },
    { flag: 'critical-path', takesValue: false, description: 'The diff touches a CRITICAL.md / architectural path.' },
    { flag: 'second-opinion-available', takesValue: false, description: 'A second-opinion review host was configured & reachable.' },
    JSON_FLAG,
    FD,
  ],
  'render-worker-prompt': [
    { flag: 'task', takesValue: true, description: 'Task id.', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    JSON_FLAG,
    FD,
  ],
  'ensure-worktree': [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'branch', takesValue: true, description: 'Branch name to create.', valueLabel: '<name>' },
    { flag: 'base', takesValue: true, description: 'Base branch to fork from.', valueLabel: '<branch>' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    JSON_FLAG,
    FD,
  ],
  claim: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'run', takesValue: true, description: 'Owning run id.', aliases: ['run-id'], valueLabel: '<id>' },
    { flag: 'force', takesValue: false, description: 'Force claim despite overlap gate.' },
    JSON_FLAG,
    FD,
  ],
  dispatch: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'claim', takesValue: true, description: 'Claim id from a prior claim.', valueLabel: '<claim-id>' },
    { flag: 'run', takesValue: true, description: 'Owning run id.', aliases: ['run-id'], valueLabel: '<id>' },
    { flag: 'worktree', takesValue: true, description: 'Worktree path for the attempt.', valueLabel: '<path>' },
    { flag: 'phase', takesValue: true, description: 'Phase: implement (default) | review | ship.', valueLabel: '<phase>' },
    JSON_FLAG,
    FD,
  ],
  heartbeat: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    JSON_FLAG,
    FD,
  ],
  question: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    { flag: 'decision-key', takesValue: true, description: 'Decision key (question-channel budget bucket).', valueLabel: '<key>' },
    { flag: 'question', takesValue: true, description: 'The question text.', valueLabel: '<text>' },
    { flag: 'options-file', takesValue: true, description: 'Path to a JSON options file.', valueLabel: '<path>' },
    { flag: 'classification-file', takesValue: true, description: 'Path to a DecisionClassification JSON (decision_type/category/reversibility/blast_radius/default_action/reason). Validated via the schema; an explicit but invalid file fails (no fallback to category:other).', valueLabel: '<path>' },
    { flag: 'recommended-option-id', takesValue: true, description: 'Recommended option id.', valueLabel: '<id>' },
    { flag: 'what-happens-if-unanswered', takesValue: true, description: 'Consequence text if unanswered.', valueLabel: '<text>' },
    { flag: 'question-budget-soft', takesValue: true, description: 'Soft question budget.', valueLabel: '<n>' },
    { flag: 'question-budget-hard', takesValue: true, description: 'Hard question budget.', valueLabel: '<n>' },
    { flag: 'drift-event-id', takesValue: true, description: 'Originating drift event id.', valueLabel: '<id>' },
    { flag: 'routing-hint', takesValue: true, description: 'Routing hint: apply-decision | amend-roadmap.', valueLabel: '<hint>' },
    JSON_FLAG,
    FD,
  ],
  answer: [
    { flag: 'option', takesValue: true, description: 'Chosen option id.', valueLabel: '<id>' },
    { flag: 'note', takesValue: true, description: 'Free-text supervisor note.', valueLabel: '<text>' },
    FD,
  ],
  event: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    { flag: 'type', takesValue: true, description: 'Event type (e.g. drift).', valueLabel: '<type>' },
    { flag: 'data', takesValue: true, description: 'JSON object payload for the event.', valueLabel: '<json>' },
    JSON_FLAG,
    FD,
  ],
  complete: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'attempt', takesValue: true, description: 'Attempt id.', valueLabel: '<attempt-id>' },
    { flag: 'verdict-file', takesValue: true, description: 'Path to the verdict JSON file.', valueLabel: '<path>' },
    { flag: 'phase', takesValue: true, description: 'Phase: implement (default) | review | ship.', valueLabel: '<phase>' },
    JSON_FLAG,
    FD,
  ],
  cancel: [
    { flag: 'task', takesValue: true, description: 'Task id (else first positional).', valueLabel: '<task-id>' },
    { flag: 'reason', takesValue: true, description: 'Cancellation reason.', valueLabel: '<text>' },
    JSON_FLAG,
    FD,
  ],
  reconcile: [
    { flag: 'pull', takesValue: false, description: 'Tracker → phases.yaml.' },
    { flag: 'push', takesValue: false, description: 'phases.yaml → tracker bodies.' },
    { flag: 'dry-run', takesValue: false, description: 'Plan only; write nothing.' },
    { flag: 'confirm-prune', takesValue: false, description: 'Confirm pruning of removed tasks.' },
    { flag: 'no-prune', takesValue: false, description: 'Never prune removed tasks.' },
    { flag: 'task', takesValue: true, description: 'Scope the run to a single task id.', valueLabel: '<task-id>' },
    { flag: 'check', takesValue: false, description: 'With --pull: short-circuit when upstream is unchanged.' },
    JSON_FLAG,
  ],
  'apply-decision': [
    { flag: 'adr', takesValue: true, description: 'ADR slug (else first positional).', valueLabel: '<slug>' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    { flag: 'yes-all', takesValue: false, description: 'Approve every per-artifact diff without prompting.' },
    { flag: 'resume', takesValue: false, description: 'Resume from an existing journal.' },
    { flag: 'dry-run', takesValue: false, description: 'Plan only; write nothing.' },
    JSON_FLAG,
    FD,
  ],
  'amend-roadmap': [
    { flag: 'payload', takesValue: true, description: 'Path to the amend payload (YAML).', valueLabel: '<path>' },
    { flag: 'resume', takesValue: true, description: 'Resume the amend for this task id.', valueLabel: '<task-id>' },
    { flag: 'repo-root', takesValue: true, description: 'Repository root (default: cwd).', valueLabel: '<path>' },
    JSON_FLAG,
    FD,
  ],
  gc: [
    { flag: 'dry-run', takesValue: false, description: 'Plan only; write nothing.' },
    { flag: 'remove-worktrees', takesValue: false, description: 'Remove terminal-task worktrees (mutually exclusive mode).' },
    { flag: 'task', takesValue: true, description: 'With --remove-worktrees, scope to one task id.', valueLabel: '<task-id>' },
    { flag: 'prune-merged-branches', takesValue: false, description: 'With --remove-worktrees, also git branch -d merged branches.' },
    JSON_FLAG,
    FD,
  ],
  'second-opinion': [
    { flag: 'task', takesValue: true, description: 'Task id to review.', valueLabel: '<task-id>' },
    { flag: 'diff', takesValue: true, description: 'Diff text or ref to review.', valueLabel: '<diff>' },
    { flag: 'prompt', takesValue: true, description: 'Custom review prompt.', valueLabel: '<text>' },
    { flag: 'cwd', takesValue: true, description: 'Working directory for the reviewer.', valueLabel: '<path>' },
    { flag: 'timeout-ms', takesValue: true, description: 'Reviewer timeout in milliseconds.', valueLabel: '<ms>' },
    JSON_FLAG,
    FD,
  ],
};

// Nested run sub-verb flag declarations.
const RUN_SUB_FLAG_DECLS: Record<string, ReadonlyArray<FlagDecl>> = {
  start: [
    { flag: 'name', takesValue: true, description: 'Human-friendly run name.', valueLabel: '<name>' },
    JSON_FLAG,
    FD,
  ],
  list: [
    { flag: 'active', takesValue: false, description: 'Only runs with traffic.' },
    JSON_FLAG,
    FD,
  ],
};

// FORGE-179: nested audit sub-verb flag declarations.
const AUDIT_SUB_FLAG_DECLS: Record<string, ReadonlyArray<FlagDecl>> = {
  plan: [
    { flag: 'scope', takesValue: true, description: 'Comma-separated scope globs (override auto-discovery / settings).', valueLabel: '<globs>' },
    { flag: 'dimensions', takesValue: true, description: 'Comma-separated audit dimensions (override settings).', valueLabel: '<dims>' },
    JSON_FLAG,
    FD,
  ],
  collect: [
    { flag: 'findings-file', takesValue: true, description: 'JSON file with the array of subagent findings to filter + write.', valueLabel: '<path>' },
    { flag: 'scope', takesValue: true, description: 'Comma-separated scope globs (override auto-discovery / settings).', valueLabel: '<globs>' },
    { flag: 'dimensions', takesValue: true, description: 'Comma-separated audit dimensions actually run (recorded in the work-order).', valueLabel: '<dims>' },
    JSON_FLAG,
    FD,
  ],
  'create-issues': [
    { flag: 'work-order', takesValue: true, description: 'Path to a work-order.json; render one issue spec per finding.', valueLabel: '<path>' },
    { flag: 'umbrella', takesValue: true, description: 'Also render a summary umbrella-issue spec with this title.', valueLabel: '<title>' },
    JSON_FLAG,
    FD,
  ],
};

// Attach declared flags onto an imported handler without mutating the original.
function withFlags(handler: VerbHandler, flags: ReadonlyArray<FlagDecl>): VerbHandler {
  return { ...handler, flags };
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const VERBS: VerbRegistry = new Map<string, VerbHandler | Map<string, VerbHandler>>([
  // Read-only band.
  ['phases', withFlags(phasesHandler, FLAG_DECLS['phases']!)],
  ['doctor', withFlags(doctorHandler, FLAG_DECLS['doctor']!)],
  ['questions', withFlags(questionsHandler, FLAG_DECLS['questions']!)],
  ['status', withFlags(statusHandler, FLAG_DECLS['status']!)],
  ['dashboard', withFlags(dashboardHandler, FLAG_DECLS['dashboard']!)],
  ['models', withFlags(modelsHandler, FLAG_DECLS['models']!)],
  ['route', withFlags(routeHandler, FLAG_DECLS['route']!)],
  ['review-queue', withFlags(reviewQueueHandler, FLAG_DECLS['review-queue']!)],
  ['inbox', withFlags(inboxHandler, FLAG_DECLS['inbox']!)],
  ['attach', withFlags(attachHandler, FLAG_DECLS['attach']!)],
  ['spec-diff', withFlags(specDiffHandler, FLAG_DECLS['spec-diff']!)],
  ['guardrail-check', withFlags(guardrailCheckHandler, FLAG_DECLS['guardrail-check']!)],
  ['review-compose', withFlags(reviewComposeHandler, FLAG_DECLS['review-compose']!)],
  ['render-worker-prompt', withFlags(renderWorkerPromptHandler, FLAG_DECLS['render-worker-prompt']!)],
  ['run', new Map<string, VerbHandler>([
    ['start', withFlags(runStartHandler, RUN_SUB_FLAG_DECLS['start']!)],
    ['list', withFlags(runListHandler, RUN_SUB_FLAG_DECLS['list']!)],
  ])],
  ['audit', new Map<string, VerbHandler>([
    ['plan', withFlags(auditPlanHandler, AUDIT_SUB_FLAG_DECLS['plan']!)],
    ['collect', withFlags(auditCollectHandler, AUDIT_SUB_FLAG_DECLS['collect']!)],
    ['create-issues', withFlags(auditCreateIssuesHandler, AUDIT_SUB_FLAG_DECLS['create-issues']!)],
  ])],
  // Mutating band.
  ['ensure-worktree', withFlags(ensureWorktreeHandler, FLAG_DECLS['ensure-worktree']!)],
  ['claim', withFlags(claimHandler, FLAG_DECLS['claim']!)],
  ['dispatch', withFlags(dispatchHandler, FLAG_DECLS['dispatch']!)],
  ['heartbeat', withFlags(heartbeatHandler, FLAG_DECLS['heartbeat']!)],
  ['question', withFlags(questionWriteHandler, FLAG_DECLS['question']!)],
  ['answer', withFlags(answerHandler, FLAG_DECLS['answer']!)],
  ['event', withFlags(eventHandler, FLAG_DECLS['event']!)],
  ['complete', withFlags(completeHandler, FLAG_DECLS['complete']!)],
  ['cancel', withFlags(cancelHandler, FLAG_DECLS['cancel']!)],
  ['reconcile', withFlags(reconcileHandler, FLAG_DECLS['reconcile']!)],
  ['apply-decision', withFlags(applyDecisionHandler, FLAG_DECLS['apply-decision']!)],
  ['amend-roadmap', withFlags(amendRoadmapHandler, FLAG_DECLS['amend-roadmap']!)],
  ['gc', withFlags(gcHandler, FLAG_DECLS['gc']!)],
  ['second-opinion', withFlags(secondOpinionHandler, FLAG_DECLS['second-opinion']!)],
]);

// Order used for --help rendering. Read-only first, then mutating, then nested.
export const HELP_ORDER: readonly string[] = [
  'phases',
  'status',
  'dashboard',
  'models',
  'route',
  'review-queue',
  'inbox',
  'questions',
  'doctor',
  'attach',
  'spec-diff',
  'guardrail-check',
  'review-compose',
  'render-worker-prompt',
  'run',
  'audit',
  'ensure-worktree',
  'claim',
  'dispatch',
  'heartbeat',
  'question',
  'answer',
  'event',
  'complete',
  'cancel',
  'reconcile',
  'apply-decision',
  'amend-roadmap',
  'gc',
  'second-opinion',
];

// FORGE-134: value-aware --help detection. Scan the verb's args left-to-right
// using its OWN flag declarations. A token immediately following a declared
// `takesValue: true` flag (in `--flag value` form) is that flag's VALUE and is
// never treated as --help. We intercept only a `--help`/`-h` sitting in FLAG
// position. Unknown `--x` tokens are treated as boolean for the scan (declarations
// are required to be complete for this batch). `--flag=value` forms consume no
// following token.
function wantsHelp(args: readonly string[], flags: ReadonlyArray<FlagDecl> | undefined): boolean {
  // Build the set of long names that consume the next token.
  const valueTakers = new Set<string>();
  for (const f of flags ?? []) {
    if (f.takesValue) {
      valueTakers.add(f.flag);
      for (const a of f.aliases ?? []) valueTakers.add(a);
    }
  }
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i] ?? '';
    if (tok === '--help' || tok === '-h') return true;
    if (tok.startsWith('--') && !tok.includes('=')) {
      const name = tok.slice(2);
      if (valueTakers.has(name) && i + 1 < args.length) {
        // Next token is this flag's value — skip it so a `--help` there is a value.
        i += 1;
      }
    }
  }
  return false;
}

// Render the per-verb help: `forge orchestrate <verb> — <synopsis>` + aligned
// flag table + a footer pointing at the top-level help. In --json mode an ok
// envelope `{ verb, band, synopsis, flags }` is returned instead.
function renderVerbHelp(verb: string, handler: VerbHandler, json: boolean): string {
  const flags = handler.flags ?? [];
  if (json) {
    return `${JSON.stringify({
      ok: true,
      data: {
        verb,
        band: handler.band,
        synopsis: handler.synopsis,
        flags: flags.map((f) => ({
          flag: f.flag,
          takesValue: f.takesValue,
          description: f.description,
          ...(f.aliases && f.aliases.length > 0 ? { aliases: f.aliases } : {}),
        })),
      },
    })}\n`;
  }
  const left = (f: FlagDecl): string => {
    const base = f.takesValue ? `--${f.flag} ${f.valueLabel ?? '<value>'}` : `--${f.flag}`;
    const alias = f.aliases && f.aliases.length > 0 ? ` (alias: ${f.aliases.map((a) => `--${a}`).join(', ')})` : '';
    return base + alias;
  };
  const cols = flags.map(left);
  const width = cols.reduce((m, c) => Math.max(m, c.length), 0);
  const lines: string[] = [`forge orchestrate ${verb} — ${handler.synopsis}`, ''];
  if (flags.length > 0) {
    lines.push('Flags:');
    flags.forEach((f, idx) => {
      lines.push(`  ${cols[idx]!.padEnd(width)}  ${f.description}`);
    });
    lines.push('');
  }
  lines.push('See `forge orchestrate --help` for the full verb list.');
  return `${lines.join('\n')}\n`;
}

export async function dispatchOrchestrate(
  rest: readonly string[],
  opts: DispatcherOpts,
): Promise<{ exitCode: number }> {
  const sub = rest[0];
  if (!sub) {
    // No verb. Show usage on stderr; exit 1 (consistent with the rest of forge.ts).
    process.stderr.write(usage());
    return { exitCode: 1 };
  }
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return { exitCode: 0 };
  }
  const entry = VERBS.get(sub);
  if (!entry) {
    const envelope = fail(
      'UNKNOWN_VERB',
      `forge orchestrate: unknown verb '${sub}'. Run \`forge orchestrate --help\` for the list.`,
      false,
    );
    return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
  }
  // Nested verb (e.g., `run start`).
  if (entry instanceof Map) {
    const subSub = rest[1];
    if (!subSub || subSub === '--help' || subSub === '-h') {
      process.stdout.write(nestedUsage(sub, entry));
      return { exitCode: subSub ? 0 : 1 };
    }
    const handler = entry.get(subSub);
    if (!handler) {
      const envelope = fail(
        'UNKNOWN_VERB',
        `forge orchestrate ${sub}: unknown sub-verb '${subSub}'.`,
        false,
      );
      return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
    }
    const subArgs = rest.slice(2);
    if (wantsHelp(subArgs, handler.flags)) {
      // --help wins over --json execution; if --json present, emit the help envelope.
      process.stdout.write(renderVerbHelp(`${sub} ${subSub}`, handler, hasFlag(subArgs, 'json')));
      return { exitCode: 0 };
    }
    return handler.run(subArgs, opts);
  }
  const verbArgs = rest.slice(1);
  if (wantsHelp(verbArgs, entry.flags)) {
    // --help wins over --json execution (FORGE-134). With --json, return the
    // ok envelope { verb, band, synopsis, flags } via renderVerbHelp.
    process.stdout.write(renderVerbHelp(sub, entry, hasFlag(verbArgs, 'json')));
    return { exitCode: 0 };
  }
  return entry.run(verbArgs, opts);
}

function usage(): string {
  const lines: string[] = [
    'Usage: forge orchestrate <verb> [options]',
    '',
    'Verbs (read-only — no lease, no tracker mutation):',
  ];
  for (const name of HELP_ORDER) {
    const handler = VERBS.get(name);
    if (!handler) continue;
    if (handler instanceof Map) {
      lines.push(`  ${name} (sub-verbs: ${[...handler.keys()].join(', ')})`);
      continue;
    }
    if (handler.band === 'read') {
      lines.push(`  ${name.padEnd(12)} ${handler.synopsis}`);
    }
  }
  lines.push('', 'Verbs (mutating — require user-approval per call):');
  for (const name of HELP_ORDER) {
    const handler = VERBS.get(name);
    if (!handler || handler instanceof Map) continue;
    if (handler.band === 'mutate') {
      lines.push(`  ${name.padEnd(12)} ${handler.synopsis}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function nestedUsage(name: string, sub: Map<string, VerbHandler>): string {
  const lines: string[] = [
    `Usage: forge orchestrate ${name} <sub-verb> [options]`,
    '',
    'Sub-verbs:',
  ];
  for (const [subName, handler] of sub) {
    lines.push(`  ${subName.padEnd(10)} [${handler.band}] ${handler.synopsis}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
