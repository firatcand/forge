import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FatalEventSchema,
  NotificationEventSchema,
  QuestionEventSchema,
  QuestionResolvedEventSchema,
  isFatalEvent,
  isQuestionEvent,
  isQuestionResolvedEvent,
  parseEventLine,
  serializeEvent,
  tryParseEventLine,
  type NotificationEvent,
} from '../../src/orchestrator/events.ts';

function baseQuestionEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'question',
    ts: '2026-05-13T12:00:00.000Z',
    run_id: '0190000000000000r1',
    task_id: 'FORGE-20',
    question_id: '0190000000000000q1',
    decision_key: 'public-api:dispatcher-events:v1',
    attempt: 1,
    question: 'Pick a name for the dispatcher event union.',
    context: 'Three event types planned.',
    options: [
      { id: 'evt', label: 'NotificationEvent' },
      { id: 'msg', label: 'DispatcherMessage' },
    ],
    recommended_option_id: 'evt',
    what_happens_if_unanswered: 'Worker uses NotificationEvent as the autonomous fallback.',
    ...overrides,
  };
}

function baseResolvedEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'question_resolved',
    ts: '2026-05-13T12:05:00.000Z',
    run_id: '0190000000000000r1',
    task_id: 'FORGE-20',
    question_id: '0190000000000000q1',
    resolution: 'answered',
    answer_option_id: 'evt',
    ...overrides,
  };
}

function baseFatalEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: 'fatal',
    ts: '2026-05-13T13:00:00.000Z',
    run_id: '0190000000000000r1',
    reason: 'Tracker unreachable past retry cap.',
    details: { last_error: 'ECONNREFUSED' },
    ...overrides,
  };
}

test('QuestionEventSchema accepts a valid event', () => {
  const result = QuestionEventSchema.safeParse(baseQuestionEvent());
  assert.equal(result.success, true);
});

test('QuestionEventSchema rejects unknown type', () => {
  const result = QuestionEventSchema.safeParse(baseQuestionEvent({ type: 'phase_transition' }));
  assert.equal(result.success, false);
});

test('QuestionEventSchema rejects empty options', () => {
  const result = QuestionEventSchema.safeParse(baseQuestionEvent({ options: [] }));
  assert.equal(result.success, false);
});

test('QuestionResolvedEventSchema accepts each resolution', () => {
  for (const resolution of ['answered', 'expired', 'budget_exhausted', 'duplicate']) {
    const result = QuestionResolvedEventSchema.safeParse(
      baseResolvedEvent({ resolution }),
    );
    assert.equal(result.success, true, `resolution=${resolution}`);
  }
});

test('QuestionResolvedEventSchema rejects unknown resolution', () => {
  const result = QuestionResolvedEventSchema.safeParse(
    baseResolvedEvent({ resolution: 'maybe' }),
  );
  assert.equal(result.success, false);
});

test('FatalEventSchema accepts a valid event', () => {
  const result = FatalEventSchema.safeParse(baseFatalEvent());
  assert.equal(result.success, true);
});

test('NotificationEventSchema discriminates by type', () => {
  const q = NotificationEventSchema.safeParse(baseQuestionEvent());
  const r = NotificationEventSchema.safeParse(baseResolvedEvent());
  const f = NotificationEventSchema.safeParse(baseFatalEvent());
  assert.equal(q.success, true);
  assert.equal(r.success, true);
  assert.equal(f.success, true);
});

test('NotificationEventSchema rejects events with unrecognized type', () => {
  const result = NotificationEventSchema.safeParse({
    ...baseQuestionEvent(),
    type: 'heartbeat',
  });
  assert.equal(result.success, false);
});

test('serializeEvent round-trips through parseEventLine', () => {
  const event = QuestionEventSchema.parse(baseQuestionEvent()) as NotificationEvent;
  const line = serializeEvent(event);
  const parsed = parseEventLine(line);
  assert.deepEqual(parsed, event);
});

test('serializeEvent throws on a malformed event', () => {
  const broken = {
    ...baseQuestionEvent(),
    options: [],
  } as unknown as NotificationEvent;
  assert.throws(() => serializeEvent(broken));
});

test('parseEventLine returns null for empty lines', () => {
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   \n'), null);
});

test('parseEventLine throws on invalid JSON', () => {
  assert.throws(() => parseEventLine('not json'));
});

test('parseEventLine throws on JSON that does not match the schema', () => {
  assert.throws(() => parseEventLine(JSON.stringify({ type: 'mystery' })));
});

test('tryParseEventLine returns ok=true with null event on empty', () => {
  const result = tryParseEventLine('');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event, null);
});

test('tryParseEventLine returns ok=false on invalid JSON without throwing', () => {
  const result = tryParseEventLine('garbage');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /invalid JSON/);
    assert.equal(result.raw, 'garbage');
  }
});

test('tryParseEventLine returns ok=false on schema mismatch', () => {
  const result = tryParseEventLine(JSON.stringify({ type: 'mystery' }));
  assert.equal(result.ok, false);
});

test('tryParseEventLine returns parsed event on the happy path', () => {
  const event = NotificationEventSchema.parse(baseQuestionEvent()) as NotificationEvent;
  const result = tryParseEventLine(serializeEvent(event));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.event, event);
});

test('type guards correctly discriminate the union', () => {
  const q = NotificationEventSchema.parse(baseQuestionEvent()) as NotificationEvent;
  const r = NotificationEventSchema.parse(baseResolvedEvent()) as NotificationEvent;
  const f = NotificationEventSchema.parse(baseFatalEvent()) as NotificationEvent;
  assert.equal(isQuestionEvent(q), true);
  assert.equal(isQuestionEvent(r), false);
  assert.equal(isQuestionEvent(f), false);
  assert.equal(isQuestionResolvedEvent(r), true);
  assert.equal(isQuestionResolvedEvent(q), false);
  assert.equal(isFatalEvent(f), true);
  assert.equal(isFatalEvent(q), false);
});
