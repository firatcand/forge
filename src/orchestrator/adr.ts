// Ephemeral ADR read/gate/delete for `forge orchestrate apply-decision`
// (FORGE-95). The frontmatter schema lives in src/schemas/adr.ts; this module
// owns the filesystem + parsing logic.

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { ApplyError } from '../core/errors.ts';
import { AdrFrontmatterSchema, type AdrFrontmatter } from '../schemas/adr.ts';

export const DECISIONS_DIR = 'spec/decisions';

export interface ParsedAdr {
  readonly path: string;
  readonly frontmatter: AdrFrontmatter;
  readonly body: string; // markdown after the frontmatter fence
}

// Resolve `spec/decisions/<YYYY-MM-DD>-<slug>.md` from a slug. The date prefix
// is part of the filename but not the identifier, so we match on the
// `-<slug>.md` suffix. Exactly one match is required.
export function resolveAdrPath(repoRoot: string, slug: string): string {
  const dir = join(repoRoot, DECISIONS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ApplyError('ADR_NOT_FOUND', `${DECISIONS_DIR}/ does not exist`, { dir });
    }
    throw new ApplyError('IO_ERROR', `failed to read ${DECISIONS_DIR}/: ${e.message}`, { dir });
  }
  const suffix = `-${slug}.md`;
  const matches = entries.filter((name) => name.endsWith(suffix) || name === `${slug}.md`);
  if (matches.length === 0) {
    throw new ApplyError('ADR_NOT_FOUND', `no ADR file for slug '${slug}' in ${DECISIONS_DIR}/`, {
      slug,
      dir,
    });
  }
  if (matches.length > 1) {
    throw new ApplyError('ADR_AMBIGUOUS', `slug '${slug}' matches ${matches.length} files`, {
      slug,
      matches,
    });
  }
  return join(dir, matches[0]!);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseAdr(absPath: string): ParsedAdr {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ApplyError('ADR_NOT_FOUND', `ADR not found: ${absPath}`, { path: absPath });
    }
    throw new ApplyError('IO_ERROR', `failed to read ADR: ${e.message}`, { path: absPath });
  }
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    throw new ApplyError('ADR_PARSE_ERROR', 'ADR is missing a `---` frontmatter fence', {
      path: absPath,
    });
  }
  let yamlObj: unknown;
  try {
    yamlObj = parseYaml(m[1]!);
  } catch (err) {
    throw new ApplyError('ADR_PARSE_ERROR', `ADR frontmatter is not valid YAML: ${(err as Error).message}`, {
      path: absPath,
    });
  }
  const parsed = AdrFrontmatterSchema.safeParse(yamlObj);
  if (!parsed.success) {
    throw new ApplyError('ADR_PARSE_ERROR', `ADR frontmatter failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`, {
      path: absPath,
    });
  }
  return { path: absPath, frontmatter: parsed.data, body: (m[2] ?? '').trim() };
}

// Gate: `/update-spec --apply` requires status: accepted (SPEC §ADR lifecycle).
// Skipped by the verb when resuming an all-applied journal into finalize, where
// the ADR may already be deleted.
export function assertAccepted(adr: ParsedAdr): void {
  if (adr.frontmatter.status !== 'accepted') {
    throw new ApplyError(
      'ADR_NOT_ACCEPTED',
      `ADR '${adr.frontmatter.slug}' has status '${adr.frontmatter.status}'; must be 'accepted'`,
      { slug: adr.frontmatter.slug, status: adr.frontmatter.status },
    );
  }
}

// The rationale that becomes durable: the full ADR body (Context / Decision /
// Consequences / Alternatives). Used for the commit-message body and the SPEC
// inline "Decision rationale" block (FORGE-163 fold).
export function extractRationale(adr: ParsedAdr): string {
  return adr.body;
}

// Idempotent: a missing file is success (a prior --resume may have deleted it).
export function deleteAdr(absPath: string): void {
  try {
    unlinkSync(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return;
    throw new ApplyError('IO_ERROR', `failed to delete ADR: ${e.message}`, { path: absPath });
  }
}
