import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { LinearTrackerConfig } from '../../../src/schemas/settings.ts';
import {
  LinearTracker,
  classifyLinearError,
  wrapLinearClient,
  TrackerError,
  parseForgeFooters,
  type LinearCreateIssueInput,
  type LinearCreateProjectInput,
  type LinearIssueLike,
  type LinearLabelLike,
  type LinearSdkLike,
  type LinearStateType,
  type LinearUpdateIssueInput,
  type LinearWorkflowStateLike,
  type Logger,
} from '../../../src/trackers/index.ts';
import { LINEAR_DESCRIPTION_MAX_BYTES } from '../../../src/trackers/linear.ts';
import { parseClaimFooter } from '../../../src/trackers/footers.ts';
import {
  DEFAULT_WORKFLOW_STATES,
  LABEL_STATE_IN_REVIEW,
  LABEL_STATE_BLOCKED,
  MockServerState,
  STATE_TODO,
  makeClaimLabel,
  makeIssue,
  makeLinearAuthError,
  makeLinearConflictError,
  makeLinearNotFoundError,
  makeLinearRateLimitError,
  makeLinearTimeoutError,
  makeLinearTransportError,
  makeLinearValidationError,
} from '../../fixtures/trackers/linear-responses.ts';
import { runTrackerConformance } from '../../fixtures/trackers/conformance.ts';

// ─── Test infra ──────────────────────────────────────────────────────────────

const linearConfig: LinearTrackerConfig = {
  type: 'linear',
  config: { team_id: 'team-uuid-test' },
};

function noopLogger(): Logger & { warnings: Array<{ event: string; fields?: unknown }> } {
  const warnings: Array<{ event: string; fields?: unknown }> = [];
  return {
    debug: () => {},
    info: () => {},
    warn: (event, fields) => {
      warnings.push({ event, fields });
    },
    error: () => {},
    warnings,
  };
}

// MockLinearSdk: programmable per-call. Caller passes a partial implementation
// in `overrides`; any unimplemented method throws so test surface is explicit.
// For race tests, attach a shared MockServerState in `state`.
interface MockOpts {
  overrides?: Partial<LinearSdkLike>;
  state?: MockServerState;
}

function makeMockSdk(opts: MockOpts = {}): LinearSdkLike & {
  calls: Array<{ method: keyof LinearSdkLike; args: unknown[] }>;
} {
  const calls: Array<{ method: keyof LinearSdkLike; args: unknown[] }> = [];
  const track = <K extends keyof LinearSdkLike>(method: K) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      const override = opts.overrides?.[method];
      if (override === undefined) {
        throw new Error(`MockLinearSdk: ${method} not configured`);
      }
      return (override as (...a: unknown[]) => unknown)(...args);
    };

  return {
    calls,
    viewer: track('viewer') as LinearSdkLike['viewer'],
    issue: track('issue') as LinearSdkLike['issue'],
    listIssues: track('listIssues') as LinearSdkLike['listIssues'],
    createIssue: track('createIssue') as LinearSdkLike['createIssue'],
    updateIssue: track('updateIssue') as LinearSdkLike['updateIssue'],
    createComment: track('createComment') as LinearSdkLike['createComment'],
    listWorkflowStates: track('listWorkflowStates') as LinearSdkLike['listWorkflowStates'],
    listIssueLabels: track('listIssueLabels') as LinearSdkLike['listIssueLabels'],
    createIssueLabel: track('createIssueLabel') as LinearSdkLike['createIssueLabel'],
    createProject: track('createProject') as LinearSdkLike['createProject'],
    createIssueRelation: track('createIssueRelation') as LinearSdkLike['createIssueRelation'],
    latestUpdatedAt: track('latestUpdatedAt') as LinearSdkLike['latestUpdatedAt'],
  };
}

function makeTracker(overrides: Partial<LinearSdkLike> = {}): {
  tracker: LinearTracker;
  client: ReturnType<typeof makeMockSdk>;
  logger: ReturnType<typeof noopLogger>;
} {
  const client = makeMockSdk({ overrides });
  const logger = noopLogger();
  const tracker = new LinearTracker(linearConfig, logger, {
    client,
    retry: { sleep: async () => {} },
  });
  return { tracker, client, logger };
}

function makeWrappedSdkIssue(
  labels: readonly LinearLabelLike[],
): {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: Promise<LinearWorkflowStateLike>;
  labels: () => Promise<{ nodes: readonly LinearLabelLike[] }>;
} {
  return {
    id: 'i1',
    identifier: 'FOR-1',
    title: 'Issue',
    description: null,
    url: 'https://linear.app/test/issue/FOR-1',
    state: Promise.resolve(STATE_TODO),
    labels: async () => ({ nodes: labels }),
  };
}

// ─── healthCheck — never throws ──────────────────────────────────────────────

await test('healthCheck — ok when viewer resolves', async () => {
  const { tracker } = makeTracker({
    viewer: async () => ({ id: 'user-1', email: 'me@example.com' }),
  });
  assert.deepEqual(await tracker.healthCheck(), { ok: true });
});

await test('healthCheck — !ok with synthesized AUTH detail (no raw provider message leak)', async () => {
  // healthCheck must NOT echo the raw provider error message for AUTH
  // failures — Linear's SDK could (rarely) include token fragments in its
  // AUTH error body, and the logger's redactor scans object keys, not
  // string values (security-auditor, FORGE-16).
  const { tracker } = makeTracker({
    viewer: async () => {
      throw makeLinearAuthError('Invalid API key lin_api_xyz_should_not_leak');
    },
  });
  const result = await tracker.healthCheck();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /LINEAR_API_KEY rejected/);
  // The synthetic message must not contain any fragment of the raw err.
  assert.doesNotMatch(result.detail ?? '', /lin_api_xyz/);
});

await test('healthCheck — !ok when LINEAR_API_KEY is missing (no injected client)', async () => {
  const prev = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    // No options.client → constructor defers to env on first call.
    const tracker = new LinearTracker(linearConfig, noopLogger());
    const result = await tracker.healthCheck();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /LINEAR_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.LINEAR_API_KEY = prev;
  }
});

await test('healthCheck — !ok with TRANSPORT detail on network error', async () => {
  const { tracker } = makeTracker({
    viewer: async () => {
      throw makeLinearTransportError();
    },
  });
  const result = await tracker.healthCheck();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /ECONNRESET/);
});

// ─── comment ─────────────────────────────────────────────────────────────────

await test('comment — happy path posts createComment with issueId + body', async () => {
  let captured: { issueId: string; body: string } | null = null;
  const { tracker, client } = makeTracker({
    createComment: async (input) => {
      captured = input;
    },
  });
  await tracker.comment('issue-1', 'hello world');
  assert.deepEqual(captured, { issueId: 'issue-1', body: 'hello world' });
  assert.equal(client.calls.length, 1);
});

await test('comment — rejects empty body via assertNonEmpty', async () => {
  const { tracker } = makeTracker({
    createComment: async () => {},
  });
  await assert.rejects(
    () => tracker.comment('issue-1', ''),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── releaseClaim — strict-scope, idempotent (FORGE-76) ──────────────────────
//
// Mirrors GitHubTracker (src/trackers/github.ts:451-490) and its tests at
// test/unit/trackers/github.test.ts:481-518. Removes only the caller's
// `forge:claimed-by:<runId>` label. No upfront issue read. Idempotent on
// missing label or vanished issue.

await test('releaseClaim — emits exactly one updateIssue call scoped to runId', async () => {
  // Strict-scope contract: releaseClaim('issue-1', 'me') issues exactly one
  // removeLabel call against `forge:claimed-by:me`, regardless of how many
  // other claim labels exist on the issue. No upfront client.issue() read.
  const myLabel = makeClaimLabel('me');
  const otherLabel = makeClaimLabel('other');
  let issueReads = 0;
  let removed: readonly string[] | undefined;
  const { tracker } = makeTracker({
    issue: async () => {
      issueReads++;
      return makeIssue({ id: 'issue-1', labels: [myLabel, otherLabel] });
    },
    listIssueLabels: async () => [myLabel, otherLabel],
    updateIssue: async (_id, input) => {
      removed = input.removedLabelIds;
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  assert.equal(issueReads, 0, 'strict-scope must not read the issue');
  assert.deepEqual([...(removed ?? [])], [myLabel.id]);
});

await test('releaseClaim — leaves other agents claim labels intact', async () => {
  // Codex 2nd-pass: explicit guard against accidental broad-clear regression.
  const myLabel = makeClaimLabel('me');
  const otherLabel = makeClaimLabel('other');
  let removed: readonly string[] | undefined;
  const { tracker } = makeTracker({
    listIssueLabels: async () => [myLabel, otherLabel],
    updateIssue: async (_id, input) => {
      removed = input.removedLabelIds;
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  const removedIds = [...(removed ?? [])];
  assert.ok(removedIds.includes(myLabel.id), 'should remove my label');
  assert.ok(!removedIds.includes(otherLabel.id), 'must NOT remove other label');
});

await test("releaseClaim — no-op when caller's label was never created on the team", async () => {
  // lookupExistingLabel returns null path. No updateIssue call at all.
  let updateCalled = false;
  const { tracker } = makeTracker({
    listIssueLabels: async () => [], // team has no labels matching our name
    updateIssue: async () => {
      updateCalled = true;
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  assert.equal(updateCalled, false);
});

await test('releaseClaim — tolerates updateIssue NOT_FOUND silently (issue vanished)', async () => {
  // Mirrors github.test.ts:511-518. Lookup returns label; updateIssue throws
  // NOT_FOUND because the issue was deleted between lookup and write.
  const myLabel = makeClaimLabel('me');
  const { tracker } = makeTracker({
    listIssueLabels: async () => [myLabel],
    updateIssue: async () => {
      throw makeLinearNotFoundError();
    },
  });
  await tracker.releaseClaim('issue-1', 'me'); // must not throw
});

await test('releaseClaim — stale cached label id triggers refresh+retry (Codex 2nd-pass)', async () => {
  // Linear-specific concern: cache may hold a stale label id if the label
  // was deleted+recreated out-of-band. Server rejects the stale id as
  // VALIDATION. We must evict, refresh once, and retry with the fresh id.
  const myLabelName = 'forge:claimed-by:me';
  const staleLabel = { id: 'label-stale-id', name: myLabelName };
  const freshLabel = { id: 'label-fresh-id', name: myLabelName };
  let listCallCount = 0;
  const removedIds: string[] = [];
  const { tracker } = makeTracker({
    listIssueLabels: async () => {
      listCallCount++;
      return listCallCount === 1 ? [staleLabel] : [freshLabel];
    },
    updateIssue: async (_id, input) => {
      const ids = [...(input.removedLabelIds ?? [])];
      removedIds.push(...ids);
      if (ids.includes(staleLabel.id)) {
        throw makeLinearValidationError('Unknown label id');
      }
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  assert.deepEqual(removedIds, [staleLabel.id, freshLabel.id]);
  assert.ok(listCallCount >= 2, 'cache should have been refreshed');
});

await test('releaseClaim — assertValidRunId rejects characters outside [A-Za-z0-9._-]', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.releaseClaim('issue-1', '!malicious'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('releaseClaim — transient listIssueLabels failure surfaces after retries exhausted [Codex 3rd-pass F1]', async () => {
  // Codex 3rd-pass Finding 1: wrapping the soft `lookupExistingLabel` (which
  // catches list failures and returns null) in withRetry does nothing —
  // null is a successful return, retry never fires, release silently
  // no-ops, claim label leaks. Strict variant must throw a CLASSIFIED
  // TrackerError so withRetry recognizes it as retriable and actually
  // retries; once retries exhaust, the caller must see the error.
  let listCalls = 0;
  const { tracker } = makeTracker({
    listIssueLabels: async () => {
      listCalls++;
      throw makeLinearTransportError();
    },
  });
  await assert.rejects(
    () => tracker.releaseClaim('issue-1', 'me'),
    (err: unknown) => err instanceof TrackerError && err.code === 'TRANSPORT',
  );
  // BaseTracker.withRetry default is 3 attempts. Proving retry actually
  // happened (>1) is the load-bearing assertion vs Codex 4th-pass F1
  // where the strict helper threw a raw error that withRetry didn't
  // recognize as retriable (only retried once).
  assert.ok(
    listCalls > 1,
    `listIssueLabels should have retried (got ${listCalls} calls; expected > 1)`,
  );
});

await test('releaseClaim — transient listIssueLabels failure retries then succeeds (proves retry path) [Codex 4th-pass F2]', async () => {
  // Stronger retry guard: fail once, succeed on retry. Asserts retry
  // actually completed the operation, not just "got more than one call".
  const myLabel = makeClaimLabel('me');
  let listCalls = 0;
  let removed: readonly string[] | undefined;
  const { tracker } = makeTracker({
    listIssueLabels: async () => {
      listCalls++;
      if (listCalls === 1) throw makeLinearTransportError();
      return [myLabel];
    },
    updateIssue: async (_id, input) => {
      removed = input.removedLabelIds;
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  assert.equal(listCalls, 2, 'should have retried exactly once');
  assert.deepEqual([...(removed ?? [])], [myLabel.id]);
});

await test('releaseClaim — VALIDATION retry: transient refresh failure surfaces after retries exhausted [Codex 3rd-pass F2]', async () => {
  // Codex 3rd-pass Finding 2: the VALIDATION recovery path also used the
  // soft lookup — a transient refresh failure was treated as "label gone"
  // and silently exited, leaking the (now-fresh) claim. Strict variant
  // must propagate the failure.
  const staleLabel = { id: 'label-stale', name: 'forge:claimed-by:me' };
  let listCalls = 0;
  const { tracker } = makeTracker({
    listIssueLabels: async () => {
      listCalls++;
      if (listCalls === 1) return [staleLabel]; // primes cache
      throw makeLinearTransportError(); // refresh fails transient
    },
    updateIssue: async () => {
      throw makeLinearValidationError('Unknown label id');
    },
  });
  await assert.rejects(
    () => tracker.releaseClaim('issue-1', 'me'),
    (err: unknown) => err instanceof TrackerError && err.code === 'TRANSPORT',
  );
  // First call primes the cache; subsequent calls are the refresh retry
  // attempts. With 3 default attempts, expect listCalls > 2 (1 prime + ≥2 retries).
  assert.ok(
    listCalls > 2,
    `refresh should have retried (got ${listCalls} calls; expected > 2)`,
  );
});

await test('releaseClaim — VALIDATION retry: transient refresh recovers on retry (proves retry path) [Codex 4th-pass F2]', async () => {
  // Stronger guard for the VALIDATION recovery path: refresh fails transient
  // once, returns fresh label on retry, release completes with fresh id.
  const staleLabel = { id: 'label-stale', name: 'forge:claimed-by:me' };
  const freshLabel = { id: 'label-fresh', name: 'forge:claimed-by:me' };
  let listCalls = 0;
  const removedIds: string[] = [];
  const { tracker } = makeTracker({
    listIssueLabels: async () => {
      listCalls++;
      // 1: prime cache with stale, 2: refresh fails transient,
      // 3: refresh succeeds with fresh
      if (listCalls === 1) return [staleLabel];
      if (listCalls === 2) throw makeLinearTransportError();
      return [freshLabel];
    },
    updateIssue: async (_id, input) => {
      const ids = [...(input.removedLabelIds ?? [])];
      removedIds.push(...ids);
      if (ids.includes(staleLabel.id)) {
        throw makeLinearValidationError('Unknown label id');
      }
      return makeIssue();
    },
  });
  await tracker.releaseClaim('issue-1', 'me');
  assert.deepEqual(removedIds, [staleLabel.id, freshLabel.id]);
  assert.equal(listCalls, 3, 'refresh should have retried once before succeeding');
});

await test('claim+releaseClaim — 36-char UUID runId (production-shaped input) [FORGE-82 learning]', async () => {
  // FORGE-82: GitHub's 50-char label cap broke production because tests used
  // short literals ('me', 'aaa') that masked the cap. Linear's label name cap
  // is much wider, so the 53-char production-shape label (17-char prefix +
  // 36-char UUID) fits, but this test holds the line: any future Linear-side
  // cap regression below 53 chars would surface here. crypto.randomUUID is
  // technically UUIDv4 (Node 25); UUIDv7 has the same 36-char shape and same
  // charset (the orchestrator's actual runId source — FORGE-20 — uses UUIDv7).
  const runId = randomUUID(); // 36 chars (8-4-4-4-12), UUIDv4 shape
  const labelName = `forge:claimed-by:${runId}`; // 17 + 36 = 53 chars
  assert.equal(labelName.length, 53, 'production-shape sanity check');

  const seed = makeIssue({ id: 'i1', labels: [] });
  const server = new MockServerState([seed]);
  const sdk: LinearSdkLike = {
    viewer: async () => ({ id: 'u', email: 'u@x' }),
    issue: async (id) => server.getIssue(id),
    listIssues: async () => server.listIssues(),
    latestUpdatedAt: async () => '2026-01-01T00:00:00.000Z',
    createIssue: async () => makeIssue(),
    updateIssue: async (id, input) => {
      if (input.addedLabelIds) {
        for (const lid of input.addedLabelIds) {
          const l = server.labelById(lid);
          if (l) server.addLabel(id, l.name);
        }
      }
      if (input.removedLabelIds) {
        for (const lid of input.removedLabelIds) server.removeLabel(id, lid);
      }
      return server.getIssue(id);
    },
    createComment: async () => {},
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => server.allLabels(),
    createIssueLabel: async ({ name }) => server.ensureLabel(name),
    createProject: async () => ({ id: 'p', url: 'u' }),
    createIssueRelation: async () => {},
  };
  const tracker = new LinearTracker(linearConfig, noopLogger(), {
    client: sdk,
    retry: { sleep: async () => {} },
  });
  assert.deepEqual(await tracker.claim('i1', runId), { ok: true });
  const labelsAfterClaim = server.getIssue('i1').labels.map((l) => l.name);
  assert.ok(
    labelsAfterClaim.includes(labelName),
    `claim label should be present (UUIDv7-shape: ${labelName})`,
  );
  await tracker.releaseClaim('i1', runId);
  const labelsAfterRelease = server.getIssue('i1').labels.map((l) => l.name);
  assert.ok(
    !labelsAfterRelease.includes(labelName),
    'claim label removed after release',
  );
});

// ─── classifyLinearError — branch coverage in classification order ───────────

await test('classifyLinearError — AUTH on 401 / AuthenticationError type', () => {
  const hint = classifyLinearError(makeLinearAuthError());
  assert.equal(hint.code, 'AUTH');
});

await test('classifyLinearError — RATE_LIMITED on 429 + retry-after parsed', () => {
  const hint = classifyLinearError(makeLinearRateLimitError(30));
  assert.equal(hint.code, 'RATE_LIMITED');
  assert.equal(hint.details?.retryAfterMs, 30_000);
});

await test('classifyLinearError — NOT_FOUND on 404', () => {
  const hint = classifyLinearError(makeLinearNotFoundError());
  assert.equal(hint.code, 'NOT_FOUND');
});

await test('classifyLinearError — preserves normalized TrackerError code', () => {
  const err = new TrackerError('NOT_FOUND', 'provider hid the issue');
  const hint = classifyLinearError(err);
  assert.equal(hint.code, 'NOT_FOUND');
});

await test('classifyLinearError — VALIDATION on 422', () => {
  const hint = classifyLinearError(makeLinearValidationError());
  assert.equal(hint.code, 'VALIDATION');
});

await test('classifyLinearError — VALIDATION beats CONFLICT when both keywords appear', () => {
  // 422 body containing "already exists" must still classify as VALIDATION
  // (the order learning carried from classifyGitHubError).
  const err = makeLinearValidationError('Validation failed: name already exists');
  assert.equal(classifyLinearError(err).code, 'VALIDATION');
});

await test('classifyLinearError — CONFLICT on 409 without validation context', () => {
  const hint = classifyLinearError(makeLinearConflictError());
  assert.equal(hint.code, 'CONFLICT');
});

await test('classifyLinearError — TIMEOUT on ETIMEDOUT', () => {
  const hint = classifyLinearError(makeLinearTimeoutError());
  assert.equal(hint.code, 'TIMEOUT');
});

await test('classifyLinearError — TRANSPORT on 5xx / ECONNRESET', () => {
  const hint = classifyLinearError(makeLinearTransportError());
  assert.equal(hint.code, 'TRANSPORT');
});

await test('classifyLinearError — UNKNOWN fallback', () => {
  const hint = classifyLinearError(new Error('something unexpected'));
  assert.equal(hint.code, 'UNKNOWN');
});

// ─── claim — load-bearing atomic primitive ───────────────────────────────────
//
// Twelve coverage points per plan §7.1, plus the explicit race test for AC
// bullet 2. The race test uses MockServerState as a shared atomic store so
// two trackers truly observe each other's writes.

await test('claim — happy path: no prior claim → ok', async () => {
  const issue = makeIssue({ id: 'i1', labels: [] });
  let stage = 'pre';
  const { tracker } = makeTracker({
    issue: async () => {
      // Initial read returns no claims; post-add read returns my label only.
      const labels = stage === 'post' ? [makeClaimLabel('me')] : [];
      return { ...issue, labels };
    },
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      stage = 'post';
      return issue;
    },
  });
  assert.deepEqual(await tracker.claim('i1', 'me'), { ok: true });
});

await test('claim — idempotent when only my claim exists', async () => {
  const myLabel = makeClaimLabel('me');
  const issue = makeIssue({ id: 'i1', labels: [myLabel] });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  assert.deepEqual(await tracker.claim('i1', 'me'), { ok: true });
});

await test('claim — already_claimed when another agent holds the claim', async () => {
  const otherLabel = makeClaimLabel('other');
  const issue = makeIssue({ id: 'i1', labels: [otherLabel] });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'already_claimed');
});

await test('claim — initial read NOT_FOUND → version_conflict', async () => {
  const { tracker } = makeTracker({
    issue: async () => {
      throw makeLinearNotFoundError();
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /initial-read/);
  }
});

await test('claim — initial read transient → transient_error', async () => {
  const { tracker } = makeTracker({
    issue: async () => {
      throw makeLinearTransportError();
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'transient_error');
});

await test('claim — wrapped initial read transient retries then succeeds', async () => {
  const myLabel = makeClaimLabel('me');
  let issueCalls = 0;
  let added = false;
  const rawClient = {
    async issue() {
      issueCalls++;
      if (issueCalls === 1) throw makeLinearTransportError();
      return makeWrappedSdkIssue(added ? [myLabel] : []);
    },
    async issueLabels() {
      return { nodes: [] };
    },
    async createIssueLabel({ name }: { name: string }) {
      return {
        success: true,
        issueLabel: Promise.resolve({ id: `label-${name}`, name }),
      };
    },
    async updateIssue() {
      added = true;
      return {
        success: true,
        issue: Promise.resolve(makeWrappedSdkIssue([myLabel])),
      };
    },
  };
  const tracker = new LinearTracker(linearConfig, noopLogger(), {
    client: wrapLinearClient(rawClient as unknown as import('@linear/sdk').LinearClient),
    retry: { sleep: async () => {} },
  });
  assert.deepEqual(await tracker.claim('i1', 'me'), { ok: true });
  assert.ok(issueCalls > 1, `claim.read should retry (got ${issueCalls} issue calls)`);
});

await test('claim — addLabel NOT_FOUND → version_conflict', async () => {
  const issue = makeIssue({ id: 'i1', labels: [] });
  const { tracker } = makeTracker({
    issue: async () => issue,
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      throw makeLinearNotFoundError();
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'version_conflict');
});

await test('claim — addLabel transient → transient_error', async () => {
  const issue = makeIssue({ id: 'i1', labels: [] });
  const { tracker } = makeTracker({
    issue: async () => issue,
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      throw makeLinearRateLimitError();
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'transient_error');
});

await test('claim — recheck NOT_FOUND → version_conflict (label released)', async () => {
  const issue = makeIssue({ id: 'i1', labels: [] });
  let stage = 'pre';
  let removedDuringCleanup: readonly string[] | undefined;
  const { tracker } = makeTracker({
    issue: async () => {
      if (stage === 'post') throw makeLinearNotFoundError();
      return issue;
    },
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async (_id, input) => {
      if (stage === 'pre') {
        stage = 'post';
        return issue;
      }
      removedDuringCleanup = input.removedLabelIds;
      return issue;
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /recheck/);
  }
  assert.deepEqual([...(removedDuringCleanup ?? [])], ['label-forge:claimed-by:me']);
});

await test('claim — recheck transient → transient_error (label release attempted)', async () => {
  const issue = makeIssue({ id: 'i1', labels: [] });
  let calls = 0;
  const { tracker } = makeTracker({
    issue: async () => {
      calls++;
      if (calls === 1) return issue;
      throw makeLinearTransportError();
    },
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => issue,
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'transient_error');
});

await test('claim — wrapped recheck transient retries then succeeds', async () => {
  const myLabel = makeClaimLabel('me');
  let issueCalls = 0;
  let added = false;
  const rawClient = {
    async issue() {
      issueCalls++;
      if (issueCalls === 1) return makeWrappedSdkIssue([]);
      if (issueCalls === 2) throw makeLinearTransportError();
      return makeWrappedSdkIssue(added ? [myLabel] : []);
    },
    async issueLabels() {
      return { nodes: [] };
    },
    async createIssueLabel({ name }: { name: string }) {
      return {
        success: true,
        issueLabel: Promise.resolve({ id: `label-${name}`, name }),
      };
    },
    async updateIssue() {
      added = true;
      return {
        success: true,
        issue: Promise.resolve(makeWrappedSdkIssue([myLabel])),
      };
    },
  };
  const tracker = new LinearTracker(linearConfig, noopLogger(), {
    client: wrapLinearClient(rawClient as unknown as import('@linear/sdk').LinearClient),
    retry: { sleep: async () => {} },
  });
  assert.deepEqual(await tracker.claim('i1', 'me'), { ok: true });
  assert.equal(issueCalls, 3, 'initial read plus retried recheck should call issue 3 times');
});

await test('claim — tiebreak: I win when my label is lexicographic first', async () => {
  const myLabel = makeClaimLabel('aaa-me');
  const otherLabel = makeClaimLabel('bbb-other');
  const issue = makeIssue({ id: 'i1', labels: [myLabel, otherLabel] });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  assert.deepEqual(await tracker.claim('i1', 'aaa-me'), { ok: true });
});

await test('claim — tiebreak: I lose when other label is first → version_conflict + my label removed', async () => {
  // Pre-write tiebreak loss path: initial-read sees both my label and the
  // other agent's label, and my label loses lex tiebreak. The implementation
  // must call tryRemoveLabelByName → lookupExistingLabel → list, find, and
  // remove my label. Code-reviewer flagged that the prior version of this
  // test used `void removed` to suppress an assertion that didn't fire
  // because tryRemoveLabelByName was reading the raw (cold) cache instead
  // of doing a list-refresh. After the lookupExistingLabel fix, removal
  // genuinely happens — assert it (FORGE-16).
  const myLabel = makeClaimLabel('zzz-me');
  const otherLabel = makeClaimLabel('aaa-other');
  const issue = makeIssue({ id: 'i1', labels: [myLabel, otherLabel] });
  let removed: readonly string[] | undefined;
  const { tracker } = makeTracker({
    issue: async () => issue,
    listIssueLabels: async () => [myLabel, otherLabel],
    updateIssue: async (_id, input) => {
      removed = input.removedLabelIds;
      return issue;
    },
  });
  const result = await tracker.claim('i1', 'zzz-me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /lost-tiebreak-to:/);
  }
  // After the lookupExistingLabel fix, tryRemoveLabelByName lists team
  // labels on cache miss, finds myLabel, and queues its id for removal.
  assert.deepEqual(
    [...(removed ?? [])],
    [myLabel.id],
    'my claim label should be removed after tiebreak loss',
  );
});

await test('claim — assertValidRunId rejects characters outside [A-Za-z0-9._-]', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.claim('i1', '!malicious-prefix-wins-tiebreak'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('claim — assertValidRunId rejects >80 chars', async () => {
  const { tracker } = makeTracker({});
  const longId = 'a'.repeat(81);
  await assert.rejects(
    () => tracker.claim('i1', longId),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('claim — assertNonEmpty rejects empty issueId', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.claim('', 'me'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('claim — assertNonEmpty rejects empty runId', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.claim('i1', ''),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── verify-on-readback contract (FORGE-76 fix) ──────────────────────────────
//
// Pre-fix: `if (allClaims.length <= 1) return { ok: true }` returned ok even
// when our label was absent (false-positive). Post-fix: require myLabel
// presence; otherwise return version_conflict 'claim-label-missing-on-recheck'.
// Mirrors github.test.ts:419-462. The third test (happy-path-reread) is the
// Codex 2nd-pass guard that would catch a `.includes(myLabel)`-instead-of-
// `.some(l => l.name === myLabelName)` regression.

await test('claim — reread shows our label present → returns ok (Codex 2nd-pass guard)', async () => {
  // If the verify-on-readback uses `.includes(myLabel)` on an object array,
  // every successful claim returns version_conflict. This test catches that.
  const myLabel = makeClaimLabel('me');
  const initial = makeIssue({ id: 'i1', labels: [] });
  const post = makeIssue({ id: 'i1', labels: [myLabel] });
  let stage = 'pre';
  const { tracker } = makeTracker({
    issue: async () => (stage === 'post' ? post : initial),
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      stage = 'post';
      return post;
    },
  });
  assert.deepEqual(await tracker.claim('i1', 'me'), { ok: true });
});

await test('claim — reread shows our label MISSING → version_conflict (claim-label-missing-on-recheck)', async () => {
  // Our --add-label "succeeded" but the reread returns ZERO claim labels.
  // Pre-fix bug: returned ok:true (allClaims.length <= 1). Post-fix: returns
  // version_conflict because the contract requires our label present.
  const issue = makeIssue({ id: 'i1', labels: [] });
  let stage = 'pre';
  const { tracker } = makeTracker({
    issue: async () => issue, // reread returns same empty-label issue
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      stage = 'post';
      return issue;
    },
  });
  const result = await tracker.claim('i1', 'me');
  // Touch `stage` so the lint catch doesn't flag the var (state used for setup).
  void stage;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /claim-label-missing-on-recheck/);
  }
});

await test("claim — reread shows only OTHER agent's label → version_conflict (not false-positive ok)", async () => {
  // Pre-fix bug: returned ok:true because allClaims.length === 1. Post-fix
  // requires our label IN the set. Spec AC: "verify (a) our label is present
  // AND (b) no other forge:claimed-by:* label is present".
  const otherLabel = makeClaimLabel('other');
  const initial = makeIssue({ id: 'i1', labels: [] });
  const post = makeIssue({ id: 'i1', labels: [otherLabel] });
  let stage = 'pre';
  const { tracker } = makeTracker({
    issue: async () => (stage === 'post' ? post : initial),
    listIssueLabels: async () => [otherLabel],
    createIssueLabel: async ({ name }) => ({ id: `label-${name}`, name }),
    updateIssue: async () => {
      stage = 'post';
      return post;
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /claim-label-missing-on-recheck/);
  }
});

// ─── claim atomicity under concurrent agents (AC bullet 2) ───────────────────
//
// Runs the same two-agent race 20× via Promise.all to catch ordering flakes.
// Uses MockServerState as a shared deterministic store so both trackers see
// each other's label writes.

await test('claim is atomic when two orchestrators race (20× repeat)', async () => {
  for (let iter = 0; iter < 20; iter++) {
    const issue = makeIssue({ id: 'i1', labels: [] });
    const server = new MockServerState([issue]);

    const sharedSdk: LinearSdkLike = {
      viewer: async () => ({ id: 'u', email: 'u@x' }),
      issue: async (id) => server.getIssue(id),
      listIssues: async () => server.listIssues(),
      latestUpdatedAt: async () => '2026-01-01T00:00:00.000Z',
      createIssue: async () => makeIssue(),
      updateIssue: async (id, input) => {
        if (input.addedLabelIds) {
          for (const lid of input.addedLabelIds) {
            const label = server.labelById(lid);
            if (label) server.addLabel(id, label.name);
          }
        }
        if (input.removedLabelIds) {
          for (const lid of input.removedLabelIds) server.removeLabel(id, lid);
        }
        return server.getIssue(id);
      },
      createComment: async () => {},
      listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
      listIssueLabels: async () => server.allLabels(),
      createIssueLabel: async ({ name }) => server.ensureLabel(name),
      createProject: async () => ({ id: 'p', url: 'u' }),
      createIssueRelation: async () => {},
    };
    const trackerA = new LinearTracker(linearConfig, noopLogger(), {
      client: sharedSdk,
      retry: { sleep: async () => {} },
    });
    const trackerB = new LinearTracker(linearConfig, noopLogger(), {
      client: sharedSdk,
      retry: { sleep: async () => {} },
    });

    const [a, b] = await Promise.all([
      trackerA.claim('i1', 'agent-a'),
      trackerB.claim('i1', 'agent-b'),
    ]);

    // Exactly one winner.
    const okCount = (a.ok ? 1 : 0) + (b.ok ? 1 : 0);
    assert.equal(okCount, 1, `iter ${iter}: expected exactly one winner, got ${okCount}`);

    // The loser is either already_claimed (saw the winner's label on initial
    // read) or version_conflict via tiebreak (both wrote, then re-read).
    const loser = a.ok ? b : a;
    if (!loser.ok) {
      assert.match(
        loser.reason,
        /already_claimed|version_conflict/,
        `iter ${iter}: loser had unexpected reason ${loser.reason}`,
      );
    }

    // Final server state must have exactly one claim label.
    const final = server.getIssue('i1');
    const finalClaims = final.labels.filter((l) =>
      l.name.startsWith('forge:claimed-by:'),
    );
    assert.equal(
      finalClaims.length,
      1,
      `iter ${iter}: expected 1 final claim label, got ${finalClaims.length}: ${finalClaims
        .map((l) => l.name)
        .join(',')}`,
    );
  }
});

// ─── listActiveIssues ────────────────────────────────────────────────────────

await test('listActiveIssues — filters by team + active state types, maps issues', async () => {
  const issueA = makeIssue({
    id: 'a',
    identifier: 'FORGE-1',
    title: 'one',
    description: '<!-- forge:task=P0-T01 -->\n<!-- forge:blockedBy=b -->',
    labels: [LABEL_STATE_IN_REVIEW],
  });
  const issueB = makeIssue({ id: 'b', identifier: 'FORGE-2', title: 'two' });
  let capturedFilter:
    | { teamId: string; stateTypes: readonly string[] | undefined }
    | null = null;
  const { tracker } = makeTracker({
    listIssues: async (opts) => {
      capturedFilter = { teamId: opts.teamId, stateTypes: opts.stateTypes };
      return [issueA, issueB];
    },
  });
  const result = await tracker.listActiveIssues();
  assert.equal(result.length, 2);
  assert.equal(result[0]!.identifier, 'FORGE-1');
  assert.equal(result[0]!.state, 'in_review'); // overlay label wins
  assert.equal(result[0]!.forgeTaskId, 'P0-T01');
  assert.deepEqual(result[0]!.blockerIds, ['b']);
  assert.equal(capturedFilter!.teamId, 'team-uuid-test');
  assert.ok(capturedFilter!.stateTypes, 'listActiveIssues must pass a stateTypes filter');
  assert.deepEqual(
    [...capturedFilter!.stateTypes!].sort(),
    ['backlog', 'started', 'triage', 'unstarted'],
  );
});

await test('listAllIssues — passes NO stateTypes filter and includes duplicate-state issues', async () => {
  // Regression for FORGE-165 Bug 2: enumerating state types silently dropped
  // tasks bound to issues in states outside the list (e.g. Linear "Duplicate"),
  // falsely orphaning them. listAllIssues must omit the filter entirely.
  const active = makeIssue({ id: 'a', identifier: 'FORGE-1', title: 'one' });
  const dup = makeIssue({
    id: 'd',
    identifier: 'FORGE-20',
    title: 'dupe',
    state: { id: 'st-dup', name: 'Duplicate', type: 'duplicate' },
  });
  let capturedStateTypes: unknown = 'UNSET';
  const { tracker } = makeTracker({
    listIssues: async (opts) => {
      capturedStateTypes = opts.stateTypes;
      return [active, dup];
    },
  });
  const result = await tracker.listAllIssues();
  assert.equal(capturedStateTypes, undefined, 'listAllIssues must not constrain state types');
  assert.equal(result.truncated, false);
  assert.equal(result.issues.length, 2);
  const dupIssue = result.issues.find((i) => i.identifier === 'FORGE-20');
  assert.ok(dupIssue, 'duplicate-state issue must be returned (no false orphan)');
  assert.equal(dupIssue!.state, 'cancelled', 'Duplicate maps to a terminal IssueState');
});

await test('listAllIssues — flags truncated=true when the page limit is hit', async () => {
  // Regression for FORGE-165 Bug 2 / Codex 2nd-pass block: a truncated view
  // must signal incompleteness so reconcile --pull fails closed (no prune).
  const many: LinearIssueLike[] = Array.from({ length: 200 }, (_, i) =>
    makeIssue({ id: `i${i}`, identifier: `FORGE-${i}` }),
  );
  const { tracker } = makeTracker({ listIssues: async () => many });
  const result = await tracker.listAllIssues();
  assert.equal(result.truncated, true, 'hitting LINEAR_LIST_LIMIT must set truncated');
  assert.equal(result.issues.length, 200);
});

await test('listActiveIssues — warns when limit is hit', async () => {
  const many: LinearIssueLike[] = Array.from({ length: 200 }, (_, i) =>
    makeIssue({ id: `i${i}`, identifier: `FORGE-${i}` }),
  );
  const { tracker, logger } = makeTracker({
    listIssues: async () => many,
  });
  await tracker.listActiveIssues();
  const warn = logger.warnings.find((w) => w.event === 'tracker.listActiveIssues');
  assert.ok(warn, 'expected limit-hit warn-log');
});

await test('listActiveIssues — normalizes errors with classified code', async () => {
  const { tracker } = makeTracker({
    listIssues: async () => {
      throw makeLinearAuthError();
    },
  });
  await assert.rejects(
    () => tracker.listActiveIssues(),
    (err: unknown) => err instanceof TrackerError && err.code === 'AUTH',
  );
});

await test('listActiveIssues — retries on transient errors then succeeds', async () => {
  let attempt = 0;
  const issue = makeIssue();
  const { tracker } = makeTracker({
    listIssues: async () => {
      attempt++;
      if (attempt === 1) throw makeLinearTransportError();
      return [issue];
    },
  });
  // tracker uses { sleep: async () => {} } via makeTracker so retries are instant.
  const result = await tracker.listActiveIssues();
  assert.equal(result.length, 1);
  assert.equal(attempt, 2);
});

// ─── deriveStateFromLinearIssue / toIssue ────────────────────────────────────

await test('toIssue — terminal completed state maps to done regardless of labels', async () => {
  const { tracker } = makeTracker({
    listIssues: async () => [
      makeIssue({
        state: { id: 's', name: 'Done', type: 'completed' },
        labels: [LABEL_STATE_IN_REVIEW], // should be ignored
      }),
    ],
  });
  const [issue] = await tracker.listActiveIssues();
  assert.equal(issue!.state, 'done');
});

await test('toIssue — overlay state:blocked label overrides started workflow type', async () => {
  const { tracker } = makeTracker({
    listIssues: async () => [
      makeIssue({
        state: { id: 's', name: 'In Progress', type: 'started' },
        labels: [LABEL_STATE_BLOCKED],
      }),
    ],
  });
  const [issue] = await tracker.listActiveIssues();
  assert.equal(issue!.state, 'blocked');
});

await test('toIssue — no labels, started state → in_progress', async () => {
  const { tracker } = makeTracker({
    listIssues: async () => [
      makeIssue({
        state: { id: 's', name: 'In Progress', type: 'started' },
        labels: [],
      }),
    ],
  });
  const [issue] = await tracker.listActiveIssues();
  assert.equal(issue!.state, 'in_progress');
});

// ─── updateState ─────────────────────────────────────────────────────────────

await test('updateState — in_progress sets stateId to started workflow state', async () => {
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'in_progress');
  assert.equal(captured!.input.stateId, 'state-in-progress');
});

await test('updateState — in_review keeps stateId=started AND adds state:in-review overlay', async () => {
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const inReviewLabel = { id: 'lbl-ir', name: 'state:in-review' };
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => [inReviewLabel],
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'in_review');
  assert.equal(captured!.input.stateId, 'state-in-progress');
  assert.deepEqual([...(captured!.input.addedLabelIds ?? [])], [inReviewLabel.id]);
});

await test('updateState — done sets stateId to completed workflow state', async () => {
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'done');
  assert.equal(captured!.input.stateId, 'state-done');
});

await test('updateState — cancelled sets stateId to canceled workflow state', async () => {
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'cancelled');
  assert.equal(captured!.input.stateId, 'state-canceled');
});

await test('updateState — blocked prefers backlog state when present', async () => {
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const blockedLabel = { id: 'lbl-blk', name: 'state:blocked' };
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => [blockedLabel],
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'blocked');
  assert.equal(captured!.input.stateId, 'state-backlog');
  assert.deepEqual([...(captured!.input.addedLabelIds ?? [])], [blockedLabel.id]);
});

await test('updateState — blocked falls back to unstarted when team has no backlog state + warn-log fires', async () => {
  const statesWithoutBacklog = DEFAULT_WORKFLOW_STATES.filter(
    (s) => s.type !== 'backlog',
  );
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const blockedLabel = { id: 'lbl-blk', name: 'state:blocked' };
  const { tracker, logger } = makeTracker({
    listWorkflowStates: async () => statesWithoutBacklog,
    listIssueLabels: async () => [blockedLabel],
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  await tracker.updateState('issue-1', 'blocked');
  assert.equal(captured!.input.stateId, 'state-todo'); // unstarted = "Todo" in fixtures
  const fallbackWarn = logger.warnings.find(
    (w) => w.event === 'tracker.updateState.fallback',
  );
  assert.ok(fallbackWarn, 'expected fallback warn-log');
});

await test('updateState — removes stale overlay label in fresh orchestrator process (cache miss → lookup)', async () => {
  // Bug: a fresh orchestrator process has empty labelCacheByName. When
  // transitioning out of in_review (or blocked), the remove-label path
  // would have no cached id and silently skip the removal — leaving the
  // overlay label on the issue, which causes deriveStateFromLinearIssue
  // to misreport the state on subsequent listActiveIssues calls.
  // Fix: lookupExistingLabel does a listIssueLabels refresh on cache miss.
  // Regression for the codex review finding (FORGE-16).
  const inReviewLabel = { id: 'lbl-ir', name: 'state:in-review' };
  const blockedLabel = { id: 'lbl-blk', name: 'state:blocked' };
  let listIssueLabelsCalls = 0;
  let captured: { id: string; input: LinearUpdateIssueInput } | null = null;
  const { tracker } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => {
      listIssueLabelsCalls++;
      return [inReviewLabel, blockedLabel]; // labels exist on the team
    },
    updateIssue: async (id, input) => {
      captured = { id, input };
      return makeIssue();
    },
  });
  // Transition to in_progress — wantedOverlay=null; both overlay labels
  // should be added to removedLabelIds via the lookup path.
  await tracker.updateState('issue-1', 'in_progress');
  const got = captured as { id: string; input: LinearUpdateIssueInput } | null;
  assert.ok(got, 'updateIssue should be called');
  assert.deepEqual(
    [...(got.input.removedLabelIds ?? [])].sort(),
    [blockedLabel.id, inReviewLabel.id].sort(),
    'both stale overlay labels should be queued for removal',
  );
  assert.ok(
    listIssueLabelsCalls >= 1,
    'lookup should have refreshed the cache via listIssueLabels',
  );
});

await test('updateState — overlay label lookup tolerates listIssueLabels failure (warn + skip)', async () => {
  // If the cache-refresh on remove-label path fails (e.g. transient
  // network), we log and skip the removal rather than failing
  // updateState. The state transition still succeeds; the stale label
  // gets cleaned up on the next attempt when network recovers.
  const { tracker, logger } = makeTracker({
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => {
      throw makeLinearTransportError();
    },
    updateIssue: async () => makeIssue(),
  });
  await tracker.updateState('issue-1', 'in_progress');
  const warn = logger.warnings.find(
    (w) => w.event === 'tracker.lookupExistingLabel.listFailed',
  );
  assert.ok(warn, 'expected warn-log when listIssueLabels fails during overlay lookup');
});

await test('updateState — PRECONDITION_FAILED when team has no state matching forge state', async () => {
  const onlyTriage = DEFAULT_WORKFLOW_STATES.filter((s) => s.type === 'triage');
  const { tracker } = makeTracker({
    listWorkflowStates: async () => onlyTriage,
  });
  await assert.rejects(
    () => tracker.updateState('issue-1', 'in_progress'),
    (err: unknown) =>
      err instanceof TrackerError && err.code === 'PRECONDITION_FAILED',
  );
});

// ─── Round-trip: forgeTaskId + state + blockerIds (AC bullet 3) ──────────────

await test('round-trip: footer-encoded fields survive list → toIssue parse', async () => {
  const raw = makeIssue({
    id: 'i1',
    identifier: 'FORGE-99',
    description:
      'real body content\n\n<!-- forge:task=P2-T03 -->\n<!-- forge:blockedBy=blocker-uuid-1,blocker-uuid-2 -->',
    state: { id: 's', name: 'In Progress', type: 'started' },
    labels: [],
  });
  const { tracker } = makeTracker({
    listIssues: async () => [raw],
  });
  const [issue] = await tracker.listActiveIssues();
  assert.equal(issue!.forgeTaskId, 'P2-T03');
  assert.deepEqual(issue!.blockerIds, ['blocker-uuid-1', 'blocker-uuid-2']);
  assert.equal(issue!.state, 'in_progress');
  assert.equal(issue!.identifier, 'FORGE-99');
});

// ─── createProject ───────────────────────────────────────────────────────────

await test('createProject — happy path returns {id, url} and precreates overlay labels', async () => {
  let captured: LinearCreateProjectInput | null = null;
  const createdLabels: string[] = [];
  const { tracker } = makeTracker({
    createProject: async (input) => {
      captured = input;
      return { id: 'proj-1', url: 'https://linear.app/p/1' };
    },
    listIssueLabels: async () => [],
    createIssueLabel: async ({ name }) => {
      createdLabels.push(name);
      return { id: `lbl-${name}`, name };
    },
  });
  const result = await tracker.createProject('Phase 2', 'Core features');
  assert.deepEqual(result, { id: 'proj-1', url: 'https://linear.app/p/1' });
  assert.equal(captured!.teamId, 'team-uuid-test');
  assert.equal(captured!.name, 'Phase 2');
  assert.equal(captured!.description, 'Core features');
  // Both overlay labels were precreated.
  assert.deepEqual([...createdLabels].sort(), ['state:blocked', 'state:in-review']);
});

await test('createProject — overlay precreate failure does not fail createProject', async () => {
  const { tracker, logger } = makeTracker({
    createProject: async () => ({ id: 'p', url: 'u' }),
    listIssueLabels: async () => {
      throw makeLinearTransportError();
    },
    createIssueLabel: async () => {
      throw makeLinearTransportError();
    },
  });
  const result = await tracker.createProject('x');
  assert.deepEqual(result, { id: 'p', url: 'u' });
  const warn = logger.warnings.find(
    (w) =>
      w.event === 'tracker.createProject.overlayPrecreateFailed' ||
      w.event === 'tracker.updateState.overlayAddSkipped' ||
      w.event === 'tracker.ensureLabel.listFailed',
  );
  assert.ok(warn, 'expected a warn-log for the precreate failure');
});

// ─── createIssue ─────────────────────────────────────────────────────────────

await test('createIssue — writes forge:task + forge:ownerType footers and returns mapped Issue', async () => {
  let captured: LinearCreateIssueInput | null = null;
  const created = makeIssue({
    id: 'i1',
    identifier: 'FORGE-42',
    title: 'New issue',
  });
  const { tracker } = makeTracker({
    createIssue: async (input) => {
      captured = input;
      return { ...created, description: input.description };
    },
  });
  const issue = await tracker.createIssue({
    title: 'New issue',
    body: 'hello world',
    forgeTaskId: 'P2-T03',
    ownerType: 'backend-dev',
    acceptance: [],
    dependsOn: [],
  });
  assert.equal(issue.identifier, 'FORGE-42');
  assert.match(captured!.description, /<!-- forge:task=P2-T03 -->/);
  assert.match(captured!.description, /<!-- forge:ownerType=backend-dev -->/);
});

await test('createIssue — rejects forgeTaskId containing HTML comment metacharacters', async () => {
  // Defense-in-depth against footer-corruption attack
  // (security-auditor, FORGE-16).
  const { tracker } = makeTracker({
    createIssue: async () => makeIssue(),
  });
  await assert.rejects(
    () =>
      tracker.createIssue({
        title: 'x',
        body: 'b',
        forgeTaskId: 'P2-T03 --> <script>',
        ownerType: 'backend-dev',
        acceptance: [],
        dependsOn: [],
      }),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('setBlockedBy — rejects blockerId containing HTML comment metacharacters', async () => {
  // Defense-in-depth against footer-corruption attack
  // (security-auditor, FORGE-16).
  const issue = makeIssue({
    id: 'i1',
    description: 'body\n\n<!-- forge:task=P2-T03 -->\n',
  });
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async () => issue,
  });
  await assert.rejects(
    () => tracker.setBlockedBy('i1', 'evil --> injection'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('createIssue — rejects empty payload.title', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () =>
      tracker.createIssue({
        title: '',
        body: 'x',
        forgeTaskId: 'P0-T01',
        ownerType: 'backend-dev',
        acceptance: [],
        dependsOn: [],
      }),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── setBlockedBy ────────────────────────────────────────────────────────────

await test('setBlockedBy — writes footer AND creates native blocks relation with source=blocker', async () => {
  // Linear's IssueRelationType.Blocks means "source blocks related". For
  // setBlockedBy(issueId, blockerId) — "issueId is blocked by blockerId" —
  // the source must be the BLOCKER (issueId=blockerId) and the related
  // issue must be the BLOCKED one (relatedIssueId=issueId). Getting this
  // backwards reverses the dependency arrow in Linear's UI.
  // Regression for the codex review finding (FORGE-16).
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-1',
    description: 'body\n\n<!-- forge:task=P2-T03 -->\n',
  });
  let updateInput: LinearUpdateIssueInput | null = null;
  let relationInput: { issueId: string; relatedIssueId: string; type: 'blocks' } | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      updateInput = input;
      return issue;
    },
    createIssueRelation: async (input) => {
      relationInput = input;
    },
  });
  await tracker.setBlockedBy('i1', 'blocker-uuid-1');
  assert.match(updateInput!.description ?? '', /<!-- forge:blockedBy=blocker-uuid-1 -->/);
  assert.deepEqual(relationInput, {
    issueId: 'blocker-uuid-1', // source = blocker
    relatedIssueId: 'i1', // related = blocked issue
    type: 'blocks',
  });
});

await test('setBlockedBy — footer dedup skips updateIssue but STILL attempts native relation create', async () => {
  // If a previous setBlockedBy call wrote the footer but the native
  // relation create failed transiently, the next call would short-circuit
  // on the footer dedup and never re-attempt the native call — leaving
  // the Linear UI permanently missing the dependency arrow. Native must
  // always run; CONFLICT is the idempotent case.
  // Regression for the codex review finding (FORGE-16).
  const issue = makeIssue({
    id: 'i1',
    description:
      'body\n\n<!-- forge:task=P2-T03 -->\n<!-- forge:blockedBy=existing-blocker -->\n',
  });
  let updateCalled = false;
  let relationCalled = false;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async () => {
      updateCalled = true;
      return issue;
    },
    createIssueRelation: async () => {
      relationCalled = true;
    },
  });
  await tracker.setBlockedBy('i1', 'existing-blocker');
  assert.equal(updateCalled, false, 'footer write skipped via dedup');
  assert.equal(relationCalled, true, 'native relation still attempted');
});

await test('setBlockedBy — CONFLICT on relation create is swallowed (idempotent)', async () => {
  const issue = makeIssue({
    id: 'i1',
    description: 'body\n\n<!-- forge:task=P2-T03 -->\n',
  });
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async () => issue,
    createIssueRelation: async () => {
      throw makeLinearConflictError('relation already exists');
    },
  });
  // Must not throw — already-exists is the idempotent case.
  await tracker.setBlockedBy('i1', 'blocker-uuid-1');
});

// ─── updateIssueBody (FORGE-94) ──────────────────────────────────────────────

await test('updateIssueBody — replaces description and preserves forge:task footer (round-trip via parseForgeFooters)', async () => {
  // AC-as-unit-test: parse the resulting description back through
  // parseForgeFooters and confirm the round-trip mapping holds.
  // Codex/claude 2nd-pass.
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-77',
    description: 'old body\n\n<!-- forge:task=FORGE-77 -->\n',
  });
  let captured: LinearUpdateIssueInput | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      captured = input;
      return issue;
    },
  });
  await tracker.updateIssueBody('i1', 'fresh body content');
  assert.match(captured!.description ?? '', /fresh body content/);
  const parsed = parseForgeFooters(captured!.description);
  assert.equal(parsed.forgeTaskId, 'FORGE-77', 'round-trip forgeTaskId');
});

await test('updateIssueBody — VALIDATION when body exceeds Linear byte cap (no SDK call)', async () => {
  let issueCalled = false;
  const { tracker } = makeTracker({
    issue: async () => {
      issueCalled = true;
      return makeIssue({ id: 'i1' });
    },
  });
  const tooBig = 'a'.repeat(LINEAR_DESCRIPTION_MAX_BYTES + 1);
  await assert.rejects(
    () => tracker.updateIssueBody('i1', tooBig),
    (err: unknown) =>
      err instanceof TrackerError &&
      err.code === 'VALIDATION' &&
      /exceeds provider limit/.test(err.message),
  );
  assert.equal(issueCalled, false, 'must reject before issuing any SDK call');
});

await test('updateIssueBody — preserves forge:blockedBy footer across replace', async () => {
  const issue = makeIssue({
    id: 'i1',
    description:
      'old\n\n<!-- forge:task=FORGE-77 -->\n<!-- forge:blockedBy=blocker-a,blocker-b -->\n',
  });
  let captured: LinearUpdateIssueInput | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      captured = input;
      return issue;
    },
  });
  await tracker.updateIssueBody('i1', 'replaced');
  assert.match(
    captured!.description ?? '',
    /<!-- forge:blockedBy=blocker-a,blocker-b -->/,
  );
});

await test('updateIssueBody — preserves unknown forge:* footers (ownerType)', async () => {
  const issue = makeIssue({
    id: 'i1',
    description:
      'old\n\n<!-- forge:task=FORGE-77 -->\n<!-- forge:ownerType=backend-dev -->\n',
  });
  let captured: LinearUpdateIssueInput | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      captured = input;
      return issue;
    },
  });
  await tracker.updateIssueBody('i1', 'replaced');
  assert.match(captured!.description ?? '', /forge:ownerType=backend-dev/);
  assert.match(captured!.description ?? '', /forge:task=FORGE-77/);
});

await test('updateIssueBody — PRECONDITION_FAILED when issue has no forge:task footer', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-99',
    description: 'non-forge body',
  });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  await assert.rejects(
    () => tracker.updateIssueBody('i1', 'anything'),
    (err: unknown) =>
      err instanceof TrackerError && err.code === 'PRECONDITION_FAILED',
  );
});

await test('updateIssueBody — VALIDATION on non-string body (no SDK call)', async () => {
  let issueCalled = false;
  const { tracker } = makeTracker({
    issue: async () => {
      issueCalled = true;
      return makeIssue({ id: 'i1' });
    },
  });
  await assert.rejects(
    () => tracker.updateIssueBody('i1', null as unknown as string),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
  assert.equal(issueCalled, false, 'must reject before issuing any SDK call');
});

await test('updateIssueBody — VALIDATION on embedded forge footer in input body', async () => {
  let issueCalled = false;
  const { tracker } = makeTracker({
    issue: async () => {
      issueCalled = true;
      return makeIssue({ id: 'i1' });
    },
  });
  await assert.rejects(
    () =>
      tracker.updateIssueBody(
        'i1',
        'body\n<!-- forge:blockedBy=x -->\n',
      ),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
  assert.equal(issueCalled, false);
});

// ─── FORGE-118: withRetry sweep + claim-token CAS ────────────────────────────

await test('setBlockedBy — retries on RATE_LIMITED then succeeds (FORGE-118)', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-1',
    description: 'body\n\n<!-- forge:task=P2-T03 -->\n',
  });
  let issueCalls = 0;
  const { tracker } = makeTracker({
    issue: async () => {
      issueCalls++;
      if (issueCalls === 1) throw makeLinearRateLimitError();
      return issue;
    },
    updateIssue: async () => issue,
    createIssueRelation: async () => {},
  });
  await tracker.setBlockedBy('i1', 'blocker-uuid-1');
  assert.equal(issueCalls, 2, 'first call rate-limited, retry succeeded');
});

await test('updateIssueBody — retries on RATE_LIMITED then succeeds (FORGE-118)', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-1',
    description: 'old\n\n<!-- forge:task=P2-T03 -->\n',
  });
  let issueCalls = 0;
  const { tracker } = makeTracker({
    issue: async () => {
      issueCalls++;
      if (issueCalls === 1) throw makeLinearRateLimitError();
      return issue;
    },
    updateIssue: async () => issue,
  });
  await tracker.updateIssueBody('i1', 'fresh body');
  assert.equal(issueCalls, 2);
});

await test('updateIssueBody — expectedClaim refuses on mismatching forge:claim (CLAIM_MISMATCH)', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-1',
    description:
      'body\n\n<!-- forge:task=P2-T03 -->\n' +
      '<!-- forge:claim={"claim_id":"other","generation":1,"owner_run_id":"r0"} -->\n',
  });
  let updateCalled = false;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async () => {
      updateCalled = true;
      return issue;
    },
  });
  await assert.rejects(
    () =>
      tracker.updateIssueBody('i1', 'new body', {
        expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
      }),
    (err: unknown) => err instanceof TrackerError && err.code === 'CLAIM_MISMATCH',
  );
  assert.equal(updateCalled, false, 'write refused — no updateIssue call');
});

await test('updateIssueBody — expectedClaim proceeds when footer matches or is absent', async () => {
  // Matching claim → proceed.
  const matching = makeIssue({
    id: 'i1',
    identifier: 'FORGE-1',
    description:
      'body\n\n<!-- forge:task=P2-T03 -->\n' +
      '<!-- forge:claim={"claim_id":"mine","generation":2,"owner_run_id":"r1"} -->\n',
  });
  let updates = 0;
  const m = makeTracker({
    issue: async () => matching,
    updateIssue: async () => {
      updates++;
      return matching;
    },
  });
  await m.tracker.updateIssueBody('i1', 'new body', {
    expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
  });
  assert.equal(updates, 1, 'matching claim → write proceeds');

  // Absent claim footer → proceed (fence is advisory).
  const noFence = makeIssue({
    id: 'i2',
    identifier: 'FORGE-2',
    description: 'body\n\n<!-- forge:task=P2-T03 -->\n',
  });
  let updates2 = 0;
  const n = makeTracker({
    issue: async () => noFence,
    updateIssue: async () => {
      updates2++;
      return noFence;
    },
  });
  await n.tracker.updateIssueBody('i2', 'new body', {
    expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
  });
  assert.equal(updates2, 1, 'absent fence → write proceeds');
});

// ─── setClaimFence (FORGE-167) ───────────────────────────────────────────────

await test('setClaimFence — stamps forge:claim via RAW updateIssue, preserving forge:task', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-77',
    description: 'body\n\n<!-- forge:task=FORGE-77 -->\n',
  });
  let captured: LinearUpdateIssueInput | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      captured = input;
      return issue;
    },
  });
  await tracker.setClaimFence('i1', {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'run-1',
  });
  // RAW write carried the forge:claim footer — updateIssueBody would have
  // rejected a body containing forge footers, proving we bypass it.
  assert.deepEqual(parseClaimFooter(captured!.description), {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'run-1',
  });
  assert.match(captured!.description ?? '', /forge:task=FORGE-77/);
});

await test('setClaimFence(null) — strips forge:claim, preserves other footers', async () => {
  const issue = makeIssue({
    id: 'i1',
    description:
      'body\n\n<!-- forge:task=FORGE-77 -->\n<!-- forge:blockedBy=b1 -->\n<!-- forge:claim={"claim_id":"old","generation":1,"owner_run_id":"r0"} -->\n',
  });
  let captured: LinearUpdateIssueInput | null = null;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      captured = input;
      return issue;
    },
  });
  await tracker.setClaimFence('i1', null);
  assert.equal(parseClaimFooter(captured!.description), null);
  assert.match(captured!.description ?? '', /forge:blockedBy=b1/);
  assert.match(captured!.description ?? '', /forge:task=FORGE-77/);
});

await test('setClaimFence — PRECONDITION_FAILED when no forge:task footer (no write)', async () => {
  const issue = makeIssue({ id: 'i1', description: 'non-forge body' });
  let updateCalled = false;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, _input) => {
      updateCalled = true;
      return issue;
    },
  });
  await assert.rejects(
    () =>
      tracker.setClaimFence('i1', {
        claimId: 'c',
        generation: 0,
        ownerRunId: 'r',
      }),
    (e: unknown) =>
      e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
  );
  assert.equal(updateCalled, false, 'no write after precondition fails');
});

await test('setBlockedBy — PRECONDITION_FAILED when issue has no forge:task footer', async () => {
  const issue = makeIssue({
    id: 'i1',
    identifier: 'FORGE-99',
    description: 'non-forge issue body',
  });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  await assert.rejects(
    () => tracker.setBlockedBy('i1', 'blocker-uuid-1'),
    (err: unknown) =>
      err instanceof TrackerError && err.code === 'PRECONDITION_FAILED',
  );
});

// ─── User-label preservation (AC bullet 5 / regression guard) ───────────────
//
// Codex 2nd-pass: verify at the server-state level (not just removedLabelIds
// inspection) that user-applied labels survive a full claim+release cycle.
// The addedLabelIds/removedLabelIds discipline guarantees this in theory; this
// test holds the line if anyone ever introduces a labelIds full-list replace.

await test('claim+releaseClaim — user labels preserved across full cycle', async () => {
  const userLabel: LinearLabelLike = {
    id: 'label-priority-high',
    name: 'priority:high',
  };
  const seed = makeIssue({ id: 'i1', identifier: 'FORGE-1', labels: [userLabel] });
  const server = new MockServerState([seed]);
  // Seed label so listIssueLabels returns it as a known team label.
  server.ensureLabel(userLabel.name);

  const sdk: LinearSdkLike = {
    viewer: async () => ({ id: 'u', email: 'u@x' }),
    issue: async (id) => server.getIssue(id),
    listIssues: async () => server.listIssues(),
    latestUpdatedAt: async () => '2026-01-01T00:00:00.000Z',
    createIssue: async () => makeIssue(),
    updateIssue: async (id, input) => {
      if (input.addedLabelIds) {
        for (const lid of input.addedLabelIds) {
          const l = server.labelById(lid);
          if (l) server.addLabel(id, l.name);
        }
      }
      if (input.removedLabelIds) {
        for (const lid of input.removedLabelIds) server.removeLabel(id, lid);
      }
      return server.getIssue(id);
    },
    createComment: async () => {},
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => server.allLabels(),
    createIssueLabel: async ({ name }) => server.ensureLabel(name),
    createProject: async () => ({ id: 'p', url: 'u' }),
    createIssueRelation: async () => {},
  };
  const tracker = new LinearTracker(linearConfig, noopLogger(), {
    client: sdk,
    retry: { sleep: async () => {} },
  });

  const claimResult = await tracker.claim('i1', 'me');
  assert.deepEqual(claimResult, { ok: true });
  let labels = server.getIssue('i1').labels.map((l) => l.name);
  assert.ok(labels.includes('priority:high'), 'user label preserved after claim');
  assert.ok(labels.includes('forge:claimed-by:me'), 'claim label present after claim');

  await tracker.releaseClaim('i1', 'me');
  labels = server.getIssue('i1').labels.map((l) => l.name);
  assert.ok(labels.includes('priority:high'), 'user label preserved after release');
  assert.ok(
    !labels.includes('forge:claimed-by:me'),
    'claim label removed after release',
  );
});

// ─── Tracker interface conformance (AC bullet 1) ─────────────────────────────

await test('LinearTracker passes the shared Tracker conformance suite', async () => {
  const seed = makeIssue({
    id: 'conf-issue',
    identifier: 'FORGE-CONF',
    description: 'seed body\n\n<!-- forge:task=P0-T01 -->\n',
  });
  const server = new MockServerState([seed]);

  // Happy-path SDK responding to all 9 methods used by the conformance suite.
  const sdk: LinearSdkLike = {
    viewer: async () => ({ id: 'u', email: 'u@x' }),
    issue: async (id) => server.getIssue(id),
    listIssues: async () => server.listIssues(),
    latestUpdatedAt: async () => '2026-01-01T00:00:00.000Z',
    createIssue: async (input) => {
      const created = makeIssue({
        id: 'created-1',
        identifier: 'FORGE-CREATED',
        title: input.title,
        description: input.description,
      });
      server.setIssue(created);
      return created;
    },
    updateIssue: async (id, input) => {
      if (input.addedLabelIds) {
        for (const lid of input.addedLabelIds) {
          const l = server.labelById(lid);
          if (l) server.addLabel(id, l.name);
        }
      }
      if (input.removedLabelIds) {
        for (const lid of input.removedLabelIds) server.removeLabel(id, lid);
      }
      if (input.description !== undefined) {
        const current = server.getIssue(id);
        server.setIssue({ ...current, description: input.description });
      }
      return server.getIssue(id);
    },
    createComment: async () => {},
    listWorkflowStates: async () => DEFAULT_WORKFLOW_STATES,
    listIssueLabels: async () => server.allLabels(),
    createIssueLabel: async ({ name }) => server.ensureLabel(name),
    createProject: async () => ({
      id: 'project-conf',
      url: 'https://linear.app/p/conf',
    }),
    createIssueRelation: async () => {},
  };

  const tracker = new LinearTracker(linearConfig, noopLogger(), {
    client: sdk,
    retry: { sleep: async () => {} },
  });
  // Seed a blocker issue so setBlockedBy doesn't conflict.
  server.setIssue(makeIssue({ id: 'blocker-1', identifier: 'FORGE-BLK' }));

  await runTrackerConformance(tracker, {
    existingIssueId: 'conf-issue',
    blockerId: 'blocker-1',
    runId: 'run-conformance',
  });
});

// Module-level marker: unused imports kept for future test additions.
type _Unused =
  | LinearStateType
  | LinearCreateIssueInput
  | LinearUpdateIssueInput
  | LinearCreateProjectInput
  | LinearWorkflowStateLike
  | LinearLabelLike
  | LinearIssueLike
  | typeof DEFAULT_WORKFLOW_STATES
  | typeof STATE_TODO;

// ─── getCurrentRevision (FORGE-123) ──────────────────────────────────────────

await test('getCurrentRevision — calls latestUpdatedAt(teamId) and returns linear:<iso>', async () => {
  const { tracker, client } = makeTracker({
    latestUpdatedAt: async () => '2026-06-01T09:30:00.000Z',
  });
  const rev = await tracker.getCurrentRevision();
  assert.equal(rev, 'linear:2026-06-01T09:30:00.000Z');
  const call = client.calls.find((c) => c.method === 'latestUpdatedAt');
  assert.ok(call, 'latestUpdatedAt must be invoked');
  assert.equal(call!.args[0], 'team-uuid-test');
});

await test('getCurrentRevision — no issues returns linear:none', async () => {
  const { tracker } = makeTracker({ latestUpdatedAt: async () => null });
  assert.equal(await tracker.getCurrentRevision(), 'linear:none');
});

await test('wrapLinearClient.latestUpdatedAt — top-1 updatedAt desc, ISO from Date node', async () => {
  let captured: { first?: number; orderBy?: unknown } | undefined;
  const fakeClient = {
    issues: async (vars: { first?: number; orderBy?: unknown }) => {
      captured = vars;
      return { nodes: [{ updatedAt: new Date('2026-06-02T00:00:00.000Z') }] };
    },
  } as unknown as Parameters<typeof wrapLinearClient>[0];
  const sdk = wrapLinearClient(fakeClient);
  const iso = await sdk.latestUpdatedAt('team-x');
  assert.equal(iso, '2026-06-02T00:00:00.000Z');
  assert.equal(captured?.first, 1);
  assert.equal(captured?.orderBy, 'updatedAt');
});
