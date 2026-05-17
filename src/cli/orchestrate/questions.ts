import { listOpenQuestionsAcrossTree } from '../../orchestrator/questions/index.ts';
import { QuestionChannelError } from '../../orchestrator/questions/errors.ts';

export interface OrchestrateQuestionsOptions {
  readonly open: boolean;
  readonly forgeDir: string;
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
  if (!opts.open) {
    err.write(
      'Usage: forge orchestrate questions --open [--forge-dir <path>]\n',
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
    err.write(`forge orchestrate questions: ${msg}\n`);
    return { exitCode: 1 };
  }
  if (questions.length === 0) {
    out.write('No open questions.\n');
    return { exitCode: 0 };
  }
  const blocks: string[] = [];
  for (const q of questions) {
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
