import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  isFatalEvent,
  isQuestionEvent,
  isQuestionResolvedEvent,
  tryParseEventLine,
  type NotificationEvent,
} from '../../orchestrator/events.ts';
import { isNodeFsError } from '../../orchestrator/questions/errors.ts';

export interface OrchestrateAttachOptions {
  readonly runId?: string;
  readonly forgeDir: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // When false (the test path), skip the fs.watch live-tail loop and return
  // after replaying historical lines. The CLI invokes with follow=true and
  // stays attached until SIGINT.
  readonly follow?: boolean;
  // Injectable liveness check for the dispatcher PID. Default uses
  // process.kill(pid, 0). Tests stub this for determinism.
  readonly isPidAlive?: (pid: number) => boolean;
  // Injectable signal abort for the follow loop. Tests pass a pre-aborted
  // signal so the watch loop exits immediately.
  readonly signal?: AbortSignal;
}

export interface OrchestrateAttachResult {
  readonly exitCode: number;
}

function pickLatestRun(orchestratorDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(orchestratorDir);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  const runs: string[] = [];
  for (const entry of entries) {
    try {
      if (statSync(join(orchestratorDir, entry)).isDirectory()) {
        runs.push(entry);
      }
    } catch {
      // skip vanished entries
    }
  }
  runs.sort();
  return runs.length === 0 ? null : (runs[runs.length - 1] ?? null);
}

function formatEvent(e: NotificationEvent): string {
  if (isQuestionEvent(e)) {
    return `[${e.ts}] question  ${e.task_id} ${e.question_id} attempt=${e.attempt} key=${e.decision_key}`;
  }
  if (isQuestionResolvedEvent(e)) {
    return `[${e.ts}] resolved  ${e.task_id} ${e.question_id} → ${e.resolution}${e.answer_option_id ? ` (option=${e.answer_option_id})` : ''}`;
  }
  if (isFatalEvent(e)) {
    return `[${e.ts}] FATAL     ${e.reason}`;
  }
  // FORGE-231 progress events (advisory).
  if (e.type === 'ready_for_review') {
    return `[${e.ts}] review    ${e.task_id} ready for review (v${e.state_version})`;
  }
  if (e.type === 'merge_pending') {
    return `[${e.ts}] merging   ${e.task_id} awaiting platform merge ${e.pr_url}${e.auto_merge ? ' (auto)' : ''}`;
  }
  if (e.type === 'shipped') {
    return `[${e.ts}] shipped   ${e.task_id} ${e.pr_url}`;
  }
  return `[unknown event type]`;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'EPERM') {
      // EPERM means the process exists but we can't signal it — still alive.
      return true;
    }
    return false;
  }
}

interface TailState {
  offset: number; // byte offset into the file we've already emitted
  buf: string; // partial trailing line carry-over
  // FORGE-231: bounded LRU of seen event ids. A crash-replayed producer can
  // legally append the same event twice (ids are deterministic natural keys);
  // the supervisor should see it once.
  seenIds: Set<string>;
}

const SEEN_IDS_MAX = 1_000;

function dedupSeen(state: TailState, id: string | undefined): boolean {
  if (id === undefined) return false; // legacy events have no id — never drop
  if (state.seenIds.has(id)) return true;
  state.seenIds.add(id);
  if (state.seenIds.size > SEEN_IDS_MAX) {
    // Drop the oldest entries (Set iteration order = insertion order).
    for (const old of state.seenIds) {
      state.seenIds.delete(old);
      if (state.seenIds.size <= SEEN_IDS_MAX) break;
    }
  }
  return false;
}

function tailNewBytes(
  path: string,
  state: TailState,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    if (isNodeFsError(e) && e.code === 'ENOENT') return;
    err.write(`[warn] stat ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  if (size <= state.offset) return;
  let chunk: string;
  try {
    // readFileSync of the whole file is fine here — notifications.jsonl
    // rolls at >100MB per ORCHESTRATOR.md and we're slicing after.
    const raw = readFileSync(path, 'utf8');
    chunk = raw.slice(state.offset);
    state.offset = Buffer.byteLength(raw, 'utf8');
  } catch (e) {
    err.write(`[warn] read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  const combined = state.buf + chunk;
  const lines = combined.split('\n');
  state.buf = lines.pop() ?? '';
  for (const line of lines) {
    const r = tryParseEventLine(line);
    if (!r.ok) {
      err.write(`[warn] corrupt line: ${r.error}\n`);
      continue;
    }
    if (r.event === null) continue;
    if (dedupSeen(state, r.event.id)) continue;
    out.write(formatEvent(r.event) + '\n');
  }
}

export function runOrchestrateAttach(
  opts: OrchestrateAttachOptions,
): OrchestrateAttachResult | Promise<OrchestrateAttachResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const orchestratorDir = join(opts.forgeDir, 'orchestrator');

  let runId = opts.runId;
  if (!runId) {
    try {
      const latest = pickLatestRun(orchestratorDir);
      if (!latest) {
        err.write(`forge orchestrate attach: no runs found in ${orchestratorDir}\n`);
        return { exitCode: 1 };
      }
      runId = latest;
    } catch (e) {
      err.write(
        `forge orchestrate attach: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return { exitCode: 1 };
    }
  }

  const runDir = join(orchestratorDir, runId);
  const jsonlPath = join(runDir, 'notifications.jsonl');
  const pidPath = join(runDir, 'pid');

  if (existsSync(pidPath)) {
    try {
      const pidRaw = readFileSync(pidPath, 'utf8').trim();
      const pid = Number.parseInt(pidRaw, 10);
      const aliveCheck = opts.isPidAlive ?? defaultIsPidAlive;
      if (Number.isFinite(pid) && pid > 0 && !aliveCheck(pid)) {
        err.write(
          `[warn] dispatcher process ${pid} is not running; showing historical log only.\n`,
        );
      }
    } catch {
      // best-effort; missing/unreadable pid file is non-fatal for attach
    }
  }

  if (!existsSync(jsonlPath)) {
    err.write(`forge orchestrate attach: ${jsonlPath} not found\n`);
    return { exitCode: 1 };
  }

  const state: TailState = { offset: 0, buf: '', seenIds: new Set() };
  tailNewBytes(jsonlPath, state, out, err);

  if (!opts.follow) {
    return { exitCode: 0 };
  }

  // Live tail loop. We use fs.watch on the jsonl file; each change event
  // triggers a slice from state.offset. The follow loop exits on:
  //   - SIGINT (the calling shell)  → exit 130
  //   - opts.signal abort (tests)   → exit 0
  return new Promise<OrchestrateAttachResult>((resolve) => {
    let resolved = false;
    const finish = (exitCode: number): void => {
      if (resolved) return;
      resolved = true;
      try {
        watcher.close();
      } catch {
        // already closed
      }
      process.off('SIGINT', onSigint);
      resolve({ exitCode });
    };
    const onSigint = (): void => finish(130);
    const onAbort = (): void => finish(0);
    process.on('SIGINT', onSigint);
    if (opts.signal) {
      if (opts.signal.aborted) {
        // The watcher hasn't been created yet — return without starting it.
        process.off('SIGINT', onSigint);
        resolve({ exitCode: 0 });
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const watcher = watch(jsonlPath, { persistent: false }, () => {
      tailNewBytes(jsonlPath, state, out, err);
    });
    watcher.on('error', (e) => {
      err.write(`[warn] watch error: ${e.message}\n`);
      finish(1);
    });
  });
}
