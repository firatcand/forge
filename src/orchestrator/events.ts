import { z } from 'zod';
import { QuestionOptionSchema } from '../schemas/questions.ts';

// The notification stream is the supervisor-facing channel. Per ORCHESTRATOR.md
// it carries the question / question_resolved / fatal events plus (FORGE-231)
// the three PROGRESS events: ready_for_review, merge_pending, shipped.
// Operational events (heartbeats, retry timing, worker stdout) live in
// orchestrator.jsonl and per-worker logs — never on this stream.
//
// FORGE-231 loss semantics (owner decision NL): the three PROGRESS events are
// ADVISORY — emission runs strictly AFTER the task-state CAS, a crash in the
// window loses the event PERMANENTLY, and that is ACCEPTED; authoritative
// discovery is state-derived listing (review-queue, status/dashboard).
// `fatal` and `question` keep their existing durable semantics (questions are
// durable files + queues; this stream is only their announcement).
//
// Every variant carries an `id` for reader-side dedup: OPTIONAL on the read
// union (legacy files parse), REQUIRED at write time (NewNotificationEventSchema)
// and computed by the append helper — producers never invent ids.

const TimestampField = z.string().datetime();
const IdField = z.string().min(1).max(200).optional();

export const QuestionEventSchema = z.object({
  type: z.literal('question'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  question_id: z.string().min(1).max(64),
  decision_key: z.string().min(1).max(200),
  attempt: z.number().int().min(1).max(100),
  question: z.string().min(1).max(4_000),
  context: z.string().max(8_000).default(''),
  options: z.array(QuestionOptionSchema).min(2).max(10),
  recommended_option_id: z.string().min(1).max(64).optional(),
  what_happens_if_unanswered: z.string().max(2_000).optional(),
});

export const QUESTION_RESOLUTIONS = [
  'answered',
  'expired',
  'budget_exhausted',
  'duplicate',
] as const;

export const QuestionResolvedEventSchema = z.object({
  type: z.literal('question_resolved'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  question_id: z.string().min(1).max(64),
  resolution: z.enum(QUESTION_RESOLUTIONS),
  answer_option_id: z.string().min(1).max(64).optional(),
});

export const FatalEventSchema = z.object({
  type: z.literal('fatal'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  reason: z.string().min(1).max(2_000),
  details: z.record(z.string(), z.unknown()).optional(),
});

// FORGE-231 progress events (advisory — see the loss-semantics note above).
export const ReadyForReviewEventSchema = z.object({
  type: z.literal('ready_for_review'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  state_version: z.number().int().min(0),
});

export const MergePendingEventSchema = z.object({
  type: z.literal('merge_pending'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  state_version: z.number().int().min(0),
  pr_url: z.string().url(),
  auto_merge: z.boolean(),
});

export const ShippedEventSchema = z.object({
  type: z.literal('shipped'),
  id: IdField,
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  state_version: z.number().int().min(0),
  pr_url: z.string().url(),
});

export const NotificationEventSchema = z.discriminatedUnion('type', [
  QuestionEventSchema,
  QuestionResolvedEventSchema,
  FatalEventSchema,
  ReadyForReviewEventSchema,
  MergePendingEventSchema,
  ShippedEventSchema,
]);

// Write-side schema: identical union, but `id` is REQUIRED — every producer
// goes through appendNotificationEvent, which computes it.
export const NewNotificationEventSchema = NotificationEventSchema.refine(
  (e) => typeof e.id === 'string' && e.id.length > 0,
  { message: 'new notification events must carry a computed id', path: ['id'] },
);

export type QuestionEvent = z.infer<typeof QuestionEventSchema>;
export type QuestionResolvedEvent = z.infer<typeof QuestionResolvedEventSchema>;
export type FatalEvent = z.infer<typeof FatalEventSchema>;
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export type QuestionResolution = (typeof QUESTION_RESOLUTIONS)[number];

// Serialize an event to a single JSONL line. Caller is responsible for
// appending the trailing newline character separator when writing to a stream.
// We expose the unterminated form so the caller picks the line discipline (LF
// vs CRLF, batched vs single write).
export function serializeEvent(event: NotificationEvent): string {
  // Validate at the boundary. We do NOT trust that the producer constructed a
  // valid event — a typo in attempt count or a missing option could silently
  // corrupt the supervisor experience. Throw before bytes hit the stream.
  NotificationEventSchema.parse(event);
  return JSON.stringify(event);
}

// Parse one JSONL line. Returns null for empty lines (a benign tail in
// append-only streams). Throws for any other malformed/invalid payload — the
// caller decides whether to surface the error or skip the line.
export function parseEventLine(line: string): NotificationEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parsed: unknown = JSON.parse(trimmed);
  return NotificationEventSchema.parse(parsed);
}

// Tail-style parser: best-effort, never throws. Returns a typed event or an
// error result with the offending payload preserved for logging. Used by the
// CLI subcommands that attach to a live stream where a single corrupt line
// must not crash the supervisor.
export type ParseLineResult =
  | { ok: true; event: NotificationEvent }
  | { ok: true; event: null }
  | { ok: false; error: string; raw: string };

export function tryParseEventLine(line: string): ParseLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: true, event: null };
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw: trimmed,
    };
  }
  const result = NotificationEventSchema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.message, raw: trimmed };
  }
  return { ok: true, event: result.data };
}

// Type guard helpers. These exist because the dispatcher and CLI both branch on
// event.type frequently; centralizing the predicates avoids drift if the union
// grows in v0.4.0.
export function isQuestionEvent(event: NotificationEvent): event is QuestionEvent {
  return event.type === 'question';
}

export function isQuestionResolvedEvent(
  event: NotificationEvent,
): event is QuestionResolvedEvent {
  return event.type === 'question_resolved';
}

export function isFatalEvent(event: NotificationEvent): event is FatalEvent {
  return event.type === 'fatal';
}

// ---------------------------------------------------------------------------
// FORGE-231: id computation + the append helper (the ONLY writer).
// ---------------------------------------------------------------------------

import { mkdirSync as _mkdirSync, openSync as _openSync, writeSync as _writeSync, closeSync as _closeSync } from 'node:fs';
import path from 'node:path';

// Per-variant id formulas. Time-free wherever a stable natural key exists:
// - progress events:    <task_id>:<state_version>:<type>  (the state CAS makes
//                        state_version unique per transition)
// - question:           <task_id>:<question_id>:question
// - question_resolved:  <task_id>:<question_id>:question_resolved
// - fatal:              <task_id ?? run_id>:<occurred_at_ms>:fatal when no
//                        natural key exists; a KEYED fatal (details.task_id +
//                        details.failure_key — retry exhaustion) gets the
//                        time-free <task_id>:<failure_key>:fatal instead so
//                        replayed re-emissions dedup
export function computeNotificationId(event: NotificationEvent): string {
  switch (event.type) {
    case 'ready_for_review':
    case 'merge_pending':
    case 'shipped':
      return `${event.task_id}:${event.state_version}:${event.type}`;
    case 'question':
      return `${event.task_id}:${event.question_id}:question`;
    case 'question_resolved':
      return `${event.task_id}:${event.question_id}:question_resolved`;
    case 'fatal': {
      // A fatal carrying a natural key in details (task_id + failure_key) gets
      // a TIME-FREE deterministic id so a crash-replayed producer re-emitting
      // the same terminal failure dedups instead of duplicating (impl R2 MAJ-4).
      const d = event.details as { task_id?: unknown; failure_key?: unknown } | undefined;
      if (typeof d?.task_id === 'string' && typeof d?.failure_key === 'string') {
        return `${d.task_id}:${d.failure_key}:fatal`;
      }
      const anchor = 'task_id' in event && typeof (event as { task_id?: unknown }).task_id === 'string'
        ? String((event as { task_id?: unknown }).task_id)
        : event.run_id;
      return `${anchor}:${Date.parse(event.ts)}:fatal`;
    }
  }
}

// Append ONE validated event line to a run's notifications.jsonl. The id is
// computed here (producers never supply it); the write is a single O_APPEND
// of one line — best-effort atomicity on a local FS; the reader (attach) is
// line-oriented and tolerates a torn final line.
export function appendNotificationEvent(
  forgeDir: string,
  runId: string,
  event: NotificationEvent,
): void {
  const withId: NotificationEvent = { ...event, id: computeNotificationId(event) };
  NewNotificationEventSchema.parse(withId);
  const dir = path.join(forgeDir, 'orchestrator', 'runs', runId);
  _mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = _openSync(path.join(dir, 'notifications.jsonl'), 'a', 0o600);
  try {
    _writeSync(fd, `${JSON.stringify(withId)}\n`, null, 'utf8');
  } finally {
    _closeSync(fd);
  }
}
