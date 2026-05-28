// Preflight guardrail matching — the reusable core behind
// `forge orchestrate guardrail-check`.
//
// Enforcement model (spec/ORCHESTRATOR.md:752): forge has NO mechanical
// interception of host file-writes. Preflight is prompt-discipline: the worker
// prompt instructs workers to call `guardrail-check --path <p>` before any
// write, and a path that matches `agents.preflight_globs` forces an
// architectural-question checkpoint regardless of the worker's own
// classification. This module is the path → {architectural, suggested
// decision_key} decision, extracted from the CLI verb so it is directly
// unit-testable (FORGE-65) and reusable.
//
// Security (security-auditor + Codex on FORGE-97): containment is verified by
// realpath, not lexically — a symlink inside the repo pointing outside must be
// refused. The combined entry point returns `outside_repo` rather than echoing
// the resolved absolute path, so callers never leak the repo's filesystem depth.

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { matchAny, InvalidGlobError } from './glob-match.ts';

export interface PreflightResult {
  readonly architectural: boolean;
  /** Repo-relative path the write targets. */
  readonly path: string;
  /** The `preflight_globs` entry that matched, or null. */
  readonly matched_glob: string | null;
  /** Stable decision_key the worker should use for the forced question, or null. */
  readonly suggested_decision_key: string | null;
}

export type PreflightOutcome =
  | { readonly kind: 'ok'; readonly result: PreflightResult }
  | { readonly kind: 'outside_repo' }
  | { readonly kind: 'invalid_glob'; readonly glob: string; readonly message: string };

export function slugify(s: string): string {
  // Lowercase, replace non-[a-z0-9.-_] with '-', collapse repeats, trim.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function suggestDecisionKey(matchedGlob: string, relativePath: string): string {
  // Stable key: `guardrail:<glob>:<basename>`. The basename anchors the key
  // per-file so two writes to the same guardrail glob don't dedupe against
  // each other.
  const base = path.basename(relativePath);
  return `guardrail:${slugify(matchedGlob)}:${slugify(base)}`;
}

/**
 * Resolve `cwd + targetPath` to a repo-relative path, refusing anything that
 * escapes the repoRoot — including via symlinks. Returns `{ error: 'OUTSIDE_REPO' }`
 * when the target is outside the repo.
 *
 * Lexical containment via `path.relative` is insufficient: a symlinked file
 * inside the repo pointing to `/etc/passwd` would otherwise be classified as
 * in-repo, and a relative path like `../../etc/passwd` would surface its
 * traversal depth to envelope readers.
 */
export function resolveRepoRelative(
  repoRoot: string,
  cwd: string,
  targetPath: string,
): { relative: string } | { error: 'OUTSIDE_REPO' } {
  // Realpath the repoRoot once. If the repoRoot itself doesn't exist
  // (impossible in practice — the caller is running INSIDE it), fall back to
  // the lexical path so we still fail closed below.
  let realRepoRoot: string;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    realRepoRoot = repoRoot;
  }

  // For the target, the file might not exist yet (that's the common case —
  // the worker is asking BEFORE the write). Realpath the longest existing
  // prefix and append the unresolved tail.
  const abs = path.resolve(cwd, targetPath);
  const real = realpathOfLongestPrefix(abs);

  const relative = path.relative(realRepoRoot, real);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return { error: 'OUTSIDE_REPO' };
  }
  return { relative };
}

function realpathOfLongestPrefix(abs: string): string {
  // Walk up the path until realpath succeeds; reattach the unresolved tail.
  // This handles "target file doesn't exist yet" without skipping symlink
  // resolution on the existing ancestors.
  let cursor = abs;
  const tail: string[] = [];
  while (cursor !== path.dirname(cursor)) {
    try {
      const real = realpathSync(cursor);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      tail.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
  // Reached filesystem root with no existing ancestor — return the lexical path.
  return abs;
}

export interface RunPreflightArgs {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly targetPath: string;
  readonly globs: readonly string[];
}

/**
 * Combined preflight: resolve the target to a repo-relative path, match it
 * against the guardrail globs, and (on a hit) suggest the stable decision_key.
 * Pure except for the realpath probing in resolveRepoRelative.
 */
export function runPreflight(args: RunPreflightArgs): PreflightOutcome {
  const resolved = resolveRepoRelative(args.repoRoot, args.cwd, args.targetPath);
  if ('error' in resolved) {
    return { kind: 'outside_repo' };
  }
  const relative = resolved.relative;

  let match: ReturnType<typeof matchAny>;
  try {
    match = matchAny(relative, args.globs);
  } catch (e) {
    if (e instanceof InvalidGlobError) {
      return { kind: 'invalid_glob', glob: e.glob, message: e.message };
    }
    // matchAny only throws InvalidGlobError or its absolute-path guard. The
    // guard cannot fire here — we just produced `relative` from
    // resolveRepoRelative, which rejected absolute / escaping paths above.
    throw e;
  }

  const result: PreflightResult = match.matched
    ? {
        architectural: true,
        path: relative,
        matched_glob: match.matchedGlob!,
        suggested_decision_key: suggestDecisionKey(match.matchedGlob!, relative),
      }
    : {
        architectural: false,
        path: relative,
        matched_glob: null,
        suggested_decision_key: null,
      };

  return { kind: 'ok', result };
}
