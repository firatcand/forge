import { listOpenQuestionsAcrossTree } from '../../orchestrator/questions/index.ts';
import { QuestionChannelError } from '../../orchestrator/questions/errors.ts';
import { QuestionsArgsSchema } from '../../schemas/cli-args.ts';
import { fail, ok, type Envelope } from '../envelope.ts';

// Local emit replacement that honors the injected stdout stream (required by
// test fixtures using PassThrough). The shared `emit()` helper writes directly
// to process.stdout/stderr, which the test harnesses can't capture.
function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

export interface OrchestrateQuestionsOptions {
  readonly open: boolean;
  readonly forgeDir: string;
  readonly runId?: string;
  readonly json?: boolean;
  // Injectable streams so tests can capture output deterministically without
  // mocking console.* globally. Defaults to process.stdout / process.stderr.
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface OrchestrateQuestionsResult {
  readonly exitCode: number;
}

function letter(index: number): string {
  // A, B, C, … Z, AA, AB, … for >26 options (schema caps at 10 so this
  // is defensive only).
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function runOrchestrateQuestions(
  opts: OrchestrateQuestionsOptions,
): OrchestrateQuestionsResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const json = opts.json === true;

  // Validate inputs once at the entry. Schema rejects malformed runId
  // regardless of --open; the USAGE error only fires for the truly-missing
  // --open case. Text mode preserves the historical stderr "Usage:" line.
  const parsed = QuestionsArgsSchema.safeParse({
    open: opts.open,
    forgeDir: opts.forgeDir,
    json,
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
  if (!parsed.success) {
    if (json) {
      return {
        exitCode: writeEnvelope(fail('INVALID_ARGS', parsed.error.message, false), out),
      };
    }
    err.write(`forge orchestrate questions: ${parsed.error.message}\n`);
    return { exitCode: 1 };
  }

  if (!opts.open) {
    if (json) {
      return {
        exitCode: writeEnvelope(
          fail('USAGE', 'forge orchestrate questions requires --open', false),
          out,
        ),
      };
    }
    err.write(
      'Usage: forge orchestrate questions --open [--run <run_id>] [--json] [--forge-dir <path>]\n',
    );
    return { exitCode: 1 };
  }

  let questions;
  try {
    questions = listOpenQuestionsAcrossTree({
      forgeDir: opts.forgeDir,
      onSkip: (path, e) => {
        err.write(`[warn] skipping ${path}: ${e.code} ${e.message}\n`);
      },
    });
  } catch (e) {
    const msg =
      e instanceof QuestionChannelError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    if (json) {
      return { exitCode: writeEnvelope(fail('QUESTION_CHANNEL_ERROR', msg, false), out) };
    }
    err.write(`forge orchestrate questions: ${msg}\n`);
    return { exitCode: 1 };
  }

  // Run-scoped filter — Codex #9. Without this, /forge orchestrate would
  // surface and answer questions from sibling concurrent runs that share
  // the same .forge/orchestrator/ tree.
  const filtered = opts.runId
    ? questions.filter((q) => q.run_id === opts.runId)
    : questions;

  if (json) {
    return { exitCode: writeEnvelope(ok({ questions: filtered }), out) };
  }

  if (filtered.length === 0) {
    out.write('No open questions.\n');
    return { exitCode: 0 };
  }
  const blocks: string[] = [];
  for (const q of filtered) {
    const lines = [
      `[${q.question_id}] ${q.task_id} — ${q.decision_key}`,
      `Q: ${q.question}`,
    ];
    if (q.context) lines.push(`Context: ${q.context}`);
    lines.push('Options:');
    q.options.forEach((opt, idx) => {
      const label = opt.description
        ? `${opt.id}: ${opt.label} — ${opt.description}`
        : `${opt.id}: ${opt.label}`;
      lines.push(`  ${letter(idx)}) ${label}`);
    });
    if (q.recommended_option_id) {
      lines.push(`Recommended: ${q.recommended_option_id}`);
    }
    lines.push(`Created: ${q.created_at}   Expires: ${q.expires_at}`);
    blocks.push(lines.join('\n'));
  }
  out.write(blocks.join('\n\n') + '\n');
  return { exitCode: 0 };
}
