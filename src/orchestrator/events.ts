import { z } from 'zod';
import { QuestionOptionSchema } from '../schemas/questions.ts';

// The notification stream is the supervisor-facing channel. Per ORCHESTRATOR.md
// it carries exactly three event types. Operational events (heartbeats, retry
// timing, ship completions, worker stdout) live in orchestrator.jsonl and per-
// worker logs — never on this stream. The narrow surface is the contract.

const TimestampField = z.string().datetime();

export const QuestionEventSchema = z.object({
  type: z.literal('question'),
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
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  question_id: z.string().min(1).max(64),
  resolution: z.enum(QUESTION_RESOLUTIONS),
  answer_option_id: z.string().min(1).max(64).optional(),
});

export const FatalEventSchema = z.object({
  type: z.literal('fatal'),
  ts: TimestampField,
  run_id: z.string().min(1).max(64),
  reason: z.string().min(1).max(2_000),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const NotificationEventSchema = z.discriminatedUnion('type', [
  QuestionEventSchema,
  QuestionResolvedEventSchema,
  FatalEventSchema,
]);

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
