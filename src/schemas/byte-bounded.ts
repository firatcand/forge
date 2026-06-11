import { z } from 'zod';

// FORGE-83: UTF-8 byte-bounded string schemas + byte-safe truncation.
//
// Several attempt/verdict fields cap free-text excerpts to bound on-disk JSONL
// growth. Those caps are byte budgets, not UTF-16-code-unit budgets: a `.max(N)`
// on a zod string counts code units (String.length), so multibyte content (CJK,
// emoji) slips well past the intended byte budget. `byteBoundedString` enforces
// the true UTF-8 byte length; `truncateUtf8` truncates producer-side input to a
// byte budget without ever splitting a code point.

/**
 * A string schema that enforces a true UTF-8 byte-length cap.
 *
 * The `.max(maxBytes)` is kept as a cheap pre-filter: UTF-8 byte length is
 * always >= UTF-16 code-unit length (String.length), so the pre-filter never
 * rejects anything the refine would accept — it only short-circuits obviously
 * oversized inputs before the Buffer.byteLength pass runs.
 *
 * `opts.min` preserves existing non-empty constraints (`.min(1)`).
 */
export function byteBoundedString(maxBytes: number, opts?: { min?: number }): z.ZodString | z.ZodEffects<z.ZodString, string, string> {
  const min = opts?.min ?? 0;
  const base = z.string().min(min).max(maxBytes);
  return base.refine((s) => Buffer.byteLength(s, 'utf8') <= maxBytes, {
    message: `must be <= ${maxBytes} UTF-8 bytes`,
  });
}

/**
 * Truncate `s` so its UTF-8 byte length is <= `maxBytes`, never splitting a
 * Unicode code point (and therefore never splitting a surrogate pair).
 *
 * Correctness notes:
 * - Iterating with `for...of` yields whole code points, so a 4-byte emoji or a
 *   3-byte CJK character is kept or dropped atomically — never half-written.
 * - Combining marks are independent code points; this truncates on a code-point
 *   boundary, which may drop a trailing combining mark but never produces an
 *   invalid byte sequence. That is the correct guarantee for a byte cap.
 * - Idempotent on already-short strings (returns the input unchanged).
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // Fast path: already within budget.
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;

  let bytes = 0;
  let out = '';
  for (const cp of s) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    if (bytes + cpBytes > maxBytes) break;
    bytes += cpBytes;
    out += cp;
  }
  return out;
}
