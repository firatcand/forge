import {
  QuestionChannelError,
  findQuestionFile,
  readAnswer,
  readQuestion,
  writeAnswerAtomic,
} from '../orchestrator/questions/index.ts';
import { AnswerSchema } from '../schemas/questions.ts';

export interface OrchestrateAnswerOptions {
  readonly questionId: string;
  readonly optionId: string;
  readonly note?: string;
  readonly forgeDir: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injectable clock for deterministic tests.
  readonly now?: () => Date;
  readonly answeredBy?: string;
}

export interface OrchestrateAnswerResult {
  readonly exitCode: number;
}

export function runOrchestrateAnswer(
  opts: OrchestrateAnswerOptions,
): OrchestrateAnswerResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  if (!opts.questionId || !opts.optionId) {
    err.write(
      'Usage: forge orchestrate answer <question_id> --option <id> [--note <text>] [--forge-dir <path>]\n',
    );
    return { exitCode: 1 };
  }

  // v2 layout: questions live task-keyed under .forge/orchestrator/tasks/.../
  // attempts/.../questions/<id>.json, but the supervisor only knows the global
  // question id. Walk the task tree once to locate (taskId, attemptId), then
  // read/write strictly within that attempt directory. The walk is the
  // FORGE-73 fallback for spec/ORCHESTRATOR.md §"Answer lookup — global index"
  // until FORGE-20 ships .forge/orchestrator/index/questions.json as a fast
  // path. Both will coexist: index is best-effort, walk is canonical.
  let location;
  try {
    location = findQuestionFile(opts.questionId, { forgeDir: opts.forgeDir });
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  if (location === null) {
    err.write(
      `forge orchestrate answer: NOT_FOUND: question '${opts.questionId}' does not exist under ${opts.forgeDir}\n`,
    );
    return { exitCode: 1 };
  }

  const readOpts = {
    forgeDir: opts.forgeDir,
    taskId: location.taskId,
    attemptId: location.attemptId,
  };

  let q;
  try {
    q = readQuestion(opts.questionId, readOpts);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }

  const validOptionIds = q.options.map((o) => o.id);
  if (!validOptionIds.includes(opts.optionId)) {
    err.write(
      `forge orchestrate answer: invalid option '${opts.optionId}'. Valid: ${validOptionIds.join(', ')}\n`,
    );
    return { exitCode: 1 };
  }

  // Check whether an answer already exists. readAnswer throwing NOT_FOUND
  // is the expected happy path; any other code surfaces as an error.
  try {
    readAnswer(opts.questionId, readOpts);
    err.write(
      `forge orchestrate answer: question '${opts.questionId}' has already been answered.\n`,
    );
    return { exitCode: 1 };
  } catch (e) {
    if (e instanceof QuestionChannelError && e.code !== 'NOT_FOUND') {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    // NOT_FOUND or non-channel error → proceed (latter rethrown below)
    if (!(e instanceof QuestionChannelError)) throw e;
  }

  const now = opts.now ?? (() => new Date());
  const answeredBy = opts.answeredBy ?? 'supervisor';
  const answer = AnswerSchema.parse({
    version: 1,
    question_id: opts.questionId,
    answered_at: now().toISOString(),
    answered_by: answeredBy,
    option_id: opts.optionId,
    ...(opts.note ? { note: opts.note } : {}),
  });

  try {
    writeAnswerAtomic(answer, readOpts);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      if (e.code === 'DUPLICATE_ID') {
        err.write(
          `forge orchestrate answer: answer was written by a concurrent supervisor; refusing to overwrite.\n`,
        );
        return { exitCode: 1 };
      }
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  out.write(`Answered ${opts.questionId} with option ${opts.optionId}.\n`);
  return { exitCode: 0 };
}
