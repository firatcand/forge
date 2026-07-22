import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsSchema } from '../../src/schemas/settings.ts';
import { ShipRecordSchema } from '../../src/schemas/ship-record.ts';
import { AttemptManifestSchema } from '../../src/schemas/attempt.ts';
import { PinnedReviewVerdictSchema, ReviewVerdictSchema } from '../../src/schemas/verdict.ts';
import { TaskStateSchema } from '../../src/schemas/task-state.ts';

const SHA = 'a'.repeat(40);

// ---- settings ship: block ----

const MINIMAL_SETTINGS = {
  version: 1,
  project: { name: 'x' },
  tracker: { type: 'github', config: { repo: 'o/r' } },
  secrets: { manager: 'env_file' },
};

test('ShipSchema: absent block defaults to approval', () => {
  const parsed = SettingsSchema.parse(MINIMAL_SETTINGS);
  assert.equal(parsed.ship.merge_policy, 'approval');
});

test('ShipSchema: auto + null review host is rejected at [ship, merge_policy]', () => {
  const res = SettingsSchema.safeParse({
    ...MINIMAL_SETTINGS,
    agents: { review_host_cli: null },
    ship: { merge_policy: 'auto' },
  });
  assert.equal(res.success, false);
  if (!res.success) {
    const issue = res.error.issues.find((i) => i.path.join('.') === 'ship.merge_policy');
    assert.ok(issue, 'expected issue at ship.merge_policy');
    assert.match(issue.message, /dual-host/);
  }
});

test('ShipSchema: auto + codex review host is accepted', () => {
  const parsed = SettingsSchema.parse({
    ...MINIMAL_SETTINGS,
    agents: { review_host_cli: 'codex' },
    ship: { merge_policy: 'auto' },
  });
  assert.equal(parsed.ship.merge_policy, 'auto');
});

test('SettingsSchema is ZodEffects after superRefine — parse/safeParse still work (no .shape/.extend on the export)', () => {
  // Document the shape change: the first-ever top-level refinement makes the
  // exported schema a ZodEffects wrapper. Consumers must use parse/safeParse;
  // .shape/.extend are no longer available on the export.
  assert.equal(typeof SettingsSchema.parse, 'function');
  assert.equal(typeof SettingsSchema.safeParse, 'function');
  assert.equal((SettingsSchema as unknown as { shape?: unknown }).shape, undefined);
});

// ---- ship record ----

function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    task_id: 'T-1',
    revision: 1,
    reviewed_head_sha: SHA,
    review_attempt_id: 'att-1',
    base: null,
    pr: null,
    merge_attempt: 'not_started',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('ShipRecordSchema: progressive init — reviewed binding only', () => {
  assert.equal(ShipRecordSchema.safeParse(baseRecord()).success, true);
});

test('ShipRecordSchema: pr requires base', () => {
  const res = ShipRecordSchema.safeParse(
    baseRecord({ pr: { repo: 'o/r', number: 1, url: 'https://x.test/1' } }),
  );
  assert.equal(res.success, false);
});

test('ShipRecordSchema: merge_attempt beyond not_started requires pr', () => {
  const res = ShipRecordSchema.safeParse(baseRecord({ merge_attempt: 'attempting' }));
  assert.equal(res.success, false);
});

test('ShipRecordSchema: pr.repo must equal base.repo', () => {
  const res = ShipRecordSchema.safeParse(
    baseRecord({
      base: { repo: 'o/r', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'evil/other', number: 1, url: 'https://x.test/1' },
    }),
  );
  assert.equal(res.success, false);
  const ok = ShipRecordSchema.safeParse(
    baseRecord({
      base: { repo: 'o/r', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'o/r', number: 1, url: 'https://x.test/1' },
    }),
  );
  assert.equal(ok.success, true);
});

test('ShipRecordSchema: no "merged" value exists for merge_attempt', () => {
  const res = ShipRecordSchema.safeParse(baseRecord({ merge_attempt: 'merged' }));
  assert.equal(res.success, false);
});

// ---- attempt manifest ----

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    attempt_id: 'att-1',
    task_id: 'T-1',
    run_id: 'run-1',
    claim_id: 'claim-1',
    generation: 0,
    worktree_path: '/tmp/wt',
    dispatched_at: new Date().toISOString(),
    ...overrides,
  };
}

test('AttemptManifestSchema: legacy manifest without phase defaults to implement', () => {
  const parsed = AttemptManifestSchema.parse(baseManifest());
  assert.equal(parsed.phase, 'implement');
});

test('AttemptManifestSchema: review phase requires BOTH pinned SHAs', () => {
  assert.equal(AttemptManifestSchema.safeParse(baseManifest({ phase: 'review' })).success, false);
  assert.equal(
    AttemptManifestSchema.safeParse(baseManifest({ phase: 'review', review_target_sha: SHA })).success,
    false,
  );
  assert.equal(
    AttemptManifestSchema.safeParse(
      baseManifest({ phase: 'review', review_target_sha: SHA, review_base_sha: 'b'.repeat(40) }),
    ).success,
    true,
  );
});

// ---- pinned review verdict ----

const RAW_REVIEW = {
  version: 1,
  verdict: 'pass',
  findings: [],
  host: 'codex',
};

test('ReviewVerdictSchema: target_sha stays optional (interactive flows unpinned)', () => {
  assert.equal(ReviewVerdictSchema.safeParse(RAW_REVIEW).success, true);
  const withSha = ReviewVerdictSchema.parse({ ...RAW_REVIEW, target_sha: SHA });
  assert.equal(withSha.target_sha, SHA, 'target_sha must pass through, not be stripped');
});

test('PinnedReviewVerdictSchema: target_sha is REQUIRED and 40-hex', () => {
  assert.equal(PinnedReviewVerdictSchema.safeParse(RAW_REVIEW).success, false);
  assert.equal(
    PinnedReviewVerdictSchema.safeParse({ ...RAW_REVIEW, target_sha: 'abc123' }).success,
    false,
  );
  assert.equal(PinnedReviewVerdictSchema.safeParse({ ...RAW_REVIEW, target_sha: SHA }).success, true);
});

// ---- task-state new fields ----

test('TaskStateSchema: legacy records parse with defaulted FORGE-231 fields', () => {
  const legacy = {
    version: 1,
    task_id: 'T-1',
    state: 'running',
    state_version: 3,
    attempt_count: 1,
    current_attempt_id: 'att-1',
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
  };
  const parsed = TaskStateSchema.parse(legacy);
  assert.equal(parsed.failure_count, 0);
  assert.equal(parsed.last_failure_key, null);
  assert.equal(parsed.review_attempt_count, 0);
  assert.equal(parsed.ship_attempt_count, 0);
});

test('TaskStateSchema: merge_pending is a legal, non-terminal state', () => {
  const parsed = TaskStateSchema.parse({
    version: 1,
    task_id: 'T-1',
    state: 'merge_pending',
    state_version: 9,
    attempt_count: 1,
    failure_count: 0,
    last_failure_key: null,
    review_attempt_count: 1,
    ship_attempt_count: 1,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
  });
  assert.equal(parsed.state, 'merge_pending');
});
