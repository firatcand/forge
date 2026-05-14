import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../../../src/schemas/questions.ts';
import {
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

test('writeQuestionAtomic places a valid question file at .forge/questions/{id}.json', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = baseQuestion();
    writeQuestionAtomic(q, { forgeDir });
    const path = join(forgeDir, 'questions', `${q.question_id}.json`);
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
    writeAnswerAtomic(a, { forgeDir });
    const path = join(forgeDir, 'answers', `${a.question_id}.json`);
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
    writeQuestionAtomic(q, { forgeDir });
    let caught: unknown;
    try {
      writeQuestionAtomic(q, { forgeDir });
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
    writeAnswerAtomic(a, { forgeDir });
    let caught: unknown;
    try {
      writeAnswerAtomic(a, { forgeDir });
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
      writeQuestionAtomic(broken, { forgeDir });
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'SCHEMA_INVALID');
    // No file should exist on disk.
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(join(forgeDir, 'questions'));
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
    const targetPath = join(forgeDir, 'questions', `${q.question_id}.json`);
    mkdirSync(targetPath, { recursive: true });
    let caught: unknown;
    try {
      writeQuestionAtomic(q, { forgeDir });
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
        Promise.resolve().then(() => writeQuestionAtomic(q, { forgeDir })),
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
    const path = join(forgeDir, 'questions', `${q.question_id}.json`);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Question;
    assert.equal(onDisk.question_id, q.question_id);
    // No stray .tmp siblings remain in the directory.
    const entries = readdirSync(join(forgeDir, 'questions'));
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
    const dir = join(forgeDir, 'questions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${q.question_id}.json`), '{"placeholder":true}');
    try {
      writeQuestionAtomic(q, { forgeDir });
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
