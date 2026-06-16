// FORGE-205: read-only diff-path resolution for `doctor --scope docs`.
//
// docs-coverage needs the set of paths a branch changed. doctor is read-only,
// so this NEVER mutates git state — it shells out to `git diff --name-only
// <base>...HEAD` (THREE-dot: the changes introduced on HEAD since its
// merge-base with <base>, NOT base's own divergent commits). We document this
// as committed-vs-base only: uncommitted working-tree edits are NOT seen (a
// `--include-working-tree` slice is deferred).
//
// EVERY failure degrades to `{ paths: [], warnings: [...] }` and NEVER throws,
// so the public `doctor` verb stays non-blocking on a non-repo / detached HEAD
// / shallow clone / no-origin / first-commit / missing-base / git-diff-failed
// repo. Sanitized env (strip GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/
// GIT_CEILING_DIRECTORIES) so git resolution is anchored on repoRoot, mirroring
// second-opinion-suggest.ts resolveGitCommonRoot (Codex F1 path-trust).

import { execFileSync } from 'node:child_process';

// Cap the number of diff paths we process — a huge diff (or a hostile base
// selecting the whole history) shouldn't churn unbounded work. Mirror audit's
// MAX_FINDINGS posture. Truncation is surfaced as a warning.
const MAX_DIFF_PATHS = 5000;

export interface DiffResolution {
  readonly paths: string[];
  readonly warnings: string[];
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_CEILING_DIRECTORIES;
  return env;
}

// Run a git subcommand with a sanitized env, swallowing stderr. Returns the
// trimmed stdout on success, or null on ANY failure (non-zero exit, git
// missing, etc.) — callers decide how to degrade.
function git(repoRoot: string, argv: readonly string[]): string | null {
  try {
    const out = execFileSync('git', [...argv], {
      cwd: repoRoot,
      env: sanitizedEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  } catch {
    return null;
  }
}

// True iff `ref` resolves to a commit in this repo.
function refExists(repoRoot: string, ref: string): boolean {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

// Resolve the diff base ref. Order: explicit --base → origin/main → main. We
// return the ref STRING; the merge-base for the three-dot diff is computed by
// `git diff <base>...HEAD` itself. Returns null when nothing resolves.
function resolveBaseRef(repoRoot: string, explicit?: string): string | null {
  if (explicit !== undefined && explicit.length > 0) {
    // An explicit base that doesn't resolve is a caller error worth a warning;
    // signal "no usable base" by returning null and let the caller warn.
    return refExists(repoRoot, explicit) ? explicit : null;
  }
  for (const candidate of ['origin/main', 'main']) {
    if (refExists(repoRoot, candidate)) return candidate;
  }
  return null;
}

export function resolveDiffPaths(opts: {
  readonly repoRoot: string;
  readonly base?: string;
}): DiffResolution {
  const { repoRoot, base } = opts;
  const warnings: string[] = [];

  // (1) Must be inside a work tree.
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    warnings.push('docs-coverage: not a git repository (or git unavailable); skipping diff (empty coverage).');
    return { paths: [], warnings };
  }

  // (2) HEAD must point at a commit (a fresh repo with no commits has no HEAD).
  if (!refExists(repoRoot, 'HEAD')) {
    warnings.push('docs-coverage: repository has no commits yet (no HEAD); skipping diff (empty coverage).');
    return { paths: [], warnings };
  }

  // (3) Resolve the base ref.
  const baseRef = resolveBaseRef(repoRoot, base);
  if (baseRef === null) {
    if (base !== undefined && base.length > 0) {
      warnings.push(`docs-coverage: base ref '${base}' does not resolve; skipping diff (empty coverage).`);
    } else {
      warnings.push('docs-coverage: no base ref found (tried origin/main, main); skipping diff (empty coverage).');
    }
    return { paths: [], warnings };
  }

  // (4) Need a merge-base between base and HEAD for the three-dot diff. A
  // shallow clone, an unrelated base, or a first-commit-only HEAD can leave no
  // merge-base — degrade rather than diff against the whole tree.
  if (git(repoRoot, ['merge-base', baseRef, 'HEAD']) === null) {
    warnings.push(
      `docs-coverage: no merge-base between '${baseRef}' and HEAD (shallow clone or unrelated history); skipping diff (empty coverage).`,
    );
    return { paths: [], warnings };
  }

  // (5) The diff itself. Three-dot: changes on HEAD since the merge-base.
  const diff = git(repoRoot, ['diff', '--name-only', `${baseRef}...HEAD`]);
  if (diff === null) {
    warnings.push(`docs-coverage: 'git diff ${baseRef}...HEAD' failed; skipping diff (empty coverage).`);
    return { paths: [], warnings };
  }

  // git emits repo-relative POSIX paths, one per line. Normalize + drop blanks.
  let paths = diff
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (paths.length > MAX_DIFF_PATHS) {
    warnings.push(
      `docs-coverage: diff has ${paths.length} paths; capping at ${MAX_DIFF_PATHS} — ${paths.length - MAX_DIFF_PATHS} ignored.`,
    );
    paths = paths.slice(0, MAX_DIFF_PATHS);
  }

  return { paths, warnings };
}
