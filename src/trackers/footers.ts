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
