import { z } from 'zod';

// Stable JSON envelope returned by every `forge orchestrate` verb when --json is set.
// Mirrors spec/ORCHESTRATOR.md §CLI surface — "{ ok, data?, error?: { code, message, retriable } }".

export type ErrorEnvelope = {
  code: string;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
};

export type Envelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorEnvelope };

export const ErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retriable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export const EnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: ErrorEnvelopeSchema }),
]);

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  retriable: boolean,
  details?: Record<string, unknown>,
): Envelope<never> {
  return {
    ok: false,
    error: details ? { code, message, retriable, details } : { code, message, retriable },
  };
}

// Write an envelope to stdout (when --json) or a human-readable form otherwise.
// Returns the exit code the caller should pass to process.exit.
export function emit(envelope: Envelope, opts: { json: boolean; humanRender?: (e: Envelope) => string }): number {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (opts.humanRender) {
    process.stdout.write(opts.humanRender(envelope));
  } else {
    if (envelope.ok) {
      process.stdout.write(`${JSON.stringify(envelope.data, null, 2)}\n`);
    } else {
      process.stderr.write(`forge: ${envelope.error.code}: ${envelope.error.message}\n`);
    }
  }
  if (envelope.ok) return 0;
  // Generic mapping: retriable + non-retriable both exit 1; verbs that want
  // a different code (e.g., doctor's "2 = drift") return it explicitly.
  return 1;
}
