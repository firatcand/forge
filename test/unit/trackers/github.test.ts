import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GH_LIST_LIMIT,
  GitHubTracker,
  TrackerError,
  classifyGitHubError,
  parseForgeFooters,
  serializeWithForgeFooters,
  toStoredLabel,
  runIdFromStoredLabel,
  type GhExec,
  type GhExecResult,
  type Logger,
} from '../../../src/trackers/index.ts';
import {
  assertValidBodyInput,
  parseClaimFooter,
} from '../../../src/trackers/footers.ts';
import { GH_ISSUE_BODY_MAX_BYTES } from '../../../src/trackers/github.ts';
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
  FORGE_82_UUID,
  FORGE_82_STORED_LABEL,
  ghIssueViewLabelsClaimedMeStored,
  ghLabelNotFoundError,
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
  assert.equal(issues[0]?.identifier, 'GH-42'); // FORGE-130: normalized from #42
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
  assert.equal(issue.identifier, 'GH-42'); // FORGE-130: normalized from #42
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

// ─── FORGE-130: GH-<n> normalization + reverse-map round-trip ─────────────────

test('FORGE-130: toIssue emits GH-<n> identifier (not legacy #<n>)', async () => {
  const { tracker } = makeTracker([ok(ghIssueListOpen)]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues[0]?.id, '42');
  assert.equal(issues[0]?.identifier, 'GH-42');
  assert.equal(issues[1]?.identifier, 'GH-43');
  assert.equal(issues[2]?.identifier, 'GH-44');
});

test('FORGE-130: parseIssueNumber reverse-maps GH-42 / #42 / 42 / URL to bare number on native calls', async () => {
  // Each accepted issueId shape must drive the SAME native gh call (`comment 42`).
  for (const issueId of ['GH-42', '#42', '42', 'gh-42', 'https://github.com/firatcand/forge-test/issues/42']) {
    const { tracker, mock } = makeTracker([ok()]);
    await tracker.comment(issueId, 'hi');
    const args = mock.calls[0]!;
    // gh issue comment <number> --repo ...
    assert.equal(args[0], 'issue');
    assert.equal(args[1], 'comment');
    assert.equal(args[2], '42', `issueId ${issueId} should reverse-map to bare 42`);
  }
});

test('FORGE-130: legacy #42 shape still drives claim (back-compat for stored bindings)', async () => {
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsEmpty), // initial read
    ok(), // ensureLabelExists (label create)
    ok(), // add-label
    ok(ghIssueViewLabelsClaimedMe), // recheck
  ]);
  const result = await tracker.claim('#42', 'me');
  assert.equal(result.ok, true);
  // every native call carries the bare number 42 (no #).
  for (const c of mock.calls) {
    if (c.includes('edit') || c.includes('view')) {
      assert.ok(c.includes('42') && !c.includes('#42'));
    }
  }
});

test('FORGE-130: parseIssueNumber rejects an unparseable id with VALIDATION', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.comment('not-an-issue', 'x'),
    (err: unknown) => err instanceof TrackerError && err.code === 'VALIDATION',
  );
});

test('FORGE-130: setBlockedBy widened input — GH-11 / #11 resolve to bare 11 in footer', async () => {
  for (const blockerRef of ['GH-11', '#11', '11']) {
    const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly), ok()]);
    await tracker.setBlockedBy('GH-42', blockerRef);
    const edit = mock.calls[1]!;
    const bodyArgIdx = edit.indexOf('--body');
    const body = bodyArgIdx >= 0 ? edit[bodyArgIdx + 1] : '';
    // footer stores BARE numbers; existing 10 plus new 11.
    assert.match(body ?? '', /forge:blockedBy=10,11/, `blockerRef ${blockerRef}`);
    // native edit call targets bare 42.
    assert.equal(edit[2], '42');
  }
});

test('FORGE-130: setBlockedBy dedup recognizes GH-10 against stored bare 10', async () => {
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly)]); // body has blockedBy=10
  await tracker.setBlockedBy('GH-42', 'GH-10');
  const edits = mock.calls.filter((c) => c.includes('edit'));
  assert.equal(edits.length, 0, 'GH-10 should dedup against stored 10');
});

// ─── assertValidBodyInput (shared helper, exercised via GitHub for convenience) ─

test('assertValidBodyInput accepts plain string under cap', () => {
  assertValidBodyInput('hello world', GH_ISSUE_BODY_MAX_BYTES);
  assertValidBodyInput('', GH_ISSUE_BODY_MAX_BYTES);
});

test('assertValidBodyInput rejects non-string with VALIDATION', () => {
  for (const bad of [42, null, undefined, {}, [], true]) {
    assert.throws(
      () => assertValidBodyInput(bad as unknown, 100),
      (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
    );
  }
});

test('assertValidBodyInput rejects embedded forge:task footer', () => {
  assert.throws(
    () =>
      assertValidBodyInput(
        'some body\n\n<!-- forge:task=FORGE-99 -->\n',
        GH_ISSUE_BODY_MAX_BYTES,
      ),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'VALIDATION' &&
      /forge-managed footer/.test(e.message),
  );
});

test('assertValidBodyInput rejects embedded forge:blockedBy footer', () => {
  assert.throws(
    () =>
      assertValidBodyInput(
        'body\n<!-- forge:blockedBy=10,11 -->\n',
        GH_ISSUE_BODY_MAX_BYTES,
      ),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'VALIDATION' &&
      /forge-managed footer/.test(e.message),
  );
});

test('assertValidBodyInput rejects ANY unknown forge:KEY footer (codex 2nd-pass regression)', () => {
  // Codex + claude reviewer flagged: rejecting only task/blockedBy let
  // callers smuggle `<!-- forge:ownerType=evil -->` past validation and
  // collide with the existing extra-footer preservation, producing two
  // contradictory ownerType comments on round-trip. Reject every forge:KEY.
  for (const key of ['ownerType', 'threshold', 'made-up-key', 'X']) {
    assert.throws(
      () =>
        assertValidBodyInput(
          `body\n<!-- forge:${key}=anything -->\n`,
          GH_ISSUE_BODY_MAX_BYTES,
        ),
      (e: unknown) =>
        e instanceof TrackerError &&
        e.code === 'VALIDATION' &&
        /forge-managed footer/.test(e.message),
      `must reject forge:${key}`,
    );
  }
});

test('assertValidBodyInput allows non-forge HTML comments', () => {
  assertValidBodyInput(
    'body with <!-- TODO --> and <!-- some-tool:meta=x --> comments',
    GH_ISSUE_BODY_MAX_BYTES,
  );
});

test('assertValidBodyInput rejects body over provider byte cap', () => {
  const tooBig = 'a'.repeat(GH_ISSUE_BODY_MAX_BYTES + 1);
  assert.throws(
    () => assertValidBodyInput(tooBig, GH_ISSUE_BODY_MAX_BYTES),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'VALIDATION' &&
      /exceeds provider limit/.test(e.message),
  );
});

test('assertValidBodyInput counts bytes (not chars) for multi-byte UTF-8', () => {
  // '👋' is 4 bytes in UTF-8. cap=3 → 4-byte single char must reject.
  assert.throws(
    () => assertValidBodyInput('👋', 3),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  // cap=4 → exact-fit must pass.
  assertValidBodyInput('👋', 4);
});

// ─── updateIssueBody (GitHub adapter) ────────────────────────────────────────

test('updateIssueBody replaces body and preserves forge:task footer (round-trip via parseForgeFooters)', async () => {
  // AC-as-unit-test: not just "the footer string appears" — actually parse
  // the resulting body back through parseForgeFooters and confirm the
  // tracker→forgeTaskId mapping round-trips. Codex/claude 2nd-pass.
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly), ok()]);
  await tracker.updateIssueBody('42', 'fresh body content');
  const edit = mock.calls[1];
  const bodyArgIdx = edit?.indexOf('--body') ?? -1;
  const newBody = bodyArgIdx >= 0 ? (edit?.[bodyArgIdx + 1] ?? '') : '';
  assert.match(newBody, /fresh body content/);
  const parsed = parseForgeFooters(newBody);
  assert.equal(parsed.forgeTaskId, 'FORGE-99', 'round-trip forgeTaskId');
  assert.deepEqual(parsed.blockerIds, ['10'], 'round-trip blockerIds');
});

test('updateIssueBody preserves forge:blockedBy footer through replace', async () => {
  // ghIssueViewBodyOnly has forge:blockedBy=10 already.
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly), ok()]);
  await tracker.updateIssueBody('42', 'replaced');
  const edit = mock.calls[1];
  const newBody = edit?.[edit.indexOf('--body') + 1] ?? '';
  assert.match(newBody, /forge:blockedBy=10/);
});

test('updateIssueBody preserves unknown forge:* footers (ownerType)', async () => {
  const bodyWithOwnerType = {
    body:
      'Original body.\n\n' +
      '<!-- forge:task=FORGE-7 -->\n' +
      '<!-- forge:ownerType=backend-dev -->\n' +
      '<!-- forge:blockedBy=10 -->\n',
  };
  const { tracker, mock } = makeTracker([ok(bodyWithOwnerType), ok()]);
  await tracker.updateIssueBody('42', 'overwritten');
  const edit = mock.calls[1];
  const newBody = edit?.[edit.indexOf('--body') + 1] ?? '';
  assert.match(newBody, /overwritten/);
  assert.match(newBody, /forge:task=FORGE-7/);
  assert.match(newBody, /forge:ownerType=backend-dev/);
  assert.match(newBody, /forge:blockedBy=10/);
});

test('updateIssueBody PRECONDITION_FAILED when no forge:task footer', async () => {
  const { tracker } = makeTracker([ok(ghIssueViewBodyMissingFooter)]);
  await assert.rejects(
    () => tracker.updateIssueBody('42', 'irrelevant'),
    (e: unknown) =>
      e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
  );
});

test('updateIssueBody VALIDATION on non-string body (no I/O issued)', async () => {
  const { tracker, mock } = makeTracker([]);
  await assert.rejects(
    () => tracker.updateIssueBody('42', 42 as unknown as string),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  assert.equal(mock.calls.length, 0, 'must reject before issuing any gh call');
});

test('updateIssueBody VALIDATION on embedded forge footer (no I/O issued)', async () => {
  const { tracker, mock } = makeTracker([]);
  await assert.rejects(
    () =>
      tracker.updateIssueBody(
        '42',
        'malicious\n<!-- forge:task=evil -->\n',
      ),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  assert.equal(mock.calls.length, 0);
});

// ─── setClaimFence (GitHub adapter, FORGE-167) ───────────────────────────────

test('setClaimFence stamps forge:claim via RAW gh edit, preserving forge:task', async () => {
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyOnly), ok()]);
  await tracker.setClaimFence('42', {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'run-1',
  });
  const edit = mock.calls[1];
  const newBody = edit?.[edit.indexOf('--body') + 1] ?? '';
  // RAW edit carried the forge:claim footer (updateIssueBody rejects such input).
  assert.deepEqual(parseClaimFooter(newBody), {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'run-1',
  });
  assert.match(newBody, /forge:task=FORGE-99/);
});

test('setClaimFence(null) strips forge:claim, preserves blockedBy + task', async () => {
  const bodyWithClaim = {
    body:
      'b\n\n<!-- forge:task=FORGE-9 -->\n<!-- forge:blockedBy=10 -->\n' +
      '<!-- forge:claim={"claim_id":"old","generation":1,"owner_run_id":"r0"} -->\n',
  };
  const { tracker, mock } = makeTracker([ok(bodyWithClaim), ok()]);
  await tracker.setClaimFence('42', null);
  const edit = mock.calls[1];
  const newBody = edit?.[edit.indexOf('--body') + 1] ?? '';
  assert.equal(parseClaimFooter(newBody), null);
  assert.match(newBody, /forge:blockedBy=10/);
  assert.match(newBody, /forge:task=FORGE-9/);
});

test('setClaimFence PRECONDITION_FAILED when no forge:task footer (no edit issued)', async () => {
  const { tracker, mock } = makeTracker([ok(ghIssueViewBodyMissingFooter)]);
  await assert.rejects(
    () =>
      tracker.setClaimFence('42', {
        claimId: 'c',
        generation: 0,
        ownerRunId: 'r',
      }),
    (e: unknown) =>
      e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
  );
  assert.equal(mock.calls.length, 1, 'view only; no edit after precondition');
});

// ─── FORGE-118: withRetry sweep + claim-token CAS (GitHub adapter) ────────────

const ghRateLimit = (): Error =>
  makeExecaError({
    stderr: 'API rate limit exceeded\nRetry-After: 1',
    exitCode: 1,
  });

test('setBlockedBy — retries on RATE_LIMITED then succeeds (FORGE-118)', async () => {
  // First view rate-limited; retry views, then edits.
  const { tracker, mock } = makeTracker([
    ghRateLimit(),
    ok(ghIssueViewBodyOnly),
    ok(),
  ]);
  await tracker.setBlockedBy('42', '11');
  assert.equal(mock.calls.length, 3, 'view(rl) → view → edit');
});

test('updateIssueBody — retries on RATE_LIMITED then succeeds (FORGE-118)', async () => {
  const { tracker, mock } = makeTracker([
    ghRateLimit(),
    ok(ghIssueViewBodyOnly),
    ok(),
  ]);
  await tracker.updateIssueBody('42', 'fresh body');
  assert.equal(mock.calls.length, 3);
});

test('setClaimFence — retries on RATE_LIMITED then succeeds (FORGE-118; parity with Linear)', async () => {
  const { tracker, mock } = makeTracker([
    ghRateLimit(),
    ok(ghIssueViewBodyOnly),
    ok(),
  ]);
  await tracker.setClaimFence('42', {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'run-1',
  });
  assert.equal(mock.calls.length, 3, 'setClaimFence now has withRetry');
});

test('updateIssueBody — expectedClaim refuses on mismatching forge:claim (CLAIM_MISMATCH, no edit)', async () => {
  const bodyWithOtherClaim = {
    body:
      'b\n\n<!-- forge:task=FORGE-9 -->\n' +
      '<!-- forge:claim={"claim_id":"other","generation":1,"owner_run_id":"r0"} -->\n',
  };
  const { tracker, mock } = makeTracker([ok(bodyWithOtherClaim)]);
  await assert.rejects(
    () =>
      tracker.updateIssueBody('42', 'new body', {
        expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
      }),
    (e: unknown) => e instanceof TrackerError && e.code === 'CLAIM_MISMATCH',
  );
  assert.equal(mock.calls.length, 1, 'view only; refused before edit');
});

test('updateIssueBody — expectedClaim proceeds when footer matches or is absent', async () => {
  // matching claim
  const matching = {
    body:
      'b\n\n<!-- forge:task=FORGE-9 -->\n' +
      '<!-- forge:claim={"claim_id":"mine","generation":2,"owner_run_id":"r1"} -->\n',
  };
  const m = makeTracker([ok(matching), ok()]);
  await m.tracker.updateIssueBody('42', 'new body', {
    expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
  });
  assert.equal(m.mock.calls.length, 2, 'matching → view + edit');

  // absent fence
  const n = makeTracker([ok(ghIssueViewBodyOnly), ok()]);
  await n.tracker.updateIssueBody('42', 'new body', {
    expectedClaim: { claimId: 'mine', generation: 2, ownerRunId: 'r1' },
  });
  assert.equal(n.mock.calls.length, 2, 'absent fence → view + edit');
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

// ─── FORGE-82: label-cap dehyphenation ───────────────────────────────────────

test('toStoredLabel: strips hyphens from UUIDv7 → 49-char label (FORGE-82)', () => {
  const result = toStoredLabel(FORGE_82_UUID);
  assert.equal(result, FORGE_82_STORED_LABEL);
  assert.equal(result.length, 49);
});

test('runIdFromStoredLabel: round-trips UUIDv7 through toStoredLabel (FORGE-82)', () => {
  const stored = toStoredLabel(FORGE_82_UUID);
  assert.equal(runIdFromStoredLabel(stored), FORGE_82_UUID);
});

test('classifyGitHubError → VALIDATION on "label not found / failed to update" stderr (FORGE-82)', () => {
  const err = makeExecaError({ stderr: ghLabelNotFoundError, exitCode: 1 });
  const hint = classifyGitHubError(err);
  assert.equal(hint.code, 'VALIDATION');
  assert.equal((hint.details as { reason?: string } | undefined)?.reason, 'label-not-found');
});

test('classifyGitHubError → VALIDATION still fires on HTTP 422 (regression guard — FORGE-82)', () => {
  const err = makeExecaError({ stderr: 'HTTP 422: validation failed', exitCode: 1 });
  assert.equal(classifyGitHubError(err).code, 'VALIDATION');
});

test('claim happy path: 36-char UUID runId → stored label uses 32-char hex suffix (no hyphens) (FORGE-82)', async () => {
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsEmpty),           // step 1: read labels
    ok(),                                  // ensureLabel `label create --force`
    ok(),                                  // gh issue edit --add-label
    ok(ghIssueViewLabelsClaimedMeStored), // step 4: re-read labels
  ]);
  const result = await tracker.claim('42', FORGE_82_UUID);
  assert.deepEqual(result, { ok: true });
  // The --add-label arg must use the dehyphenated stored form
  const addLabelCall = mock.calls.find((c) => c.includes('--add-label'));
  assert.ok(addLabelCall, 'expected an --add-label call');
  const labelArg = addLabelCall[addLabelCall.indexOf('--add-label') + 1];
  assert.equal(labelArg, FORGE_82_STORED_LABEL);
  // The UUID suffix (after the prefix) must contain no hyphens
  const suffix = (labelArg ?? '').slice('forge:claimed-by:'.length);
  assert.doesNotMatch(suffix, /-/);
});

test('claim: ensureLabel VALIDATION (422 cap) → version_conflict, does not throw (FORGE-82)', async () => {
  // Mock: initial read succeeds (no claims), then ensureLabel fails with VALIDATION (HTTP 422),
  // then claim() issue-edit also fails with label-not-found stderr.
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty),
    makeExecaError({ stderr: 'HTTP 422: label name too long', exitCode: 1 }),
    makeExecaError({ stderr: ghLabelNotFoundError, exitCode: 1 }),
  ]);
  const result = await tracker.claim('42', FORGE_82_UUID);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'version_conflict');
});

test('claim: "label not found / failed to update" on issue edit → version_conflict, does not throw (FORGE-82)', async () => {
  const { tracker } = makeTracker([
    ok(ghIssueViewLabelsEmpty),
    ok(), // ensureLabel succeeds
    makeExecaError({ stderr: ghLabelNotFoundError, exitCode: 1 }), // issue edit fails
  ]);
  const result = await tracker.claim('42', FORGE_82_UUID);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'version_conflict');
});

test('releaseClaim: uses stored (dehyphenated) label form in --remove-label arg (FORGE-82)', async () => {
  const { tracker, mock } = makeTracker([ok()]);
  await tracker.releaseClaim('42', FORGE_82_UUID);
  assert.equal(mock.calls.length, 1, 'expected exactly one gh invocation');
  const args = mock.calls[0];
  assert.ok(args?.includes('--remove-label'));
  const removedLabel = args[args.indexOf('--remove-label') + 1];
  assert.equal(removedLabel, FORGE_82_STORED_LABEL);
  // The UUID suffix (after the prefix) must contain no hyphens
  const suffix = (removedLabel ?? '').slice('forge:claimed-by:'.length);
  assert.doesNotMatch(suffix, /-/);
});

test('claim idempotent: stored label already on issue → ok:true without re-adding (FORGE-82)', async () => {
  // The initial read returns the stored-form label for our runId — no further calls needed.
  const { tracker, mock } = makeTracker([
    ok(ghIssueViewLabelsClaimedMeStored),
  ]);
  const result = await tracker.claim('42', FORGE_82_UUID);
  assert.deepEqual(result, { ok: true });
  const addLabelCalls = mock.calls.filter((c) => c.includes('--add-label'));
  assert.equal(addLabelCalls.length, 0, 'should not re-add label');
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

// ─── getCurrentRevision (FORGE-123) ──────────────────────────────────────────

test('getCurrentRevision — issues the updated-desc top-1 query and returns github:<iso>', async () => {
  const { tracker, mock } = makeTracker([
    ok([{ updatedAt: '2026-06-01T12:00:00Z' }]),
  ]);
  const rev = await tracker.getCurrentRevision();
  assert.equal(rev, 'github:2026-06-01T12:00:00Z');
  const args = mock.calls[0]!;
  assert.ok(args.includes('issue') && args.includes('list'));
  assert.equal(args[args.indexOf('--state') + 1], 'all');
  assert.equal(args[args.indexOf('--search') + 1], 'sort:updated-desc');
  assert.equal(args[args.indexOf('--limit') + 1], '1');
  assert.equal(args[args.indexOf('--json') + 1], 'updatedAt');
});

test('getCurrentRevision — empty repo returns github:none', async () => {
  const { tracker } = makeTracker([ok([])]);
  assert.equal(await tracker.getCurrentRevision(), 'github:none');
});
