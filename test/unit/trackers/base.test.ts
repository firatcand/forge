import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseTracker,
  TrackerError,
  type Logger,
  type NormalizeErrorHint,
  type WithRetryOpts,
} from '../../../src/trackers/index.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueState,
  TrackerType,
} from '../../../src/trackers/index.ts';
import type { TrackerConfig } from '../../../src/schemas/settings.ts';

const githubConfig: TrackerConfig = {
  type: 'github',
  config: { repo: 'firatcand/forge' },
};

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Test subclass that exposes protected helpers; abstract methods are no-ops.
class TestTracker extends BaseTracker {
  readonly type: TrackerType = 'github';

  async listActiveIssues(): Promise<Issue[]> {
    return [];
  }
  async claim(_issueId: string, _runId: string): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(_issueId: string, _runId: string): Promise<void> {}
  async updateState(_issueId: string, _state: IssueState): Promise<void> {}
  async comment(_issueId: string, _body: string): Promise<void> {}
  async updateIssueBody(_issueId: string, _body: string): Promise<void> {}
  async createProject(
    _name: string,
    _description?: string,
  ): Promise<{ id: string; url: string }> {
    return { id: 'p', url: 'https://example.com' };
  }
  async createIssue(_p: CreateIssuePayload): Promise<Issue> {
    return {
      id: 'i',
      identifier: 'X-1',
      title: 't',
      state: 'todo',
      blockerIds: [],
    };
  }
  async setBlockedBy(_issueId: string, _blockerId: string): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  public callNormalizeError(
    op: string,
    err: unknown,
    hint?: NormalizeErrorHint,
  ): TrackerError {
    return this.normalizeError(op, err, hint);
  }
  public callRetryDelayMs(
    attempt: number,
    baseDelayMs?: number,
    maxDelayMs?: number,
  ): number {
    return this.retryDelayMs(attempt, baseDelayMs, maxDelayMs);
  }
  public callWithRetry<T>(
    op: string,
    fn: () => Promise<T>,
    opts?: WithRetryOpts,
  ): Promise<T> {
    return this.withRetry(op, fn, opts);
  }
  public callAssertNonEmpty(value: unknown, fieldName: string): string {
    this.assertNonEmpty(value, fieldName);
    return value;
  }
}

function makeTracker(): TestTracker {
  return new TestTracker(githubConfig, noopLogger());
}

const instantSleep = async (_ms: number): Promise<void> => {};

test('normalizeError AUTH from ExecaError-shaped object with hint', () => {
  const execaErr = new Error('Command failed: gh auth status');
  Object.assign(execaErr, { exitCode: 1, stderr: 'Bad credentials' });
  const t = makeTracker();
  const result = t.callNormalizeError('listActiveIssues', execaErr, {
    code: 'AUTH',
  });
  assert.ok(result instanceof TrackerError);
  assert.equal(result.code, 'AUTH');
  assert.equal(result.cause, execaErr);
  assert.match(result.message, /tracker\.listActiveIssues: AUTH/);
});

test('normalizeError HTTP 412 → PRECONDITION_FAILED', () => {
  const t = makeTracker();
  const err = { httpStatus: 412 };
  const result = t.callNormalizeError('updateState', err, {
    code: 'PRECONDITION_FAILED',
  });
  assert.equal(result.code, 'PRECONDITION_FAILED');
  assert.equal(result.details.httpStatus, 412);
  assert.equal(result.cause, err);
});

test('normalizeError HTTP 429 + Retry-After preserves retryAfterMs in details', () => {
  const t = makeTracker();
  const err = { httpStatus: 429 };
  const result = t.callNormalizeError('claim', err, {
    code: 'RATE_LIMITED',
    details: { retryAfterMs: 5000 },
  });
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.details.retryAfterMs, 5000);
  assert.equal(result.details.httpStatus, 429);
});

test('normalizeError preserves cause by reference equality', () => {
  const t = makeTracker();
  const origin = new Error('boom');
  const result = t.callNormalizeError('comment', origin, { code: 'TRANSPORT' });
  assert.equal(result.cause, origin);
});

test('normalizeError handles non-Error throwables without crashing', () => {
  const t = makeTracker();
  for (const value of ['string err', 42, null, undefined]) {
    const result = t.callNormalizeError('healthCheck', value);
    assert.equal(result.code, 'UNKNOWN');
    assert.equal(result.cause, value);
    assert.ok(result.message.includes('tracker.healthCheck: UNKNOWN'));
  }
});

test('retryDelayMs follows Symphony formula for attempts 1..5', () => {
  const t = makeTracker();
  const series = [1, 2, 3, 4, 5].map((a) => t.callRetryDelayMs(a));
  assert.deepEqual(series, [1000, 2000, 4000, 8000, 16000]);
});

test('retryDelayMs clamps at MAX_BACKOFF_MS (300_000)', () => {
  const t = makeTracker();
  assert.equal(t.callRetryDelayMs(20), 300_000);
  assert.equal(BaseTracker.MAX_BACKOFF_MS, 300_000);
});

test('withRetry retries on retriable codes and resolves after success', async () => {
  const t = makeTracker();
  let calls = 0;
  const fn = async (): Promise<string> => {
    calls++;
    if (calls < 3) {
      throw new TrackerError('RATE_LIMITED', 'rl');
    }
    return 'ok';
  };
  const result = await t.callWithRetry('claim', fn, { sleep: instantSleep });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry rethrows non-retriable errors after one call', async () => {
  const t = makeTracker();
  let calls = 0;
  const authErr = new TrackerError('AUTH', 'bad creds');
  const fn = async (): Promise<never> => {
    calls++;
    throw authErr;
  };
  await assert.rejects(
    () => t.callWithRetry('listActiveIssues', fn, { sleep: instantSleep }),
    (e: unknown) => e === authErr,
  );
  assert.equal(calls, 1);
});

test('withRetry respects max attempts and rejects with final error', async () => {
  const t = makeTracker();
  let calls = 0;
  const fn = async (): Promise<never> => {
    calls++;
    throw new TrackerError('RATE_LIMITED', `attempt ${calls}`);
  };
  await assert.rejects(
    () =>
      t.callWithRetry('claim', fn, {
        attempts: 3,
        sleep: instantSleep,
      }),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'RATE_LIMITED' &&
      e.message === 'attempt 3',
  );
  assert.equal(calls, 3);
});

test('assertNonEmpty rejects empty / whitespace / newline strings with VALIDATION', () => {
  const t = makeTracker();
  for (const bad of ['', '   ', '\n', '\t', '  \n  ']) {
    assert.throws(
      () => t.callAssertNonEmpty(bad, 'issueId'),
      (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
    );
  }
  assert.doesNotThrow(() => t.callAssertNonEmpty('FORGE-1', 'issueId'));
});
