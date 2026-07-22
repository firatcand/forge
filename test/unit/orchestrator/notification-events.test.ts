import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNotificationEvent,
  computeNotificationId,
  NotificationEventSchema,
  type NotificationEvent,
} from '../../../src/orchestrator/events.ts';

const TS = '2026-07-22T12:00:00.000Z';

test('computeNotificationId: per-variant formulas (time-free where a natural key exists)', () => {
  assert.equal(
    computeNotificationId({
      type: 'ready_for_review',
      ts: TS,
      run_id: 'r1',
      task_id: 'T-1',
      state_version: 7,
    } as NotificationEvent),
    'T-1:7:ready_for_review',
  );
  assert.equal(
    computeNotificationId({
      type: 'question',
      ts: TS,
      run_id: 'r1',
      task_id: 'T-1',
      question_id: 'q9',
      decision_key: 'k',
      attempt: 1,
      question: '?',
      context: '',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    } as NotificationEvent),
    'T-1:q9:question',
  );
  assert.equal(
    computeNotificationId({ type: 'fatal', ts: TS, run_id: 'r1', reason: 'x' } as NotificationEvent),
    `r1:${Date.parse(TS)}:fatal`,
  );
});

test('appendNotificationEvent: computes the id, validates, and appends one line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-notif-'));
  try {
    appendNotificationEvent(dir, 'run-1', {
      type: 'merge_pending',
      ts: TS,
      run_id: 'run-1',
      task_id: 'T-1',
      state_version: 9,
      pr_url: 'https://example.test/pr/7',
      auto_merge: true,
    } as NotificationEvent);
    const lines = readFileSync(join(dir, 'orchestrator/runs/run-1/notifications.jsonl'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 1);
    const parsed = NotificationEventSchema.parse(JSON.parse(lines[0]!));
    assert.equal(parsed.id, 'T-1:9:merge_pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read union: legacy events without id still parse', () => {
  const legacy = {
    type: 'fatal',
    ts: TS,
    run_id: 'r1',
    reason: 'legacy',
  };
  assert.equal(NotificationEventSchema.safeParse(legacy).success, true);
});
