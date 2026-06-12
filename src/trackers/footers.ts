// Shared HTML-comment footer pump for tracker descriptions/bodies.
//
// Trackers store forge metadata as HTML comments in the issue body/description
// because every supported provider preserves them verbatim. Two known footers:
//
//   <!-- forge:task=<forgeTaskId> -->
//   <!-- forge:blockedBy=<id1>,<id2>,... -->
//
// Adapters may emit additional footers (e.g. forge:ownerType) via extraFooters.
// The capture regex is intentionally permissive ([^>]*?) so it accepts numeric
// GitHub issue numbers AND Linear UUIDs/identifiers ('FORGE-42', '7f3a-...').
// Adapter-side validation enforces format at write time.

import { TrackerError } from './errors.ts';
import {
  decodeClaimValue,
  encodeClaimValue,
  type ClaimFenceData,
} from './claim-fence.ts';

const FORGE_TASK_RE = /<!--\s*forge:task=([^\s>]+?)\s*-->/;
const FORGE_BLOCKED_RE = /<!--\s*forge:blockedBy=([^>]*?)\s*-->/;
// Caller-input rejection: ANY `<!--\s*forge:KEY` regardless of which KEY.
// Stricter than (FORGE_TASK_RE|FORGE_BLOCKED_RE) because unknown forge keys
// (e.g. `forge:ownerType`) collide with adapter-managed extra-footer
// preservation and would silently double on round-trip. Code-reviewer +
// codex 2nd-pass converged on this (FORGE-94 review).
const FORGE_ANY_INPUT_RE = /<!--\s*forge:[A-Za-z]/;
// forge:claim footer (FORGE-145) — mirrors the local lease identity onto the
// tracker so gc can detect tracker/local claim divergence. Value is the JSON
// from claim-fence.ts. Rides the extra-footer machinery (auto-preserved across
// body rewrites + reconcile --push).
const FORGE_CLAIM_RE = /<!--\s*forge:claim=([\s\S]*?)\s*-->/;
// One single `<!-- forge:KEY=VALUE -->` comment, anchored (no /g) — used to
// peel comments off the trailing region one at a time. Value capture is
// `[\s\S]*?` (non-greedy, dot-includes-newline) terminated by `\s*-->`, so a
// value containing a bare `>` (e.g. `forge:threshold=a>b`) is not truncated
// (Codex 2nd-pass, FORGE-94 review).
const FORGE_ONE_RE = /<!--\s*forge:([A-Za-z][A-Za-z0-9_]*)=([\s\S]*?)\s*-->/;
// A forge comment whose closing `-->` lands at the very END of the string
// (after optional trailing whitespace). Anchored with `$`; the open `<!--` is
// pinned by matching the LAST `<!--` start (see splitTrailingFooterRegion), so
// the non-greedy value capture cannot swallow an earlier comment's body.
const FORGE_ONE_AT_END_RE =
  /^<!--\s*forge:([A-Za-z][A-Za-z0-9_]*)=([\s\S]*?)\s*-->$/;

// ─── Trailing-footer-block scoping (FORGE-118) ─────────────────────────────
//
// PROMOTION + STRIP are scoped to the TRAILING contiguous footer region only:
// the block at the END of the body consisting solely of whitespace and
// `<!-- forge:* -->` comments. Forge comments that sit MID-BODY (e.g. a legacy
// comment in prose, or a `<!-- forge:foo=... -->` inside a fenced code block)
// are NEITHER promoted into managed footers NOR stripped — they stay in the
// body verbatim. Destroying legacy prose data (strip without re-emit) is the
// failure mode the pre-review flagged, so strip + promote MUST use the same
// trailing scope.
//
// Algorithm: walk from the end of the body. Repeatedly, after skipping trailing
// whitespace, if the body ends with a forge comment, peel it off and continue;
// otherwise stop. Whatever forge comments we peeled (in original order) are the
// trailing footers; everything before is the head (prose, kept verbatim).
export interface TrailingFooterSplit {
  // The body with the trailing footer region removed (prose + any mid-body
  // forge comments, kept verbatim). NOT trimmed — caller decides.
  head: string;
  // Trailing forge comments as their original `<!-- ... -->` strings, in the
  // order they appear top-to-bottom in the body.
  trailing: string[];
}

// Count ``` fence delimiters in a string. A body that ends inside an UNCLOSED
// fenced code block (odd count of ``` markers) must NOT have its EOF forge
// comment peeled — that comment is example/literal content, not a managed
// footer (FORGE-118 finding 2). We count run-of-3+ backticks at a line start
// (the CommonMark fence rule); a bare ``` mid-line is not a fence opener.
function countFenceDelimiters(text: string): number {
  const m = text.match(/^[ \t]*`{3,}/gm);
  return m === null ? 0 : m.length;
}

export function splitTrailingFooterRegion(
  body: string | null | undefined,
): TrailingFooterSplit {
  const original = body ?? '';
  // FORGE-118 finding 2: if the body ends inside an UNCLOSED fenced code block,
  // its trailing forge comment is literal example text. Peeling it would corrupt
  // the body and promote example content into managed footers. An odd number of
  // ``` fence delimiters means the body terminates inside an open fence → treat
  // the body as having no trailing footer region (no peel).
  if (countFenceDelimiters(original) % 2 === 1) {
    return { head: original, trailing: [] };
  }
  let head = original;
  const trailingReversed: string[] = [];
  // Loop invariant: `head` is the remaining unconsumed prefix. We strip a
  // trailing whitespace run, then peel a single trailing forge comment,
  // repeating until the tail is no longer a forge comment. To peel the LAST
  // comment we anchor on the LAST `<!--` start and require the comment to end
  // at the string end — a non-greedy match from the first `<!--` would
  // wrongly span across multiple comments.
  for (;;) {
    const withoutTail = head.replace(/\s+$/, '');
    const start = withoutTail.lastIndexOf('<!--');
    if (start === -1) break;
    const candidate = withoutTail.slice(start);
    const m = candidate.match(FORGE_ONE_AT_END_RE);
    if (m === null) break;
    trailingReversed.push(candidate);
    head = withoutTail.slice(0, start);
  }
  return { head, trailing: trailingReversed.reverse() };
}

// Reject bare values (forgeTaskId, blockerId) that would break the HTML
// comment structure if concatenated raw. A `-->` inside a value would
// terminate the comment; a `<!--` inside would open a nested one. Either
// corrupts the round-trip parse and is a defense-in-depth gap
// (security-auditor, FORGE-16).
function assertFooterValueSafe(value: string, field: string): void {
  if (value.includes('-->') || value.includes('<!--')) {
    throw new TrackerError(
      'VALIDATION',
      `${field} contains HTML comment metacharacters ('-->' or '<!--'); cannot encode in forge footer`,
      { field, valuePreview: value.slice(0, 40) },
    );
  }
}

// Validate that an extra footer (pre-formed HTML comment) is well-shaped:
//   - exactly one `<!-- ... -->`
//   - inner content contains no further `<!--` or `-->`
// This lets adapters emit forge:ownerType etc. as comment strings while
// still preventing injection if the embedded value contains comment
// metacharacters (security-auditor, FORGE-16).
function assertExtraFooterSafe(footer: string): void {
  const match = footer.match(/^<!--\s*([\s\S]*?)\s*-->$/);
  if (!match) {
    throw new TrackerError(
      'VALIDATION',
      `extraFooter must be a single well-formed HTML comment '<!-- ... -->'`,
      { footerPreview: footer.slice(0, 60) },
    );
  }
  const inner = match[1] ?? '';
  if (inner.includes('-->') || inner.includes('<!--')) {
    throw new TrackerError(
      'VALIDATION',
      `extraFooter inner content contains HTML comment metacharacters`,
      { innerPreview: inner.slice(0, 60) },
    );
  }
}

export interface ForgeFooters {
  forgeTaskId?: string;
  blockerIds: string[];
}

// Body validation for updateIssueBody. Three rejection cases:
//  1. Non-string input (programmer error)
//  2. Body contains a forge-managed footer comment (forge:task / forge:blockedBy).
//     The adapter stamps these on; if a caller includes them (e.g., copy-paste of
//     an old body), serialization would produce duplicate or contradictory
//     footers and silently corrupt the tracker→forgeTaskId round-trip.
//  3. Body exceeds the per-provider byte cap (passed in by adapter — Linear and
//     GitHub both document caps in bytes, not chars).
// Non-forge HTML comments in the body are allowed.
export function assertValidBodyInput(
  body: unknown,
  maxBytes: number,
): asserts body is string {
  if (typeof body !== 'string') {
    throw new TrackerError(
      'VALIDATION',
      `updateIssueBody: body must be a string, got ${typeof body}`,
      { type: typeof body },
    );
  }
  if (FORGE_ANY_INPUT_RE.test(body)) {
    throw new TrackerError(
      'VALIDATION',
      `updateIssueBody: body must not contain any forge-managed footer (<!-- forge:KEY=... -->); the adapter appends them`,
      { bodyPreview: body.slice(0, 80) },
    );
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) {
    throw new TrackerError(
      'VALIDATION',
      `updateIssueBody: body exceeds provider limit: ${bytes} bytes > ${maxBytes} bytes`,
      { bytes, maxBytes },
    );
  }
}

// Returns the `<!-- forge:KEY=VALUE -->` comments to PROMOTE into managed
// extra-footers (suitable for passing back to serializeWithForgeFooters as
// extraFooters). Used by updateIssueBody to preserve adapter-emitted footers
// (e.g. forge:ownerType from createIssue) across a body replace.
//
// FORGE-118 — two corrections to the prior behavior:
//  1. TRAILING-BLOCK-ONLY (item 3): only comments from the trailing contiguous
//     footer region are promoted. A forge comment sitting mid-body (legacy
//     prose, or one inside a fenced code block) is NOT promoted — it stays in
//     the body verbatim (serializeWithForgeFooters strips the same trailing
//     scope, so it is never stranded).
//  2. DEDUP LAST-WINS (item 2): if the trailing region carries two comments
//     with the same KEY, the LAST occurrence wins (a single emission). The
//     prior line-138 comment claimed "the serializer dedups upstream" — that
//     was FALSE; serializeWithForgeFooters re-emits extraFooters verbatim, so a
//     duplicate here doubled on round-trip. Dedup now happens HERE.
// task/blockedBy are excluded (forge-managed separately by serialize).
export function parseExtraForgeFooters(
  body: string | null | undefined,
): string[] {
  const { trailing } = splitTrailingFooterRegion(body);
  // Dedup by KEY keeping the LAST occurrence, preserving the LAST position's
  // order. Walk forward recording the latest comment string per key + its
  // final index, then emit in ascending final-index order.
  const lastByKey = new Map<string, { footer: string; order: number }>();
  let order = 0;
  for (const footer of trailing) {
    const m = footer.match(FORGE_ONE_RE);
    if (m === null) continue;
    const key = m[1];
    if (key === 'task' || key === 'blockedBy') continue;
    lastByKey.set(key, { footer, order: order++ });
  }
  return [...lastByKey.values()]
    .sort((a, b) => a.order - b.order)
    .map((e) => e.footer);
}

// FORGE-118 finding 1: scope the task/blockedBy scan to the TRAILING footer
// region (same scope as parseExtraForgeFooters / serializeWithForgeFooters).
// Scanning the entire body let a forge:task / forge:blockedBy comment sitting
// in prose or a fenced code example satisfy preconditions and be promoted into
// managed metadata — the false-positive class parseExtraForgeFooters already
// closed. A mid-body legacy comment is left verbatim in the head and is NOT
// recognized here; serializeWithForgeFooters only re-emits the trailing region,
// so a mid-body-only task correctly reads as "no forge:task footer".
export function parseForgeFooters(body: string | null | undefined): ForgeFooters {
  const text = splitTrailingFooterRegion(body).trailing.join('\n');
  const task = text.match(FORGE_TASK_RE);
  const blocked = text.match(FORGE_BLOCKED_RE);
  const blockerIds =
    blocked?.[1]
      ?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [];
  const result: ForgeFooters = { blockerIds };
  if (task?.[1] !== undefined) result.forgeTaskId = task[1];
  return result;
}

// Strips the task and blockedBy footers ONLY from the TRAILING footer region;
// unknown `<!-- forge:* -->` comments (e.g., ownerType) in the trailing region
// are preserved in place so `setBlockedBy` rewrites don't strand them.
//
// FORGE-118 — strip is scoped to the trailing footer region (same scope as
// parseExtraForgeFooters' promotion). A legacy task/blockedBy comment sitting
// MID-BODY (or one inside a fenced code block) is NOT stripped — it stays in
// the body verbatim. Stripping a mid-body forge comment while no footer
// re-emits it would silently destroy legacy data (pre-review major).
export function serializeWithForgeFooters(
  originalBody: string,
  forgeTaskId: string,
  blockerIds: readonly string[],
  extraFooters: readonly string[] = [],
): string {
  assertFooterValueSafe(forgeTaskId, 'forgeTaskId');
  for (const id of blockerIds) assertFooterValueSafe(id, 'blockerId');
  for (const extra of extraFooters) assertExtraFooterSafe(extra);

  // Split off the trailing footer region; the head (prose + any mid-body forge
  // comments) is preserved verbatim. From the trailing comments, drop the
  // task/blockedBy ones (re-emitted below from params); keep any other trailing
  // forge comments (e.g. ownerType/claim) in their original order so
  // setBlockedBy — which passes extraFooters=[] — does not strand them.
  const { head, trailing } = splitTrailingFooterRegion(originalBody);
  const survivingTrailing = trailing.filter((footer) => {
    const m = footer.match(FORGE_ONE_RE);
    const key = m?.[1];
    return key !== 'task' && key !== 'blockedBy';
  });

  const stripped = head.replace(/\n{3,}$/g, '\n').trimEnd();
  const lines = [`<!-- forge:task=${forgeTaskId} -->`];
  if (blockerIds.length > 0) {
    lines.push(`<!-- forge:blockedBy=${blockerIds.join(',')} -->`);
  }
  for (const extra of survivingTrailing) lines.push(extra);
  for (const extra of extraFooters) lines.push(extra);
  const footer = lines.join('\n');
  return stripped.length > 0 ? `${stripped}\n\n${footer}\n` : `${footer}\n`;
}

// Parse the forge:claim footer value into a typed claim identity, or null if
// absent/malformed (never throws). Used by adapter toIssue() to populate
// Issue.claim* (FORGE-145).
// FORGE-118 finding 1: scope the claim scan to the TRAILING footer region. A
// forge:claim comment in prose or a fenced code example must not be read as the
// live claim identity (false CLAIM_MISMATCH in the updateIssueBody CAS check, or
// a bogus Issue.claim* on toIssue). The managed claim footer is always emitted
// into the trailing region by upsertClaimFooter, so trailing-only is complete.
export function parseClaimFooter(
  body: string | null | undefined,
): ClaimFenceData | null {
  const text = splitTrailingFooterRegion(body).trailing.join('\n');
  const m = text.match(FORGE_CLAIM_RE);
  if (!m) return null;
  return decodeClaimValue(m[1]);
}

// Upsert (data) or remove (null) the forge:claim footer, preserving prose +
// forge:task / forge:blockedBy + every other extra footer. Read-modify-write on
// the LATEST body — callers MUST pass the freshest body so non-fence content is
// never clobbered. Requires a pre-existing forge:task footer (forge-created
// issue); throws PRECONDITION_FAILED otherwise so a best-effort caller can warn.
export function upsertClaimFooter(
  body: string | null | undefined,
  data: ClaimFenceData | null,
): string {
  const existing = body ?? '';
  const { forgeTaskId, blockerIds } = parseForgeFooters(existing);
  if (forgeTaskId === undefined) {
    throw new TrackerError(
      'PRECONDITION_FAILED',
      'upsertClaimFooter: body has no forge:task footer; was the issue created outside forge?',
      {},
    );
  }
  // Keep every TRAILING extra footer except a prior claim; we re-add (or drop)
  // it below. parseExtraForgeFooters is trailing-scoped + deduped (FORGE-118).
  const extras = parseExtraForgeFooters(existing).filter(
    (f) => !/^<!--\s*forge:claim=/.test(f),
  );
  if (data) {
    extras.push(`<!-- forge:claim=${encodeClaimValue(data)} -->`);
  }
  // FORGE-118: take the head (trailing footer region removed) so serialize
  // re-adds the managed footers exactly once. We do NOT globally strip forge
  // comments anymore — a mid-body/legacy forge comment must survive verbatim,
  // and the head preserves it.
  const { head } = splitTrailingFooterRegion(existing);
  return serializeWithForgeFooters(head, forgeTaskId, blockerIds, extras);
}
