// SPEC revision stamping + diff for worker resume notifications.
// Informational only — workers proceed regardless (per docs/plans/team-mode-minimum-architecture.md §2.3).
//
// Revision form:
// - "git:<40-hex>" — `git rev-parse HEAD` when spec/ is present and the repo has commits.
// - "digest:<sha256-hex>" — content hash fallback when spec/ is untracked or pre-first-commit.
//   computeSpecDiffSinceClaim cannot show per-commit summaries in this case.
// - "digest:empty" — when spec/ is absent entirely.
//
// Scope: committed diffs only; uncommitted working-tree edits are NOT surfaced.

import { createHash } from 'node:crypto';
import {
  existsSync,
  opendirSync,
  readFileSync,
  statSync,
  type Dir,
} from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { execa, execaSync } from 'execa';

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 5_000;
const MAX_SUMMARIES = 5;
const SPEC_DIR_NAME = 'spec';

// digestSpecTree resource caps — defense-in-depth against a maliciously crafted
// spec/ subtree (deep nesting, many files, large files) when invoked with a
// caller-supplied --repo-root.
const DIGEST_MAX_FILES = 1_000;
const DIGEST_MAX_DEPTH = 20;
const DIGEST_MAX_FILE_BYTES = 512 * 1024;

export interface SpecRevisionResult {
  /** "git:<40-hex>" or "digest:<sha256-hex>" or "digest:empty". */
  readonly revision: string;
  readonly source: 'git' | 'digest';
}

export interface SpecDiffNotification {
  readonly commitCount: number;
  readonly filesAffected: readonly string[];
  readonly summaries: readonly string[];
  readonly diffCommand: string;
  readonly rendered: string;
}

// ---- Revision computation ----

function isShaForm(rev: string): boolean {
  return rev.startsWith('git:') && SHA1_HEX_RE.test(rev.slice(4));
}

function isDigestForm(rev: string): boolean {
  return rev.startsWith('digest:');
}

function digestSpecTree(repoRoot: string): string {
  const specRoot = join(repoRoot, SPEC_DIR_NAME);
  if (!existsSync(specRoot)) return 'digest:empty';

  let stat;
  try {
    stat = statSync(specRoot);
  } catch {
    return 'digest:empty';
  }
  if (!stat.isDirectory()) return 'digest:empty';

  const files: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > DIGEST_MAX_DEPTH) return;
    if (files.length >= DIGEST_MAX_FILES) return;
    // opendirSync streams entries one at a time — readdirSync would materialize
    // an entire directory listing before our file-count cap can engage, which
    // a malicious spec/ subtree with millions of entries could exploit.
    let handle: Dir;
    try {
      handle = opendirSync(dir);
    } catch {
      return;
    }
    try {
      while (files.length < DIGEST_MAX_FILES) {
        const entry = handle.readSync();
        if (entry === null) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // best-effort close
      }
    }
  }
  walk(specRoot, 0);

  if (files.length === 0) return 'digest:empty';

  // Sort by relative-to-repoRoot path for cross-platform stability (POSIX-normalized).
  files.sort((a, b) =>
    relative(repoRoot, a).split(sep).join(posix.sep).localeCompare(
      relative(repoRoot, b).split(sep).join(posix.sep),
    ),
  );

  const h = createHash('sha256');
  for (const f of files) {
    const rel = relative(repoRoot, f).split(sep).join(posix.sep);
    h.update(rel);
    h.update('\0');
    try {
      const stat = statSync(f);
      // For files larger than DIGEST_MAX_FILE_BYTES, hash only size+path (not contents)
      // to bound work without skipping the file entirely.
      h.update(String(stat.size));
      h.update('\0');
      if (stat.size <= DIGEST_MAX_FILE_BYTES) {
        h.update(readFileSync(f));
      }
    } catch {
      // skip unreadable file — path was already mixed in for stability
    }
    h.update('\0');
  }
  return `digest:${h.digest('hex')}`;
}

function shaResultOrNull(stdout: unknown): string | null {
  if (typeof stdout !== 'string') return null;
  const trimmed = stdout.trim();
  return SHA1_HEX_RE.test(trimmed) ? trimmed : null;
}

export function computeSpecRevisionSync(repoRoot: string): SpecRevisionResult {
  const specRoot = join(repoRoot, SPEC_DIR_NAME);
  const hasSpec = existsSync(specRoot);

  let headSha: string | null = null;
  try {
    const result = execaSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      headSha = shaResultOrNull(result.stdout);
    }
  } catch {
    // execaSync threw (e.g. ENOENT for git binary) — treat as no-git
  }

  if (headSha && hasSpec) {
    return { revision: `git:${headSha}`, source: 'git' };
  }

  return { revision: digestSpecTree(repoRoot), source: 'digest' };
}

export async function computeSpecRevision(
  repoRoot: string,
): Promise<SpecRevisionResult> {
  const specRoot = join(repoRoot, SPEC_DIR_NAME);
  const hasSpec = existsSync(specRoot);

  let headSha: string | null = null;
  try {
    const result = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      headSha = shaResultOrNull(result.stdout);
    }
  } catch {
    // execa threw — treat as no-git
  }

  if (headSha && hasSpec) {
    return { revision: `git:${headSha}`, source: 'git' };
  }

  return { revision: digestSpecTree(repoRoot), source: 'digest' };
}

// ---- Diff computation (resume side) ----

interface ParsedCommitListing {
  readonly summaries: string[];
  readonly files: string[];
  readonly totalCommits: number;
}

function parseCommitListing(stdout: string): ParsedCommitListing {
  // Format: per commit, a header line "SUMMARY:<oneline>" then zero or more file
  // path lines, separated by blank lines. We use a sentinel so we can split files
  // from summaries unambiguously.
  const summaries: string[] = [];
  const files = new Set<string>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.startsWith('SUMMARY:')) {
      summaries.push(line.slice('SUMMARY:'.length));
    } else if (line.length > 0) {
      // path line (relative to repo root) — git outputs POSIX separators even on Windows
      if (line.startsWith('spec/')) {
        files.add(line);
      }
    }
  }
  return {
    summaries,
    files: [...files].sort(),
    totalCommits: summaries.length,
  };
}

function shortSha(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

function renderNotificationBlock(
  commitCount: number,
  filesAffected: readonly string[],
  summaries: readonly string[],
  diffCommand: string,
): string {
  const fileList = filesAffected.length > 0 ? filesAffected.join(', ') : 'spec/';
  const commitWord = commitCount === 1 ? 'commit' : 'commits';
  const lines: string[] = [
    `SPEC changed since you claimed this ticket — ${commitCount} ${commitWord} affecting ${fileList}.`,
    '',
    'Recent commits:',
  ];
  for (const s of summaries.slice(0, MAX_SUMMARIES)) {
    lines.push(`  ${s}`);
  }
  if (summaries.length > MAX_SUMMARIES) {
    lines.push(`  … and ${summaries.length - MAX_SUMMARIES} more`);
  }
  lines.push('');
  lines.push(`Run \`${diffCommand}\` to review.`);
  lines.push('');
  lines.push('This is informational only — proceed with your work.');
  return lines.join('\n');
}

function renderUnreachableBlock(claimSha: string, headSha: string | null): string {
  const head = headSha ?? '(unknown)';
  return [
    `SPEC may have changed since you claimed this ticket — but the claim revision ${shortSha(claimSha)} is no longer reachable (likely rebase/force-push).`,
    '',
    `Current HEAD: ${head}.`,
    '',
    'This is informational only — proceed with your work.',
  ].join('\n');
}

function renderDigestChangedBlock(currentDigest: string): string {
  return [
    'spec/ contents changed since you claimed this ticket — but the tree is untracked (or pre-first-commit), so a per-commit diff is unavailable.',
    '',
    `Current spec/ digest: ${currentDigest}.`,
    '',
    'This is informational only — proceed with your work.',
  ].join('\n');
}

async function shaIsReachable(repoRoot: string, sha: string): Promise<boolean> {
  try {
    const result = await execa('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: repoRoot,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function readHeadSha(repoRoot: string): Promise<string | null> {
  try {
    const result = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      return shaResultOrNull(result.stdout);
    }
  } catch {
    // fallthrough
  }
  return null;
}

/**
 * Compute the SPEC diff between `claimRevision` and current HEAD.
 *
 * Returns `null` when there is no diff to surface (silent). Returns a populated
 * notification when commits touching `spec/` have landed, or when the claim
 * revision is unreachable / on a digest-only tree that has changed.
 */
export async function computeSpecDiffSinceClaim(
  repoRoot: string,
  claimRevision: string,
): Promise<SpecDiffNotification | null> {
  // Digest-form claim → can only do content-digest comparison.
  if (isDigestForm(claimRevision)) {
    const current = digestSpecTree(repoRoot);
    if (current === claimRevision) return null;
    const rendered = renderDigestChangedBlock(current);
    return {
      commitCount: 0,
      filesAffected: [],
      summaries: [],
      diffCommand: '',
      rendered,
    };
  }

  // Sha-form claim.
  if (!isShaForm(claimRevision)) {
    // Unknown form — treat as informational fallback.
    const head = await readHeadSha(repoRoot);
    const rendered = renderUnreachableBlock(claimRevision, head);
    return {
      commitCount: 0,
      filesAffected: [],
      summaries: [],
      diffCommand: '',
      rendered,
    };
  }

  const sha = claimRevision.slice(4); // strip "git:"

  // Is the stamped sha still reachable?
  const reachable = await shaIsReachable(repoRoot, sha);
  if (!reachable) {
    const head = await readHeadSha(repoRoot);
    const rendered = renderUnreachableBlock(sha, head);
    return {
      commitCount: 0,
      filesAffected: [],
      summaries: [],
      diffCommand: '',
      rendered,
    };
  }

  // Walk commits in spec/ between sha..HEAD.
  let stdout = '';
  try {
    // --pretty='SUMMARY:%h %s' tags summaries; --name-only emits affected file paths.
    // -z is not used — we split on newlines and use the SUMMARY: sentinel to disambiguate.
    const result = await execa(
      'git',
      [
        'log',
        '--pretty=SUMMARY:%h %s',
        '--name-only',
        `${sha}..HEAD`,
        '--',
        SPEC_DIR_NAME,
      ],
      {
        cwd: repoRoot,
        reject: false,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      // git log can fail if sha was reachable a moment ago but is no longer
      // (concurrent gc) — fall back to unreachable rendering.
      const head = await readHeadSha(repoRoot);
      const rendered = renderUnreachableBlock(sha, head);
      return {
        commitCount: 0,
        filesAffected: [],
        summaries: [],
        diffCommand: '',
        rendered,
      };
    }
    stdout = typeof result.stdout === 'string' ? result.stdout : '';
  } catch {
    const head = await readHeadSha(repoRoot);
    const rendered = renderUnreachableBlock(sha, head);
    return {
      commitCount: 0,
      filesAffected: [],
      summaries: [],
      diffCommand: '',
      rendered,
    };
  }

  if (stdout.trim().length === 0) {
    return null;
  }

  const { summaries, files, totalCommits } = parseCommitListing(stdout);
  if (totalCommits === 0) {
    return null;
  }

  const diffCommand = `git diff ${shortSha(sha)}..HEAD -- spec/`;
  const rendered = renderNotificationBlock(totalCommits, files, summaries, diffCommand);

  return {
    commitCount: totalCommits,
    filesAffected: files,
    summaries,
    diffCommand,
    rendered,
  };
}
