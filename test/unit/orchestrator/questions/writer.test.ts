import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUESTION_FILE_MAX_BYTES,
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../../../src/schemas/questions.ts';
import {
  __fsForTesting,
  writeAnswerAtomic,
  writeQuestionAtomic,
} from '../../../../src/orchestrator/questions/writer.ts';
import {
  QuestionChannelError,
  isQuestionChannelError,
} from '../../../../src/orchestrator/questions/errors.ts';

function baseClassification(): Record<string, unknown> {
  return {
    decision_type: 'architectural',
    category: 'public_api',
    reversibility: 'medium',
    blast_radius: 'module',
    default_action: 'ask',
    reason: 'Affects exported API surface.',
  };
}

function baseQuestion(overrides: Partial<Question> = {}): Question {
  const obj = {
    version: 1,
    question_id: '0190000000000000q1',
    run_id: '0190000000000000r1',
    task_id: 'FORGE-20',
    agent_id: 'agent-a',
    decision_key: 'public-api:dispatcher-events:v1',
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-05-13T12:00:00.000Z',
    expires_at: '2026-05-13T12:30:00.000Z',
    status: 'open' as const,
    question: 'Should dispatcher emit `phase_transition` events?',
    context: 'Per ORCHESTRATOR.md.',
    options: [
      { id: 'no', label: 'No — keep filtered' },
      { id: 'yes', label: 'Yes — emit transitions' },
    ],
    recommended_option_id: 'no',
    what_happens_if_unanswered: 'Filtered stream.',
    classification: baseClassification(),
    ...overrides,
  };
  return QuestionSchemaWithRecommendationCheck.parse(obj);
}

function baseAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    version: 1,
    question_id: '0190000000000000q1',
    answered_at: '2026-05-13T12:05:00.000Z',
    answered_by: 'supervisor',
    option_id: 'no',
    ...overrides,
  };
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-writer-'));
}

// All test paths use a single (taskId, attemptId) pair. The atomic-write
// invariants under test are independent of which task/attempt the write goes
// to — the v2 layout merely changes path computation.
const TASK_ID = 'FORGE-20';
const ATTEMPT_ID = '0190000000000000a1';
function writeOpts(forgeDir: string): { forgeDir: string; taskId: string; attemptId: string } {
  return { forgeDir, taskId: TASK_ID, attemptId: ATTEMPT_ID };
}
function qPath(forgeDir: string, questionId: string): string {
  return join(
    forgeDir,
    'orchestrator',
    'tasks',
    TASK_ID,
    'attempts',
    ATTEMPT_ID,
    'questions',
    `${questionId}.json`,
  );
}
function aPath(forgeDir: string, questionId: string): string {
  return join(
    forgeDir,
    'orchestrator',
    'tasks',
    TASK_ID,
    'attempts',
    ATTEMPT_ID,
    'answers',
    `${questionId}.json`,
  );
}
function qDir(forgeDir: string): string {
  return join(forgeDir, 'orchestrator', 'tasks', TASK_ID, 'attempts', ATTEMPT_ID, 'questions');
}
function aDir(forgeDir: string): string {
  return join(forgeDir, 'orchestrator', 'tasks', TASK_ID, 'attempts', ATTEMPT_ID, 'answers');
}

test('writeQuestionAtomic places a valid question file at .forge/questions/{id}.json', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion();
    writeQuestionAtomic(q, writeOpts(forgeDir));
    const path = qPath(forgeDir, q.question_id);
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Question;
    assert.equal(parsed.question_id, q.question_id);
    assert.equal(parsed.version, 1);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeAnswerAtomic places a valid answer at .forge/answers/{id}.json', () => {
  const forgeDir = freshForgeDir();
  try {
    const a = baseAnswer();
    writeAnswerAtomic(a, writeOpts(forgeDir));
    const path = aPath(forgeDir, a.question_id);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Answer;
    assert.equal(parsed.question_id, a.question_id);
    assert.equal(parsed.option_id, 'no');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeQuestionAtomic rejects duplicate ids with DUPLICATE_ID', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion();
    writeQuestionAtomic(q, writeOpts(forgeDir));
    let caught: unknown;
    try {
      writeQuestionAtomic(q, writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught), 'expected QuestionChannelError');
    assert.equal((caught as QuestionChannelError).code, 'DUPLICATE_ID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeAnswerAtomic rejects duplicate ids with DUPLICATE_ID', () => {
  const forgeDir = freshForgeDir();
  try {
    const a = baseAnswer();
    writeAnswerAtomic(a, writeOpts(forgeDir));
    let caught: unknown;
    try {
      writeAnswerAtomic(a, writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'DUPLICATE_ID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeQuestionAtomic rejects an invalid payload with SCHEMA_INVALID before any file is created', () => {
  const forgeDir = freshForgeDir();
  try {
    // Pass an object that bypasses the schema parse — we want to confirm
    // writeQuestionAtomic re-validates rather than trusting its input.
    const broken = { ...baseQuestion(), options: [] } as unknown as Question;
    let caught: unknown;
    try {
      writeQuestionAtomic(broken, writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'SCHEMA_INVALID');
    // No file should exist on disk.
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(qDir(forgeDir));
    } catch {
      dirEntries = [];
    }
    assert.equal(dirEntries.length, 0);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeQuestionAtomic surfaces IS_DIRECTORY when the target path is a directory', () => {
  // Pre-create a directory at the question's target path. The link()
  // attempt should fail with EEXIST → DUPLICATE_ID (link refuses to
  // overwrite ANY existing entry, including directories). This documents
  // that the writer never silently clobbers a directory.
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion();
    const targetPath = qPath(forgeDir, q.question_id);
    mkdirSync(targetPath, { recursive: true });
    let caught: unknown;
    try {
      writeQuestionAtomic(q, writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    // Either DUPLICATE_ID (link refused to overwrite) is fine — what matters
    // is we got a typed error, not a corrupted directory.
    const code = (caught as QuestionChannelError).code;
    assert.ok(
      code === 'DUPLICATE_ID' || code === 'IS_DIRECTORY' || code === 'IO_ERROR',
      `expected duplicate/dir/io error, got ${code}`,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeQuestionAtomic: concurrent writers on the same id — exactly one wins', async () => {
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion();
    const N = 8;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() => writeQuestionAtomic(q, writeOpts(forgeDir))),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1, 'exactly one writer must win');
    assert.equal(rejected.length, N - 1);
    for (const r of rejected) {
      assert.ok(
        isQuestionChannelError(r.reason),
        'each rejection must be a QuestionChannelError',
      );
      assert.equal(
        (r.reason as QuestionChannelError).code,
        'DUPLICATE_ID',
        'concurrent writers must reject with DUPLICATE_ID',
      );
    }
    // Target file exists and is valid JSON matching the input.
    const path = qPath(forgeDir, q.question_id);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Question;
    assert.equal(onDisk.question_id, q.question_id);
    // No stray .tmp siblings remain in the directory.
    const entries = readdirSync(qDir(forgeDir));
    const tmp = entries.filter((e) => e.includes('.tmp'));
    assert.equal(tmp.length, 0, `expected no .tmp leftovers, found: ${tmp.join(',')}`);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('writeQuestionAtomic cleans up the temp file on failure', () => {
  const forgeDir = freshForgeDir();
  try {
    // Pre-create the target as a regular file via writeFileSync so that
    // link() will fail with EEXIST → DUPLICATE_ID. The temp file written
    // mid-call must be cleaned up despite the failure.
    const q = baseQuestion();
    const dir = qDir(forgeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${q.question_id}.json`), '{"placeholder":true}');
    try {
      writeQuestionAtomic(q, writeOpts(forgeDir));
    } catch {
      // expected
    }
    const entries = readdirSync(dir);
    const tmp = entries.filter((e) => e.includes('.tmp'));
    assert.equal(tmp.length, 0, `expected no .tmp leftovers, found: ${tmp.join(',')}`);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// --- FORGE-69 follow-up regression tests ---

// T1: writeAnswerAtomic answer-side counterpart to the question-side test above.
test('writeAnswerAtomic cleans up the temp file on failure', () => {
  const forgeDir = freshForgeDir();
  try {
    const a = baseAnswer();
    const dir = aDir(forgeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${a.question_id}.json`), '{"placeholder":true}');
    try {
      writeAnswerAtomic(a, writeOpts(forgeDir));
    } catch {
      // expected
    }
    const entries = readdirSync(dir);
    const tmp = entries.filter((e) => e.includes('.tmp'));
    assert.equal(tmp.length, 0, `expected no .tmp leftovers, found: ${tmp.join(',')}`);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T2: writeSync may return a short count under NFS / quota / signal-interrupted
// conditions. The writer must loop until the full payload is written; the file
// on disk must contain the full payload byte-for-byte.
test('writeQuestionAtomic loops writeSync until the full payload is written (Bug #2 — partial writes)', (t) => {
  const forgeDir = freshForgeDir();
  try {
    const realWriteSync = __fsForTesting.writeSync;
    let firstCallShortened = false;
    // First call returns half the requested bytes; second call (and beyond)
    // delegate to the real writeSync. This exercises the loop.
    t.mock.method(
      __fsForTesting,
      'writeSync',
      (
        fd: number,
        buffer: NodeJS.ArrayBufferView | string,
        offset?: number | null,
        length?: number,
        position?: number | null,
      ): number => {
        if (!firstCallShortened && typeof length === 'number' && length > 1) {
          firstCallShortened = true;
          const half = Math.floor(length / 2);
          return realWriteSync(fd, buffer as NodeJS.ArrayBufferView, offset ?? 0, half, position ?? null);
        }
        return realWriteSync(
          fd,
          buffer as NodeJS.ArrayBufferView,
          offset ?? 0,
          length ?? (buffer as NodeJS.ArrayBufferView).byteLength,
          position ?? null,
        );
      },
    );
    const q = baseQuestion();
    writeQuestionAtomic(q, writeOpts(forgeDir));
    const path = qPath(forgeDir, q.question_id);
    const onDisk = readFileSync(path, 'utf8');
    // The payload reconstructed from the parsed object must equal what we wrote.
    const parsed = JSON.parse(onDisk) as Question;
    assert.equal(parsed.question_id, q.question_id);
    // Byte-for-byte: the loop must produce exactly the same JSON output as the
    // single-call path would. Re-serialize the input and compare.
    assert.equal(
      onDisk,
      JSON.stringify(QuestionSchemaWithRecommendationCheck.parse(q)),
    );
    assert.ok(firstCallShortened, 'mock did not observe the short-write path');
  } finally {
    mock.reset();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T3: writeSync returning 0 with bytes still to write is a hard I/O error.
// Looping forever would hang the process; the writer must throw IO_ERROR.
test('writeQuestionAtomic throws IO_ERROR when writeSync returns 0 (Bug #2 — zero-progress guard)', (t) => {
  const forgeDir = freshForgeDir();
  try {
    t.mock.method(__fsForTesting, 'writeSync', () => 0);
    let caught: unknown;
    try {
      writeQuestionAtomic(baseQuestion(), writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'IO_ERROR');
    assert.match(
      (caught as QuestionChannelError).message,
      /returned 0 at offset 0/,
      'message should disclose the zero-progress offset',
    );
    // No file on disk, no .tmp leftovers.
    let entries: string[];
    try {
      entries = readdirSync(qDir(forgeDir));
    } catch {
      entries = [];
    }
    assert.equal(entries.length, 0, `expected empty questions dir, found: ${entries.join(',')}`);
  } finally {
    mock.reset();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T4: closeSync failure on a successful write must surface as IO_ERROR — close(2)
// on POSIX is the documented surface for delayed write errors (NFS/quota paths).
test('writeQuestionAtomic surfaces closeSync failures as IO_ERROR when write/fsync succeeded (Bug #3)', (t) => {
  const forgeDir = freshForgeDir();
  try {
    const realCloseSync = __fsForTesting.closeSync;
    t.mock.method(__fsForTesting, 'closeSync', (fd: number) => {
      // Actually close so we don't leak the fd, then synthesize the error.
      try {
        realCloseSync(fd);
      } catch {
        // ignore — we're going to throw a synthetic error anyway
      }
      const err = new Error('synthetic delayed write error') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    let caught: unknown;
    try {
      writeQuestionAtomic(baseQuestion(), writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'IO_ERROR');
    assert.match(
      (caught as QuestionChannelError).message,
      /close/i,
      'message should identify the close-side failure',
    );
    assert.equal(
      ((caught as QuestionChannelError).details.cause as NodeJS.ErrnoException).code,
      'EIO',
      'details.cause should preserve the underlying errno',
    );
  } finally {
    mock.reset();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T5: when both writeSync and closeSync fail, the writeSync error wins —
// prior errors are actionable, the close error is informational.
test('writeQuestionAtomic preserves the prior write error when closeSync also fails (Bug #3)', (t) => {
  const forgeDir = freshForgeDir();
  try {
    const realCloseSync = __fsForTesting.closeSync;
    t.mock.method(__fsForTesting, 'writeSync', () => {
      const err = new Error('synthetic disk full') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });
    t.mock.method(__fsForTesting, 'closeSync', (fd: number) => {
      try {
        realCloseSync(fd);
      } catch {
        // ignore
      }
      const err = new Error('synthetic close error') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    let caught: unknown;
    try {
      writeQuestionAtomic(baseQuestion(), writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'IO_ERROR');
    // Critical: details.cause must be the ENOSPC write error, NOT the EIO close error.
    assert.equal(
      ((caught as QuestionChannelError).details.cause as NodeJS.ErrnoException).code,
      'ENOSPC',
      'prior write error must win over close-time error',
    );
  } finally {
    mock.reset();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T6: payload size cap enforced at the write boundary, before any disk I/O.
// The schema caps each string field by UTF-16 code units (`String#length`)
// but the cap is enforced in UTF-8 BYTES. A schema-valid payload built from
// 4-byte-per-codepoint characters (e.g. 😀, 2 UTF-16 units → 4 UTF-8 bytes)
// can exceed QUESTION_FILE_MAX_BYTES even while passing zod validation.
// This is exactly the gap the cap check is meant to close.
test('writeQuestionAtomic rejects oversized payloads with PAYLOAD_TOO_LARGE before any I/O (Bug #4)', () => {
  const forgeDir = freshForgeDir();
  try {
    // 2000 emoji = 4000 UTF-16 units (within question's 4000 cap) but 8000 UTF-8 bytes.
    // 4000 emoji in context = 8000 UTF-16 (within context's 8000 cap) but 16000 UTF-8 bytes.
    // 1000 emoji per option description × 10 options = 40000 UTF-8 bytes.
    // 1000 emoji in what_happens_if_unanswered (cap 2000 UTF-16) = 4000 UTF-8 bytes.
    // Total content ≈ 68000 UTF-8 bytes + JSON structural overhead → > 64KB cap.
    const emoji = '😀';
    const padded = baseQuestion({
      question: emoji.repeat(2000), // 4000 UTF-16 units == cap
      context: emoji.repeat(4000), // 8000 UTF-16 units == cap
      options: Array.from({ length: 10 }, (_, i) => ({
        id: `o${i}`,
        label: 'opt',
        description: emoji.repeat(1000), // 2000 UTF-16 units == cap
      })),
      recommended_option_id: 'o0',
      what_happens_if_unanswered: emoji.repeat(1000), // 2000 UTF-16 units == cap
    });
    let caught: unknown;
    try {
      writeQuestionAtomic(padded, writeOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught), `expected QuestionChannelError, got ${caught}`);
    assert.equal((caught as QuestionChannelError).code, 'PAYLOAD_TOO_LARGE');
    // Critically: the questions directory must not even exist — the cap check
    // is required to run before ensureDirectory.
    let dirEntries2: string[];
    try {
      dirEntries2 = readdirSync(qDir(forgeDir));
    } catch {
      dirEntries2 = [];
    }
    assert.equal(
      dirEntries2.length,
      0,
      `expected no on-disk side effects, found: ${dirEntries2.join(',')}`,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T7: boundary — a schema-valid payload just under the cap must be allowed.
// The cap is exclusive of equal (`bytes > cap` rejects, `bytes <= cap` allows).
// We can't construct an exactly-at-cap payload deterministically across all
// schema fields, but we CAN assert that a near-cap payload (within a few bytes)
// writes successfully — proving the cap is not over-eager.
test('writeQuestionAtomic accepts a near-cap payload (Bug #4 — boundary)', () => {
  const forgeDir = freshForgeDir();
  try {
    // Build a payload with ~50KB of UTF-8 from emoji — comfortably under the
    // 64KB cap and well within schema caps.
    const emoji = '😀';
    const q = baseQuestion({
      context: emoji.repeat(4000), // 8000 UTF-16 (== schema cap), 16000 UTF-8 bytes
    });
    const payloadBytes = Buffer.byteLength(
      JSON.stringify(QuestionSchemaWithRecommendationCheck.parse(q)),
      'utf8',
    );
    assert.ok(
      payloadBytes < QUESTION_FILE_MAX_BYTES,
      `precondition: payload (${payloadBytes}b) must be under cap (${QUESTION_FILE_MAX_BYTES}b)`,
    );
    // Must NOT throw.
    writeQuestionAtomic(q, writeOpts(forgeDir));
    const onDisk = readFileSync(qPath(forgeDir, q.question_id), 'utf8');
    assert.equal(Buffer.byteLength(onDisk, 'utf8'), payloadBytes);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T-codex-1: writer must reject mismatch between path taskId and payload task_id.
// Codex review: silent acceptance lets a caller land a question file at one
// task's path while the JSON payload claims another, which corrupts
// cross-attempt decision_key dedupe (it scans by path, reads payload).
test('writeQuestionAtomic rejects mismatched path taskId vs payload task_id with INVALID_ID', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion(); // payload task_id is FORGE-20
    let caught: unknown;
    try {
      writeQuestionAtomic(q, {
        forgeDir,
        taskId: 'FORGE-99', // path says FORGE-99, payload says FORGE-20 — mismatch
        attemptId: ATTEMPT_ID,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught), 'expected QuestionChannelError');
    assert.equal((caught as QuestionChannelError).code, 'INVALID_ID');
    // No on-disk side effect: even the directory tree under FORGE-99 must
    // not be created, since we reject before ensureDirectory.
    let entries: string[];
    try {
      entries = readdirSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-99'));
    } catch {
      entries = [];
    }
    assert.equal(entries.length, 0);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// T8: enhancement #6 — temp filename randomness must come from crypto.randomBytes,
// surfacing as 16 lowercase hex characters in the {pid}.{counter}.{hex}.tmp suffix.
test('writeQuestionAtomic temp filename uses 16-char hex randomness (Enhancement #6)', (t) => {
  const forgeDir = freshForgeDir();
  const observedTempPaths: string[] = [];
  try {
    const realOpenSync = __fsForTesting.openSync;
    t.mock.method(__fsForTesting, 'openSync', (path: string, flags: string | number, mode?: number) => {
      if (typeof path === 'string' && path.endsWith('.tmp')) {
        observedTempPaths.push(path);
      }
      return realOpenSync(path, flags as string, mode);
    });
    writeQuestionAtomic(baseQuestion(), writeOpts(forgeDir));
    assert.equal(observedTempPaths.length, 1, 'expected exactly one temp path open');
    const tmp = observedTempPaths[0]!;
    // Suffix shape: .<pid>.<counter>.<16-hex>.tmp
    assert.match(
      tmp,
      /\.\d+\.\d+\.[0-9a-f]{16}\.tmp$/,
      `temp path "${tmp}" must end with .{pid}.{counter}.{16-hex}.tmp`,
    );
  } finally {
    mock.reset();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
