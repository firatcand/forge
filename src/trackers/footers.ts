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

const FORGE_TASK_RE = /<!--\s*forge:task=([^\s>]+?)\s*-->/;
const FORGE_BLOCKED_RE = /<!--\s*forge:blockedBy=([^>]*?)\s*-->/;
// Strip variants are global — defensive against duplicate footers.
const FORGE_TASK_STRIP_RE = /<!--\s*forge:task=[^>]*-->\n?/g;
const FORGE_BLOCKED_STRIP_RE = /<!--\s*forge:blockedBy=[^>]*-->\n?/g;

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
