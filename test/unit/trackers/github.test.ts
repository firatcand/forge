import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GH_LIST_LIMIT,
  GitHubTracker,
  TrackerError,
  classifyGitHubError,
  parseForgeFooters,
  serializeWithForgeFooters,
  type GhExec,
  type GhExecResult,
  type Logger,
} from '../../../src/trackers/index.ts';
import type { GithubTrackerConfig } from '../../../src/schemas/settings.ts';
import {
  ghIssueListOpen,
  ghIssueViewLabelsEmpty,
  ghIssueViewLabelsClaimedOther,
  ghIssueViewLabelsClaimedMe,
  ghIssueViewSingle,
  ghIssueViewBodyOnly,
  ghIssueViewBodyMissingFooter,
  ghMilestoneCreated,
  makeExecaError,
} from '../../fixtures/trackers/github-responses.ts';
import {
  MockGhServerState,
  makeMockGhIssue,
  makeStateBackedGitHubTracker,
} from '../../fixtures/trackers/github-state.ts';
import { runTrackerConformance } from '../../fixtures/trackers/conformance.ts';

// ─── Test infra ──────────────────────────────────────────────────────────────

const githubConfig: GithubTrackerConfig = {
  type: 'github',
  config: { repo: 'firatcand/forge-test' },
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

type MockStep = GhExecResult | Error;

class MockGh {
  private idx = 0;
  readonly calls: Array<readonly string[]> = [];
  constructor(private readonly steps: MockStep[]) {}
  exec: GhExec = async (args) => {
    this.calls.push([...args]);
    const step = this.steps[this.idx++];
    if (step === undefined) {
      throw new Error(
        `MockGh: unexpected call #${this.idx}: gh ${args.join(' ')}`,
      );
    }
    if (step instanceof Error) throw step;
    return step;
  };
}

function ok(stdout: unknown = '', stderr = ''): GhExecResult {
  return {
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr,
    exitCode: 0,
  };
}

function fail(stderr: string, exitCode = 1): GhExecResult {
  return { stdout: '', stderr, exitCode };
}

function makeTracker(steps: MockStep[]) {
  const mock = new MockGh(steps);
  const logger = noopLogger();
  const tracker = new GitHubTracker(githubConfig, logger, {
    gh: mock.exec,
    retry: { sleep: async () => {} },
  });
  return { tracker, mock, logger };
}

// ─── footer parser (pure) ────────────────────────────────────────────────────

test('parseForgeFooters reads task + blockedBy', () => {
  const body = 'Hello\n\n<!-- forge:task=FORGE-7 -->\n<!-- forge:blockedBy=10,11 -->\n';
  assert.deepEqual(parseForgeFooters(body), {
    forgeTaskId: 'FORGE-7',
    blockerIds: ['10', '11'],
  });
});

test('parseForgeFooters returns empty blockerIds when missing', () => {
  const body = 'Hi\n\n<!-- forge:task=FORGE-9 -->';
  assert.deepEqual(parseForgeFooters(body), {
    forgeTaskId: 'FORGE-9',
    blockerIds: [],
  });
});

test('parseForgeFooters tolerates null/empty body', () => {
  assert.deepEqual(parseForgeFooters(null), { blockerIds: [] });
  assert.deepEqual(parseForgeFooters(''), { blockerIds: [] });
});

test('parseForgeFooters tolerates whitespace inside blockedBy', () => {
  const body = '<!-- forge:task=FORGE-1 -->\n<!-- forge:blockedBy=  10 , 11  -->';
  assert.deepEqual(parseForgeFooters(body), {
    forgeTaskId: 'FORGE-1',
    blockerIds: ['10', '11'],
  });
});

test('serializeWithForgeFooters round-trips data', () => {
  const out = serializeWithForgeFooters('Some body.', 'FORGE-T1', ['10', '11']);
  const parsed = parseForgeFooters(out);
  assert.deepEqual(parsed, {
    forgeTaskId: 'FORGE-T1',
    blockerIds: ['10', '11'],
  });
  assert.ok(out.startsWith('Some body.'));
});

test('serializeWithForgeFooters strips existing footers (idempotent)', () => {
  const original =
    'Body.\n\n<!-- forge:task=OLD -->\n<!-- forge:blockedBy=9 -->\n';
  const out = serializeWithForgeFooters(original, 'NEW', ['1']);
  assert.match(out, /forge:task=NEW/);
  assert.doesNotMatch(out, /forge:task=OLD/);
  assert.doesNotMatch(out, /blockedBy=9/);
});

test('serializeWithForgeFooters skips blockedBy when list is empty', () => {
  const out = serializeWithForgeFooters('Body.', 'FORGE-X', []);
  assert.match(out, /forge:task=FORGE-X/);
  assert.doesNotMatch(out, /blockedBy/);
});

test('serializeWithForgeFooters appends extra footers', () => {
  const out = serializeWithForgeFooters('Body.', 'FORGE-X', [], [
    '<!-- forge:ownerType=backend-dev -->',
  ]);
  assert.match(out, /ownerType=backend-dev/);
});

// ─── classifyGitHubError ─────────────────────────────────────────────────────

test('classifyGitHubError → AUTH on Bad credentials', () => {
  const err = makeExecaError({ stderr: 'gh: Bad credentials', exitCode: 1 });
  assert.equal(classifyGitHubError(err).code, 'AUTH');
});

test('classifyGitHubError → NOT_FOUND on HTTP 404', () => {
  const err = makeExecaError({ stderr: 'HTTP 404: Not Found', exitCode: 1 });
  assert.equal(classifyGitHubError(err).code, 'NOT_FOUND');
});

test('classifyGitHubError → RATE_LIMITED with retryAfterMs', () => {
  const err = makeExecaError({
    stderr: 'API rate limit exceeded\nRetry-After: 30',
    exitCode: 1,
  });
  const hint = classifyGitHubError(err);
  assert.equal(hint.code, 'RATE_LIMITED');
  assert.equal(hint.details?.retryAfterMs, 30_000);
});

test('classifyGitHubError → VALIDATION on HTTP 422', () => {
  const err = makeExecaError({ stderr: 'HTTP 422: validation failed' });
  assert.equal(classifyGitHubError(err).code, 'VALIDATION');
});

test('classifyGitHubError → CONFLICT on already exists', () => {
  const err = makeExecaError({ stderr: 'label already exists', exitCode: 1 });
  assert.equal(classifyGitHubError(err).code, 'CONFLICT');
});

test('classifyGitHubError → TIMEOUT on ETIMEDOUT', () => {
  const err = makeExecaError({ stderr: '', code: 'ETIMEDOUT' });
  assert.equal(classifyGitHubError(err).code, 'TIMEOUT');
});

test('classifyGitHubError → TRANSPORT on ENOENT', () => {
  const err = makeExecaError({ code: 'ENOENT' });
  const hint = classifyGitHubError(err);
  assert.equal(hint.code, 'TRANSPORT');
  assert.equal(hint.details?.reason, 'gh-not-installed');
});

test('classifyGitHubError → TRANSPORT on HTTP 5xx', () => {
  const err = makeExecaError({ stderr: 'HTTP 503 Service Unavailable' });
  assert.equal(classifyGitHubError(err).code, 'TRANSPORT');
});

test('classifyGitHubError → UNKNOWN for non-object', () => {
  assert.equal(classifyGitHubError(null).code, 'UNKNOWN');
  assert.equal(classifyGitHubError(42).code, 'UNKNOWN');
});

// ─── healthCheck ─────────────────────────────────────────────────────────────

test('healthCheck → ok on exitCode 0', async () => {
  const { tracker } = makeTracker([ok('Logged in to github.com')]);
  const result = await tracker.healthCheck();
  assert.equal(result.ok, true);
});

test('healthCheck → not ok on non-zero exit', async () => {
  const { tracker } = makeTracker([fail('not logged in to gh.com', 1)]);
  const result = await tracker.healthCheck();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /not logged in/);
});

test('healthCheck → not ok on ENOENT (never throws)', async () => {
  const { tracker } = makeTracker([makeExecaError({ code: 'ENOENT' })]);
  const result = await tracker.healthCheck();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /not installed/i);
});

// ─── listActiveIssues ────────────────────────────────────────────────────────

test('listActiveIssues parses 3 issues with mixed footers and states', async () => {
  const { tracker } = makeTracker([ok(ghIssueListOpen)]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 3);

  assert.equal(issues[0]?.id, '42');
  assert.equal(issues[0]?.identifier, '#42');
  assert.equal(issues[0]?.state, 'in_progress');
  assert.equal(issues[0]?.forgeTaskId, 'FORGE-T1');
  assert.deepEqual(issues[0]?.blockerIds, ['10', '11']);

  assert.equal(issues[1]?.state, 'blocked');
  assert.equal(issues[1]?.forgeTaskId, 'FORGE-T2');

  assert.equal(issues[2]?.state, 'todo');
  assert.equal(issues[2]?.forgeTaskId, undefined);
  assert.deepEqual(issues[2]?.blockerIds, []);
});

test('listActiveIssues warns when at GH_LIST_LIMIT', async () => {
  const atLimit = Array.from({ length: GH_LIST_LIMIT }, (_, i) => ({
    id: `I_${i}`,
    number: i + 1,
    title: `t${i}`,
    labels: [],
    body: null,
    url: `https://example.com/issues/${i + 1}`,
  }));
  const { tracker, logger } = makeTracker([ok(atLimit)]);
  await tracker.listActiveIssues();
  const warn = logger.warnings.find(
    (w) => w.event === 'tracker.listActiveIssues',
  );
  assert.ok(warn !== undefined, 'expected limit-hit warning');
});

test('classifyGitHubError → AUTH on HTTP 403 for private repo (not NOT_FOUND)', () => {
  // GitHub's 403 for private/no-access often phrases the response with
  // "Not Found" copy. The AUTH branch must catch this before NOT_FOUND.
  const err = makeExecaError({
    stderr: 'HTTP 403: Resource not accessible by integration',
    exitCode: 1,
  });
  assert.equal(classifyGitHubError(err).code, 'AUTH');
});

test('classifyGitHubError → CONFLICT only after VALIDATION (regression)', () => {
  const err = makeExecaError({
    stderr: 'HTTP 422: Validation Failed: title already exists in milestone',
  });
  assert.equal(classifyGitHubError(err).code, 'VALIDATION');
});

test('listActiveIssues VALIDATION on bad JSON', async () => {
  const { tracker } = makeTracker([ok('{not json')]);
  await assert.rejects(
    () => tracker.listActiveIssues(),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── claim ───────────────────────────────────────────────────────────────────

test('claim happy path: no existing claim → add label → re-read → ok', async () => {
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsEmpty), // step 1: read labels
    ok(),                       // step 2: ensureLabel `label create --force`
    ok(),                       // step 3: gh issue edit --add-label
    ok(ghIssueViewLabelsClaimedMe), // step 4: re-read labels (only me)
  ]);
  const result = await tracker.claim('42', 'me');
  assert.deepEqual(result, { ok: true });
  // Check we hit the expected commands
  assert.ok(mock.calls.some((c) => c.includes('--add-label')));
});

test('claim returns already_claimed when another agent holds the label', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewLabelsClaimedOther)]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'already_claimed');
});

test('claim is idempotent when this agent already holds the only claim', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewLabelsClaimedMe)]);
  const result = await tracker.claim('42', 'me');
  assert.deepEqual(result, { ok: true });
});

test('claim race: re-read shows multiple claims; loser releases own label', async () => {
  // 'forge:claimed-by:aaa' < 'forge:claimed-by:zzz' lexicographically, so aaa wins; zzz loses.
  const raceLabels = {
    labels: [
      { name: 'forge:claimed-by:aaa' },
      { name: 'forge:claimed-by:zzz' },
    ],
  };
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsEmpty), // step 1: initial read (no claims)
    ok(),                       // ensureLabel
    ok(),                       // edit --add-label forge:claimed-by:zzz
    ok(raceLabels),             // re-read: both aaa + zzz
    ok(),                       // tryRemoveLabel forge:claimed-by:zzz
  ]);
  const result = await tracker.claim('42', 'zzz');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /lost-tiebreak/);
  }
  // verify we removed our own label
  const removeCalls = mock.calls.filter((c) => c.includes('--remove-label'));
  assert.equal(removeCalls.length, 1);
  assert.ok(removeCalls[0]?.includes('forge:claimed-by:zzz'));
});

test('claim race: "aaa" wins lexicographic tiebreak on reread', async () => {
  // 'forge:claimed-by:aaa' < 'forge:claimed-by:zzz', so aaa wins.
  const labelsBoth = {
    labels: [
      { name: 'forge:claimed-by:aaa' },
      { name: 'forge:claimed-by:zzz' },
    ],
  };
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty),
    ok(),
    ok(),
    ok(labelsBoth),
  ]);
  const result = await tracker.claim('42', 'aaa');
  assert.deepEqual(result, { ok: true });
});

test('claim NOT_FOUND on add → version_conflict (issue closed mid-flight)', async () => {
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty),
    ok(), // ensureLabel
    makeExecaError({ stderr: 'HTTP 404: Not Found', exitCode: 1 }),
  ]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'version_conflict');
});

test('claim transient transport error on initial read → transient_error', async () => {
  const transportErr = makeExecaError({
    stderr: 'connection reset',
    exitCode: -1,
    code: 'ECONNRESET',
  });
  const { tracker } = makeTracker([
    transportErr,
    transportErr,
    transportErr, // all 3 attempts fail
  ]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'transient_error');
});

test('claim VALIDATION on empty issueId', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.claim('', 'me'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

test('claim step-1 NOT_FOUND → version_conflict (issue vanished pre-read)', async () => {
  const notFound = makeExecaError({
    stderr: 'HTTP 404: Not Found',
    exitCode: 1,
  });
  const { tracker } = makeTracker([notFound]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /initial-read/);
  }
});

test('claim reread shows our label missing → version_conflict (label stripped or add lost)', async () => {
  // Our --add-label succeeded but the reread returns ZERO claim labels. This can
  // happen if a concurrent actor removed the label, or the add was silently
  // dropped server-side. AC: must return version_conflict, not false-positive ok.
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsEmpty), // step 1: initial read (no claims)
    ok(),                       // ensureLabel
    ok(),                       // edit --add-label
    ok(ghIssueViewLabelsEmpty), // reread: also empty (our label gone)
    ok(),                       // tryRemoveLabel (best-effort cleanup)
  ]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /claim-label-missing-on-recheck/);
  }
  // verify we attempted the best-effort cleanup
  const removeCalls = mock.calls.filter((c) => c.includes('--remove-label'));
  assert.equal(removeCalls.length, 1);
  assert.ok(removeCalls[0]?.includes('forge:claimed-by:me'));
});

test('claim reread shows only OTHER agent\'s label → version_conflict (not false-positive ok)', async () => {
  // Pre-fix bug: code returned ok:true because allClaims.length === 1. Now it
  // must check myLabel inclusion. Spec AC: "verify (a) our label is present
  // AND (b) no other forge:claimed-by:* label is present".
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty),   // step 1: initial read
    ok(),                          // ensureLabel
    ok(),                          // edit --add-label
    ok(ghIssueViewLabelsClaimedOther), // reread: only other's label
    ok(),                          // tryRemoveLabel
  ]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /claim-label-missing-on-recheck/);
  }
});

test('claim step-3 NOT_FOUND → version_conflict (issue vanished after add)', async () => {
  const notFound = makeExecaError({
    stderr: 'HTTP 404: Not Found',
    exitCode: 1,
  });
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty), // step-1 read
    ok(),                       // ensureLabel
    ok(),                       // add-label
    notFound,                   // step-3 recheck fails
    ok(),                       // tryRemoveLabel
  ]);
  const result = await tracker.claim('42', 'me');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'version_conflict');
    assert.match(result.detail ?? '', /recheck/);
  }
});

// ─── releaseClaim ────────────────────────────────────────────────────────────

test('releaseClaim emits exactly one --remove-label call scoped to runId', async () => {
  // Strict-scope contract: releaseClaim('42', 'me') issues exactly one
  // `gh issue edit --remove-label forge:claimed-by:me` and nothing else.
  // No upfront read; no iteration over the issue's other labels. The mock
  // only supplies one response — if the implementation tried to read first
  // or remove additional labels, the mock would throw "unexpected call".
  const { tracker, mock } = makeTracker([
    ok(), // remove-label forge:claimed-by:me
  ]);
  await tracker.releaseClaim('42', 'me');
  assert.equal(mock.calls.length, 1, 'expected exactly one gh invocation');
  const args = mock.calls[0];
  assert.ok(args?.includes('--remove-label'));
  const removed = args[args.indexOf('--remove-label') + 1];
  assert.equal(removed, 'forge:claimed-by:me');
});

test('releaseClaim tolerates "label not present" on remove (no-op)', async () => {
  const { tracker } = makeTracker([
    makeExecaError({
      stderr: 'label does not have label "forge:claimed-by:me"',
      exitCode: 1,
    }),
  ]);
  // Should not throw — strict-scope release of a label that isn't present is idempotent.
  await tracker.releaseClaim('42', 'me');
});

test('releaseClaim tolerates HTTP 404 on remove (issue vanished)', async () => {
  const { tracker } = makeTracker([
    makeExecaError({ stderr: 'HTTP 404: Not Found', exitCode: 1 }),
  ]);
  // Should not throw — issue closed/deleted during release is benign.
  await tracker.releaseClaim('42', 'me');
});

// ─── updateState ─────────────────────────────────────────────────────────────

test('updateState done → gh issue close --reason completed', async () => {
  const { tracker, mock } = makeTracker([ok()]);
  await tracker.updateState('42', 'done');
  const args = mock.calls[0];
  assert.ok(args?.includes('close'));
  assert.ok(args?.includes('completed'));
});

test('updateState cancelled → gh issue close --reason "not planned" (CLI spelling)', async () => {
  // gh CLI uses the human-readable "not planned" (space) — NOT the API
  // enum "not_planned" (underscore). Asserting the exact arg catches
  // future drift; the mock can't validate gh's flag-parser since it
  // doesn't actually shell out.
  const { tracker, mock } = makeTracker([ok()]);
  await tracker.updateState('42', 'cancelled');
  const args = mock.calls[0];
  assert.ok(args?.includes('close'));
  const reasonIdx = args?.indexOf('--reason') ?? -1;
  assert.equal(args?.[reasonIdx + 1], 'not planned');
});

test('updateState in_progress → reopen + add state:in-progress label', async () => {
  const { tracker, mock } = makeTracker([
    ok(), // reopen (may noop)
    ok(), // ensureLabel create
    ok(), // edit --remove-label state:*,state:* --add-label state:in-progress
  ]);
  await tracker.updateState('42', 'in_progress');
  const edit = mock.calls.find((c) => c.includes('edit'));
  assert.ok(edit?.includes('state:in-progress'));
  assert.ok(edit?.includes('--remove-label'));
});

test('updateState todo → reopen + remove all state labels, no add', async () => {
  const { tracker, mock } = makeTracker([
    ok(), // reopen
    ok(), // edit --remove-label
  ]);
  await tracker.updateState('42', 'todo');
  const edit = mock.calls.find((c) => c.includes('edit'));
  assert.ok(edit?.includes('--remove-label'));
  assert.ok(!edit?.includes('--add-label'));
});

test('updateState tolerates "already open" on reopen', async () => {
  const { tracker } = makeTracker([
    makeExecaError({ stderr: 'issue is already open', exitCode: 1 }),
    ok(), // ensureLabel
    ok(), // edit
  ]);
  await tracker.updateState('42', 'in_progress');
});

test('updateState done → in_progress reopen happy path (closed → open)', async () => {
  const { tracker, mock } = makeTracker([
    ok(), // reopen succeeds
    ok(), // ensureLabel
    ok(), // edit --remove-label state:* --add-label state:in-progress
  ]);
  await tracker.updateState('42', 'in_progress');
  const reopen = mock.calls.find((c) => c.includes('reopen'));
  assert.ok(reopen, 'expected reopen call');
});

// ─── comment ─────────────────────────────────────────────────────────────────

test('comment forwards to gh issue comment', async () => {
  const { tracker, mock } = makeTracker([ok()]);
  await tracker.comment('42', 'hello world');
  const args = mock.calls[0];
  assert.ok(args?.includes('comment'));
  assert.ok(args?.includes('hello world'));
});

test('comment VALIDATION on empty body', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.comment('42', ''),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

test('comment does NOT retry on transient errors (one-shot write)', async () => {
  // Returning a TRANSPORT-class error once would trigger withRetry; the
  // mock only supplies ONE response. If comment retried, we'd get an
  // "unexpected call" error from the mock — the test asserts a single attempt.
  const transportErr = makeExecaError({
    stderr: 'HTTP 503 Service Unavailable',
    exitCode: 1,
  });
  const { tracker, mock } = makeTracker([transportErr]);
  await assert.rejects(
    () => tracker.comment('42', 'hi'),
    (err: unknown) => err instanceof TrackerError && err.code === 'TRANSPORT',
  );
  assert.equal(mock.calls.length, 1, 'comment should not retry');
});

// ─── createProject ──────────────────────────────────────────────────────────

test('createProject parses milestone response → { id, url }', async () => {
  const { tracker } = makeTracker([
    ok(ghMilestoneCreated),
    ok(), // precreate state:in-progress
    ok(), // precreate state:in-review
    ok(), // precreate state:blocked
  ]);
  const result = await tracker.createProject('P2', 'desc');
  assert.equal(result.id, '7');
  assert.equal(result.url, ghMilestoneCreated.html_url);
});

test('createProject VALIDATION on missing name', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.createProject(''),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── createIssue ─────────────────────────────────────────────────────────────

test('createIssue posts body w/ footers, hydrates via view, returns Issue', async () => {
  const { tracker, mock } = makeTracker([
    ok('https://github.com/firatcand/forge-test/issues/42\n'),
    ok(ghIssueViewSingle),
  ]);
  const issue = await tracker.createIssue({
    title: 'Sample',
    body: 'Sample body.',
    forgeTaskId: 'FORGE-99',
    ownerType: 'backend-dev',
    acceptance: [],
    dependsOn: [],
  });
  assert.equal(issue.id, '42');
  assert.equal(issue.identifier, '#42');
  assert.equal(issue.forgeTaskId, 'FORGE-99');

  // verify the create call carried the footer
  const create = mock.calls[0];
  const bodyArgIdx = create?.indexOf('--body') ?? -1;
  const body = bodyArgIdx >= 0 ? create?.[bodyArgIdx + 1] : '';
  assert.match(body ?? '', /forge:task=FORGE-99/);
  assert.match(body ?? '', /forge:ownerType=backend-dev/);
});

test('createIssue VALIDATION when forgeTaskId is empty', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () =>
      tracker.createIssue({
        title: 'T',
        body: 'B',
        forgeTaskId: '',
        ownerType: 'backend-dev',
        acceptance: [],
        dependsOn: [],
      }),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── setBlockedBy ────────────────────────────────────────────────────────────

test('setBlockedBy appends blockerId to body footer', async () => {
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewBodyOnly), // existing: blockedBy=10
    ok(),
  ]);
  await tracker.setBlockedBy('42', '11');
  const edit = mock.calls[1];
  const bodyArgIdx = edit?.indexOf('--body') ?? -1;
  const body = bodyArgIdx >= 0 ? edit?.[bodyArgIdx + 1] : '';
  assert.match(body ?? '', /forge:blockedBy=10,11/);
});

test('setBlockedBy is dedup-idempotent', async () => {
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly)]);
  await tracker.setBlockedBy('42', '10'); // already in body
  // No edit call expected (only the view)
  const edits = mock.calls.filter((c) => c.includes('edit'));
  assert.equal(edits.length, 0);
});

test('setBlockedBy VALIDATION on non-numeric blockerId', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.setBlockedBy('42', 'abc'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

test('setBlockedBy PRECONDITION_FAILED when no forge:task footer', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewBodyMissingFooter)]);
  await assert.rejects(
    () => tracker.setBlockedBy('42', '10'),
    (err: unknown) =>
      err instanceof TrackerError && err.code === 'PRECONDITION_FAILED',
  );
});

test('setBlockedBy preserves unknown forge:* footers (ownerType)', async () => {
  const bodyWithOwnerType = {
    body:
      'Original body.\n\n' +
      '<!-- forge:task=FORGE-7 -->\n' +
      '<!-- forge:ownerType=backend-dev -->\n' +
      '<!-- forge:blockedBy=10 -->\n',
  };
  const { tracker, mock } = makeTracker([ok(bodyWithOwnerType), ok()]);
  await tracker.setBlockedBy('42', '11');
  const edit = mock.calls[1];
  const bodyArgIdx = edit?.indexOf('--body') ?? -1;
  const body = bodyArgIdx >= 0 ? (edit?.[bodyArgIdx + 1] ?? '') : '';
  assert.match(body, /forge:ownerType=backend-dev/);
  assert.match(body, /forge:blockedBy=10,11/);
  assert.match(body, /forge:task=FORGE-7/);
});

// ─── parseIssueNumber via claim entrypoints (indirect) ───────────────────────

test('issue id accepts "#42"', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewLabelsClaimedMe)]);
  const result = await tracker.claim('#42', 'me');
  assert.deepEqual(result, { ok: true });
});

test('issue id accepts full URL', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewLabelsClaimedMe)]);
  const result = await tracker.claim(
    'https://github.com/firatcand/forge-test/issues/42',
    'me',
  );
  assert.deepEqual(result, { ok: true });
});

test('issue id rejects garbage', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.claim('not-an-id', 'me'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

// ─── shared tracker conformance suite ────────────────────────────────────────
//
// Structural coverage of all 9 Tracker interface methods via the
// state-backed mock. Existing sequenced-MockGh tests above already exercise
// every method in isolation — this is the canonical interface check used
// uniformly across adapters (Linear has the same test in linear.test.ts).

test('GitHubTracker passes the shared Tracker conformance suite', async () => {
  const repo = 'firatcand/forge-test';
  const seedBody =
    'seed body for conformance.\n\n<!-- forge:task=P0-T01 -->\n';
  const server = new MockGhServerState({
    repo,
    initialIssues: [
      makeMockGhIssue({ number: 42, title: 'Existing issue', body: seedBody }, repo),
      makeMockGhIssue({ number: 1, title: 'Blocker issue' }, repo),
    ],
  });
  const tracker = makeStateBackedGitHubTracker(server);
  await runTrackerConformance(tracker, {
    existingIssueId: '42',
    blockerId: '1',
  });
});
