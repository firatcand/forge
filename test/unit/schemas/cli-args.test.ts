import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskIdSchema,
  RunIdSchema,
  ClaimIdSchema,
  AttemptIdSchema,
  DecisionKeySchema,
  ClaimArgsSchema,
  DispatchArgsSchema,
  HeartbeatArgsSchema,
  QuestionWriteArgsSchema,
  EventArgsSchema,
  CompleteArgsSchema,
  CancelArgsSchema,
  RunStartArgsSchema,
  RunListArgsSchema,
  PhasesArgsSchema,
  DoctorArgsSchema,
} from '../../../src/schemas/cli-args.ts';

const VALID_UUIDV7 = '01890bb1-cf24-7a1f-9c4f-d4b4f51d28b9';

test('TaskIdSchema accepts FORGE-96 / ABC-1', () => {
  assert.equal(TaskIdSchema.safeParse('FORGE-96').success, true);
  assert.equal(TaskIdSchema.safeParse('ABC-1').success, true);
  assert.equal(TaskIdSchema.safeParse('forge-96').success, false); // must be uppercase
  assert.equal(TaskIdSchema.safeParse('FORGE96').success, false); // requires hyphen
});

test('RunIdSchema / ClaimIdSchema / AttemptIdSchema accept a UUIDv7', () => {
  for (const schema of [RunIdSchema, ClaimIdSchema, AttemptIdSchema]) {
    assert.equal(schema.safeParse(VALID_UUIDV7).success, true);
    // v4 UUID has '4' in the version nibble — must be rejected.
    const v4 = '01890bb1-cf24-4a1f-9c4f-d4b4f51d28b9';
    assert.equal(schema.safeParse(v4).success, false);
  }
});

test('DecisionKeySchema enforces lowercase-friendly format', () => {
  assert.equal(DecisionKeySchema.safeParse('drift:spec-vs-impl:lease-ttl:abc123').success, true);
  assert.equal(DecisionKeySchema.safeParse('UPPER').success, false);
  assert.equal(DecisionKeySchema.safeParse('-leading').success, false);
});

test('ClaimArgsSchema requires taskId + runId + forgeDir', () => {
  const ok = ClaimArgsSchema.safeParse({
    taskId: 'FORGE-1',
    runId: VALID_UUIDV7,
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(ok.success, true);
  const bad = ClaimArgsSchema.safeParse({ taskId: 'forge-1', runId: VALID_UUIDV7, forgeDir: '/tmp/.forge', json: false });
  assert.equal(bad.success, false);
});

test('DispatchArgsSchema defaults phase to implement', () => {
  const parsed = DispatchArgsSchema.parse({
    taskId: 'FORGE-1',
    claimId: VALID_UUIDV7,
    runId: VALID_UUIDV7,
    worktreePath: '/tmp/worktree',
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(parsed.phase, 'implement');
});

test('HeartbeatArgsSchema requires attempt_id', () => {
  const ok = HeartbeatArgsSchema.safeParse({
    taskId: 'FORGE-1',
    attemptId: VALID_UUIDV7,
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(ok.success, true);
});

test('QuestionWriteArgsSchema accepts optional drift fields', () => {
  const ok = QuestionWriteArgsSchema.safeParse({
    taskId: 'FORGE-1',
    attemptId: VALID_UUIDV7,
    decisionKey: 'drift:a-vs-b:foo:hash',
    question: 'Which path?',
    optionsFile: '/tmp/options.json',
    driftEventId: 'evt-1',
    routingHint: 'amend-roadmap',
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(ok.success, true);
});

test('EventArgsSchema accepts arbitrary data records', () => {
  const ok = EventArgsSchema.safeParse({
    taskId: 'FORGE-1',
    attemptId: VALID_UUIDV7,
    type: 'drift',
    data: { from: 'spec', to: 'phases' },
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(ok.success, true);
});

test('CompleteArgsSchema requires verdictFile', () => {
  const ok = CompleteArgsSchema.safeParse({
    taskId: 'FORGE-1',
    attemptId: VALID_UUIDV7,
    verdictFile: '/tmp/verdict.json',
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(ok.success, true);
  const bad = CompleteArgsSchema.safeParse({
    taskId: 'FORGE-1',
    attemptId: VALID_UUIDV7,
    forgeDir: '/tmp/.forge',
    json: false,
  });
  assert.equal(bad.success, false);
});

test('CancelArgsSchema accepts optional reason', () => {
  const ok = CancelArgsSchema.safeParse({ taskId: 'FORGE-1', forgeDir: '/tmp/.forge', json: false });
  assert.equal(ok.success, true);
});

test('RunStartArgsSchema accepts optional name', () => {
  const ok = RunStartArgsSchema.safeParse({ forgeDir: '/tmp/.forge', json: false });
  assert.equal(ok.success, true);
  const okNamed = RunStartArgsSchema.safeParse({ forgeDir: '/tmp/.forge', json: false, name: 'x' });
  assert.equal(okNamed.success, true);
});

test('RunListArgsSchema defaults active to false', () => {
  const parsed = RunListArgsSchema.parse({ forgeDir: '/tmp/.forge', json: false });
  assert.equal(parsed.active, false);
});

test('PhasesArgsSchema accepts the phase filter values', () => {
  for (const phase of ['implement', 'review', 'ship'] as const) {
    const r = PhasesArgsSchema.safeParse({ forgeDir: '/tmp/.forge', json: false, ready: true, phase });
    assert.equal(r.success, true);
  }
  const bad = PhasesArgsSchema.safeParse({ forgeDir: '/tmp/.forge', json: false, ready: true, phase: 'wrong' });
  assert.equal(bad.success, false);
});

test('DoctorArgsSchema defaults scope to spec-code', () => {
  const parsed = DoctorArgsSchema.parse({ forgeDir: '/tmp/.forge', json: false });
  assert.equal(parsed.scope, 'spec-code');
});
