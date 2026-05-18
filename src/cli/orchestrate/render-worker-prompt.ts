// `forge orchestrate render-worker-prompt` — render the worker prompt for a
// dispatched attempt. Read-only: gathers WorkerPromptContext from filesystem
// state (manifest + phases.yaml + CLAUDE.md + settings.yaml + attempt history)
// and returns the rendered prompt string in a JSON envelope.
//
// The dispatch skill calls this AFTER claim+dispatch, then injects the
// returned prompt into the host's Task tool when spawning the worker subagent.
//
// Sources per FORGE-98 plan §Renderer context sources:
//   - taskId, attemptId         ← CLI flags
//   - runId, worktreePath, phase ← attempts/<attempt>/manifest.json
//   - taskDescription, AC       ← plans/phases.yaml (matched by tracker_issue_id)
//   - conventions               ← CLAUDE.md (preferred) or AGENTS.md (fallback)
//   - host                      ← .forge/settings.yaml#primary_host_cli
//   - priorAttempts             ← walk attempts/* excluding current
//   - answeredQuestions         ← walk attempts/*/answers/*.json
//
// All sources are read-only — no state mutation. Errors surface specific codes
// so the skill can show actionable recovery hints.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  RenderWorkerPromptArgsSchema,
  type RenderWorkerPromptArgs,
} from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import {
  attemptsDir,
  manifestFilePath,
  answersDir,
  questionsDir,
} from '../../orchestrator/questions/paths.ts';
import {
  renderWorkerPrompt,
  type WorkerPromptContext,
  type WorkerHost,
  type PriorAttemptSummary,
  type AnsweredQuestionSummary,
} from '../../orchestrator/render-worker-prompt.ts';
import { loadPhases } from '../../core/phases.ts';
import type { VerbHandler } from './index.ts';

export interface RenderWorkerPromptResult {
  readonly exitCode: number;
}

interface ManifestShape {
  readonly version: number;
  readonly attempt_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly phase: 'implement' | 'review' | 'ship';
  readonly worktree_path: string;
}

function readManifest(forgeDir: string, taskId: string, attemptId: string): ManifestShape {
  const p = manifestFilePath(forgeDir, taskId, attemptId);
  if (!existsSync(p)) {
    throw new RenderError('ATTEMPT_NOT_FOUND', `attempt manifest not found at ${p}`);
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ManifestShape;
    if (
      typeof parsed.attempt_id !== 'string' ||
      typeof parsed.run_id !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.worktree_path !== 'string'
    ) {
      throw new RenderError('MANIFEST_INVALID', `manifest at ${p} missing required fields`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(
      'MANIFEST_INVALID',
      `failed to parse manifest at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

class RenderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

function findTaskInPhases(
  repoRoot: string,
  trackerIssueId: string,
): { description: string; acceptance: readonly string[] } {
  const phasesPath = path.join(repoRoot, 'plans', 'phases.yaml');
  if (!existsSync(phasesPath)) {
    throw new RenderError(
      'PHASES_NOT_FOUND',
      `plans/phases.yaml not found at ${phasesPath}; cannot source task description/acceptance — run /reconcile --pull first`,
    );
  }
  const { phases } = loadPhases(phasesPath);
  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      if (task.tracker_issue_id === trackerIssueId) {
        return { description: task.description, acceptance: task.acceptance };
      }
    }
  }
  throw new RenderError(
    'TASK_NOT_IN_PHASES',
    `task '${trackerIssueId}' not found in plans/phases.yaml — run /reconcile --pull first`,
  );
}

function readConventions(repoRoot: string): string {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    return readFileSync(claudePath, 'utf8');
  }
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, 'utf8');
  }
  return '';
}

function readHost(forgeDir: string): WorkerHost {
  // settings.yaml is shallow — parse just the field we need without pulling
  // the full SettingsSchema (avoids zod cost for a single key + lets us fall
  // back gracefully on partial settings during early adopter setup).
  const settingsPath = path.join(forgeDir, 'settings.yaml');
  if (!existsSync(settingsPath)) return 'claude';
  const raw = readFileSync(settingsPath, 'utf8');
  // Cheap line-scan: avoid taking a yaml dep just for one field.
  const match = raw.match(/^\s*primary_host_cli:\s*['"]?([a-z]+)['"]?/m);
  const value = match?.[1] ?? 'claude';
  return value === 'codex' ? 'codex' : 'claude';
}

function readPriorAttempts(
  forgeDir: string,
  taskId: string,
  currentAttemptId: string,
): PriorAttemptSummary[] {
  const root = attemptsDir(forgeDir, taskId);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const out: PriorAttemptSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentAttemptId) continue;
    const mPath = manifestFilePath(forgeDir, taskId, entry.name);
    if (!existsSync(mPath)) continue;
    try {
      const m = JSON.parse(readFileSync(mPath, 'utf8')) as { phase?: string };
      out.push({ attemptId: entry.name, status: m.phase ?? 'unknown' });
    } catch {
      // Skip unreadable manifests — non-fatal.
    }
  }
  // Stable order: by attempt_id (UUIDv7 sorts chronologically by prefix).
  out.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  return out;
}

function readAnsweredQuestions(
  forgeDir: string,
  taskId: string,
): AnsweredQuestionSummary[] {
  const attemptsRoot = attemptsDir(forgeDir, taskId);
  if (!existsSync(attemptsRoot)) return [];
  const out: AnsweredQuestionSummary[] = [];
  const attemptDirs = readdirSync(attemptsRoot, { withFileTypes: true });
  for (const entry of attemptDirs) {
    if (!entry.isDirectory()) continue;
    const ansDir = answersDir(forgeDir, taskId, entry.name);
    if (!existsSync(ansDir)) continue;
    const qDir = questionsDir(forgeDir, taskId, entry.name);
    const answers = readdirSync(ansDir, { withFileTypes: true });
    for (const a of answers) {
      if (!a.isFile() || !a.name.endsWith('.json')) continue;
      const qid = a.name.slice(0, -'.json'.length);
      let answerRecord: { option_id?: unknown } = {};
      try {
        answerRecord = JSON.parse(readFileSync(path.join(ansDir, a.name), 'utf8'));
      } catch {
        continue;
      }
      // Pair with the source question for the decision_key.
      let decisionKey = qid;
      const qPath = path.join(qDir, `${qid}.json`);
      if (existsSync(qPath)) {
        try {
          const qRecord = JSON.parse(readFileSync(qPath, 'utf8')) as { decision_key?: string };
          if (qRecord.decision_key) decisionKey = qRecord.decision_key;
        } catch {
          // fall through to qid as decision key
        }
      }
      out.push({
        decisionKey,
        answer: typeof answerRecord.option_id === 'string' ? answerRecord.option_id : 'unknown',
      });
    }
  }
  return out;
}

export async function runOrchestrateRenderWorkerPrompt(
  args: RenderWorkerPromptArgs,
): Promise<RenderWorkerPromptResult> {
  const parsed = RenderWorkerPromptArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : path.resolve(path.dirname(opts.forgeDir));

  try {
    const manifest = readManifest(opts.forgeDir, opts.taskId, opts.attemptId);
    const { description, acceptance } = findTaskInPhases(repoRoot, opts.taskId);
    const conventions = readConventions(repoRoot);
    const host = readHost(opts.forgeDir);
    const priorAttempts = readPriorAttempts(opts.forgeDir, opts.taskId, opts.attemptId);
    const answeredQuestions = readAnsweredQuestions(opts.forgeDir, opts.taskId);

    const templatePath = path.join(repoRoot, 'templates', 'worker-prompt.template.md');
    if (!existsSync(templatePath)) {
      throw new RenderError(
        'TEMPLATE_NOT_FOUND',
        `templates/worker-prompt.template.md not found at ${templatePath}`,
      );
    }
    const template = readFileSync(templatePath, 'utf8');

    const ctx: WorkerPromptContext = {
      taskId: opts.taskId,
      attemptId: opts.attemptId,
      runId: manifest.run_id,
      worktreePath: manifest.worktree_path,
      phase: manifest.phase.toUpperCase() as 'IMPLEMENT' | 'REVIEW' | 'SHIP',
      taskDescription: description,
      acceptanceCriteria: acceptance,
      conventions,
      host,
      priorAttempts,
      answeredQuestions,
    };

    const prompt = renderWorkerPrompt(template, ctx);
    return {
      exitCode: emit(
        ok({
          prompt,
          host,
          phase: ctx.phase,
          worktree_path: ctx.worktreePath,
          run_id: ctx.runId,
          task_id: ctx.taskId,
          attempt_id: ctx.attemptId,
        }),
        { json: opts.json },
      ),
    };
  } catch (err) {
    if (err instanceof RenderError) {
      return { exitCode: emit(fail(err.code, err.message, false), { json: opts.json }) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: emit(fail('RENDER_FAILED', message, false), { json: opts.json }) };
  }
}

export const renderWorkerPromptHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Render the worker prompt for a dispatched attempt (read-only).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const repoRoot = parseFlag(rest, 'repo-root');
    const json = hasFlag(rest, 'json');
    return runOrchestrateRenderWorkerPrompt({
      taskId,
      attemptId,
      forgeDir,
      json,
      ...(repoRoot ? { repoRoot } : {}),
    });
  },
};
