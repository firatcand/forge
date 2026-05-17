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

const FORGE_TASK_RE = /<!--\s*forge:task=([^\s>]+?)\s*-->/;
const FORGE_BLOCKED_RE = /<!--\s*forge:blockedBy=([^>]*?)\s*-->/;
// Strip variants are global — defensive against duplicate footers.
const FORGE_TASK_STRIP_RE = /<!--\s*forge:task=[^>]*-->\n?/g;
const FORGE_BLOCKED_STRIP_RE = /<!--\s*forge:blockedBy=[^>]*-->\n?/g;
// Match every `<!-- forge:KEY=VALUE -->` comment regardless of KEY. Used by
// parseExtraForgeFooters to collect everything except task/blockedBy so that
// updateIssueBody can carry them through a body replace.
//
// Value capture is `[\s\S]*?` (non-greedy, dot-includes-newline) terminated
// by `\s*-->`. Earlier `[^>]*?` truncated values containing a bare `>`
// (e.g. `<!-- forge:threshold=a>b -->`) — silent data loss. Codex 2nd-pass
// (FORGE-94 review).
const FORGE_ANY_RE = /<!--\s*forge:([A-Za-z][A-Za-z0-9_]*)=([\s\S]*?)\s*-->/g;
// Caller-input rejection: ANY `<!--\s*forge:KEY` regardless of which KEY.
// Stricter than (FORGE_TASK_RE|FORGE_BLOCKED_RE) because unknown forge keys
// (e.g. `forge:ownerType`) collide with adapter-managed extra-footer
// preservation and would silently double on round-trip. Code-reviewer +
// codex 2nd-pass converged on this (FORGE-94 review).
const FORGE_ANY_INPUT_RE = /<!--\s*forge:[A-Za-z]/;

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

// Returns every `<!-- forge:KEY=VALUE -->` comment in the body that is NOT
// `forge:task` or `forge:blockedBy`, as the original pre-formed comment
// strings (suitable for passing back to serializeWithForgeFooters as
// extraFooters). Used by updateIssueBody to preserve adapter-emitted footers
// (e.g. forge:ownerType from createIssue) across a body replace.
// Order is preserved; duplicates are kept (the serializer dedups upstream).
export function parseExtraForgeFooters(
  body: string | null | undefined,
): string[] {
  const text = body ?? '';
  const out: string[] = [];
  for (const match of text.matchAll(FORGE_ANY_RE)) {
    const key = match[1];
    if (key === 'task' || key === 'blockedBy') continue;
    out.push(match[0]);
  }
  return out;
}

export function parseForgeFooters(body: string | null | undefined): ForgeFooters {
  const text = body ?? '';
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

// Strips ONLY the task and blockedBy footers; unknown `<!-- forge:* -->`
// comments (e.g., ownerType) are preserved in place so `setBlockedBy`
// rewrites don't strand them.
export function serializeWithForgeFooters(
  originalBody: string,
  forgeTaskId: string,
  blockerIds: readonly string[],
  extraFooters: readonly string[] = [],
): string {
  assertFooterValueSafe(forgeTaskId, 'forgeTaskId');
  for (const id of blockerIds) assertFooterValueSafe(id, 'blockerId');
  for (const extra of extraFooters) assertExtraFooterSafe(extra);

  const stripped = originalBody
    .replace(FORGE_TASK_STRIP_RE, '')
    .replace(FORGE_BLOCKED_STRIP_RE, '')
    .replace(/\n{3,}$/g, '\n')
    .trimEnd();
  const lines = [`<!-- forge:task=${forgeTaskId} -->`];
  if (blockerIds.length > 0) {
    lines.push(`<!-- forge:blockedBy=${blockerIds.join(',')} -->`);
  }
  for (const extra of extraFooters) lines.push(extra);
  const footer = lines.join('\n');
  return stripped.length > 0 ? `${stripped}\n\n${footer}\n` : `${footer}\n`;
}
