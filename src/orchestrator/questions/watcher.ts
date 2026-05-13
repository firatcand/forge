import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Question } from '../../schemas/questions.ts';
import { QuestionChannelError, isNodeFsError } from './errors.ts';
import { readQuestion } from './reader.ts';

export interface QuestionWatcherEvent {
  readonly type: 'new_question';
  readonly questionId: string;
  readonly question: Question;
}

export interface QuestionWatcher {
  stop(): void;
}

export interface QuestionWatcherOptions {
  readonly forgeDir: string;
  readonly onEvent: (event: QuestionWatcherEvent) => void;
  readonly onError: (err: QuestionChannelError) => void;
  // Default 50ms — long enough to absorb FSEvents coalescing on macOS,
  // short enough to feel real-time. Tests can lower this to 5–10ms.
  readonly debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 50;

export function createQuestionWatcher(opts: QuestionWatcherOptions): QuestionWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const questionsDir = join(opts.forgeDir, 'questions');

  // Ensure the watch target exists. fs.watch on a missing directory throws
  // ENOENT; we'd rather create the dir and start watching cleanly.
  try {
    mkdirSync(questionsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Don't throw — surface via onError so the caller's bootstrap loop can
    // log and continue. A watcher that can't be created is still a valid
    // (no-op) handle; stop() is safe to call.
    opts.onError(
      new QuestionChannelError(
        'IO_ERROR',
        `Failed to create questions directory ${questionsDir}`,
        { path: questionsDir, cause: err },
      ),
    );
  }

  const pendingTimers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  let watcher: FSWatcher | null = null;

  function handleSettled(filename: string): void {
    if (stopped) return;
    pendingTimers.delete(filename);
    const questionId = filename.slice(0, -'.json'.length);
    let q: Question;
    try {
      q = readQuestion(questionId, { forgeDir: opts.forgeDir });
    } catch (err) {
      if (err instanceof QuestionChannelError) {
        // NOT_FOUND is benign here: a write can be observed mid-flight and
        // resolved before the read fires. fs.watch can also emit duplicate
        // events for the same file. Suppress to avoid noise. Surface other
        // codes so a corrupted/oversized payload is visible to operators.
        if (err.code !== 'NOT_FOUND') {
          opts.onError(err);
        }
        return;
      }
      opts.onError(
        new QuestionChannelError(
          'IO_ERROR',
          `Unexpected error reading question ${questionId}`,
          { cause: err },
        ),
      );
      return;
    }
    opts.onEvent({ type: 'new_question', questionId, question: q });
  }

  function scheduleRead(filename: string): void {
    const existing = pendingTimers.get(filename);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => handleSettled(filename), debounceMs);
    // Don't keep the event loop alive on the debounce timer.
    if (typeof timer.unref === 'function') timer.unref();
    pendingTimers.set(filename, timer);
  }

  try {
    watcher = watch(questionsDir, { persistent: false }, (_eventType, filename) => {
      if (stopped) return;
      if (!filename) return;
      const name = typeof filename === 'string' ? filename : String(filename);
      // Filter: only canonical .json files; suppress temp files written
      // mid-atomic-write. Writer uses `.{pid}.{counter}.{rand}.tmp` suffix.
      if (!name.endsWith('.json')) return;
      if (name.includes('.tmp')) return;
      scheduleRead(name);
    });
    watcher.on('error', (err) => {
      opts.onError(
        new QuestionChannelError('IO_ERROR', 'fs.watch error', { cause: err }),
      );
    });
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      opts.onError(
        new QuestionChannelError(
          'NOT_FOUND',
          `Questions directory does not exist: ${questionsDir}`,
          { path: questionsDir, cause: err },
        ),
      );
    } else {
      opts.onError(
        new QuestionChannelError('IO_ERROR', 'Failed to start fs.watch', {
          path: questionsDir,
          cause: err,
        }),
      );
    }
  }

  return {
    stop(): void {
      stopped = true;
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // close() can throw on already-closed handles on some platforms.
        }
        watcher = null;
      }
    },
  };
}
