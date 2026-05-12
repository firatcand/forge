import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LinearTrackerConfig } from '../../../src/schemas/settings.ts';
import {
  LinearTracker,
  classifyLinearError,
  TrackerError,
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

// ─── releaseClaim — idempotent broad release ─────────────────────────────────

await test('releaseClaim — removes all claimed:agent-* labels in one updateIssue call', async () => {
  const myLabel = makeClaimLabel('me');
  const otherLabel = makeClaimLabel('other');
  const issue = makeIssue({
    id: 'issue-1',
    labels: [myLabel, otherLabel, LABEL_STATE_IN_REVIEW],
  });
  let removed: readonly string[] | undefined;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async (_id, input) => {
      removed = input.removedLabelIds;
      return issue;
    },
  });
  await tracker.releaseClaim('issue-1');
  assert.deepEqual(
    [...(removed ?? [])].sort(),
    [myLabel.id, otherLabel.id].sort(),
  );
});

await test('releaseClaim — no-op when no claim labels are present', async () => {
  const issue = makeIssue({ id: 'issue-1', labels: [LABEL_STATE_BLOCKED] });
  let updateCalled = false;
  const { tracker } = makeTracker({
    issue: async () => issue,
    updateIssue: async () => {
      updateCalled = true;
      return issue;
    },
  });
  await tracker.releaseClaim('issue-1');
  assert.equal(updateCalled, false);
});

await test('releaseClaim — swallows NOT_FOUND on initial read (idempotent)', async () => {
  const { tracker } = makeTracker({
    issue: async () => {
      throw makeLinearNotFoundError();
    },
  });
  await tracker.releaseClaim('issue-1'); // must not throw
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

await test('claim — initial read NOT_FOUND → state_changed', async () => {
  const { tracker } = makeTracker({
    issue: async () => {
      throw makeLinearNotFoundError();
    },
  });
  const result = await tracker.claim('i1', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'state_changed');
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

await test('claim — addLabel NOT_FOUND → state_changed', async () => {
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
  if (!result.ok) assert.equal(result.reason, 'state_changed');
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

await test('claim — recheck NOT_FOUND → state_changed (label released)', async () => {
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
    assert.equal(result.reason, 'state_changed');
    assert.match(result.detail ?? '', /recheck/);
  }
  assert.deepEqual([...(removedDuringCleanup ?? [])], ['label-claimed:agent-me']);
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

await test('claim — tiebreak: I win when my label is lexicographic first', async () => {
  const myLabel = makeClaimLabel('aaa-me');
  const otherLabel = makeClaimLabel('bbb-other');
  const issue = makeIssue({ id: 'i1', labels: [myLabel, otherLabel] });
  const { tracker } = makeTracker({
    issue: async () => issue,
  });
  assert.deepEqual(await tracker.claim('i1', 'aaa-me'), { ok: true });
});

await test('claim — tiebreak: I lose when other label is first → state_changed + my label removed', async () => {
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
    assert.equal(result.reason, 'state_changed');
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

await test('claim — assertValidAgentId rejects characters outside [A-Za-z0-9._-]', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.claim('i1', '!malicious-prefix-wins-tiebreak'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

await test('claim — assertValidAgentId rejects >80 chars', async () => {
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

await test('claim — assertNonEmpty rejects empty agentId', async () => {
  const { tracker } = makeTracker({});
  await assert.rejects(
    () => tracker.claim('i1', ''),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
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
    // read) or state_changed via tiebreak (both wrote, then re-read).
    const loser = a.ok ? b : a;
    if (!loser.ok) {
      assert.match(
        loser.reason,
        /already_claimed|state_changed/,
        `iter ${iter}: loser had unexpected reason ${loser.reason}`,
      );
    }

    // Final server state must have exactly one claim label.
    const final = server.getIssue('i1');
    const finalClaims = final.labels.filter((l) =>
      l.name.startsWith('claimed:agent-'),
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
  let capturedFilter: { teamId: string; stateTypes: readonly string[] } | null = null;
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
  assert.deepEqual(
    [...capturedFilter!.stateTypes].sort(),
    ['backlog', 'started', 'triage', 'unstarted'],
  );
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
    agentId: 'agent-conformance',
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
