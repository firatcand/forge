// Marker-block section replacement for `forge orchestrate apply-decision`
// (FORGE-95). The verb rewrites whole SPEC/PRD sections idempotently.
//
// Strategy (user choice, Q2): wrap each managed section in an anchor-keyed
// marker block. Markers are keyed by the section ANCHOR (not the ADR slug) so a
// section edited by successive decisions stays a single block. On FIRST touch
// the heading is located by anchor and its section is wrapped; thereafter the
// content between the markers is replaced. Detect-before-insert guarantees no
// double/nested markers (Codex 2nd-pass #5), which makes a crash-then-resume
// re-apply safe.

import { ApplyError } from '../core/errors.ts';

export interface SectionRef {
  readonly file: string;
  readonly anchor: string;
}

// "spec/SPEC.md#cli-surface" → { file: "spec/SPEC.md", anchor: "cli-surface" }.
// Also tolerates the ADR prose form "spec/SPEC.md §CLI surface".
export function parseSectionRef(ref: string): SectionRef {
  const hashIdx = ref.indexOf('#');
  if (hashIdx >= 0) {
    return { file: ref.slice(0, hashIdx).trim(), anchor: ref.slice(hashIdx + 1).trim() };
  }
  const secIdx = ref.indexOf('§');
  if (secIdx >= 0) {
    return { file: ref.slice(0, secIdx).trim(), anchor: slugifyHeading(ref.slice(secIdx + 1)) };
  }
  throw new ApplyError('SECTION_NOT_FOUND', `section ref '${ref}' has no '#anchor' or '§Heading'`, { ref });
}

// GitHub-flavored heading anchor: lowercase, strip punctuation (keep word chars
// + spaces + hyphens), spaces → hyphens, collapse repeats.
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function markerStart(anchor: string): string {
  return `<!-- forge:adr-section:${anchor} -->`;
}
export function markerEnd(anchor: string): string {
  return `<!-- /forge:adr-section:${anchor} -->`;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

// Replace (or first-time seed) the managed section identified by `anchor` with
// `newBody` (which includes its own heading line). Returns the new document.
export function replaceManagedSection(md: string, anchor: string, newBody: string): string {
  const lines = md.split('\n');
  const start = markerStart(anchor);
  const end = markerEnd(anchor);

  const startIdx = lines.indexOf(start);
  const endIdx = lines.indexOf(end);

  // Detect-before-insert: if markers already exist, replace between them.
  if (startIdx >= 0 && endIdx >= 0) {
    if (endIdx < startIdx) {
      throw new ApplyError('SECTION_NOT_FOUND', `marker block for '${anchor}' is inverted (end before start)`, {
        anchor,
      });
    }
    const next = [
      ...lines.slice(0, startIdx),
      start,
      ...newBody.split('\n'),
      end,
      ...lines.slice(endIdx + 1),
    ];
    return next.join('\n');
  }
  if (startIdx >= 0 || endIdx >= 0) {
    throw new ApplyError('SECTION_NOT_FOUND', `marker block for '${anchor}' is half-present (corrupt)`, { anchor });
  }

  // First touch: locate the heading by anchor and wrap its section. Scan the
  // whole document so an ambiguous anchor (two headings slugify the same — we
  // don't emulate GitHub's -1/-2 dedup suffixes) is rejected rather than
  // silently editing the first match (Codex impl-review #4).
  let headingIdx = -1;
  let headingLevel = 0;
  let matchCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m && slugifyHeading(m[2]!) === anchor) {
      matchCount += 1;
      if (headingIdx < 0) {
        headingIdx = i;
        headingLevel = m[1]!.length;
      }
    }
  }
  if (matchCount > 1) {
    throw new ApplyError('SECTION_NOT_FOUND', `anchor '${anchor}' matches ${matchCount} headings (ambiguous)`, {
      anchor,
      matchCount,
    });
  }
  if (headingIdx < 0) {
    throw new ApplyError('SECTION_NOT_FOUND', `no heading matches anchor '${anchor}'`, { anchor });
  }
  // Section ends at the next heading of equal-or-higher level, else EOF.
  let sectionEnd = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j += 1) {
    const m = HEADING_RE.exec(lines[j]!);
    if (m && m[1]!.length <= headingLevel) {
      sectionEnd = j;
      break;
    }
  }
  const next = [
    ...lines.slice(0, headingIdx),
    start,
    ...newBody.split('\n'),
    end,
    ...lines.slice(sectionEnd),
  ];
  return next.join('\n');
}
