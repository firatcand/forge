// Minimal glob matcher for forge's guardrail preflight check.
//
// Supports:
//   **          any number of path segments (including zero)
//   *           any chars within a single segment (no /)
//   literal     exact match
//
// Patterns are matched against repo-relative paths (no leading /).
// Anchored at both ends, case-sensitive, forward-slash only.
//
// Why roll-your-own: forge has zero glob deps today. micromatch is ~50
// transitive deps and ~2 MB; we need four pattern shapes. Tradeoff:
// no brace expansion, no negation, no character classes. Tests exercise
// every shape we accept.

export class InvalidGlobError extends Error {
  constructor(
    public readonly glob: string,
    reason: string,
  ) {
    super(`invalid glob '${glob}': ${reason}`);
    this.name = 'InvalidGlobError';
  }
}

const REGEX_META = new Set(['.', '+', '?', '(', ')', '|', '^', '$', '[', ']', '{', '}', '\\']);

// Cache compiled regexes — `matchAny` may be called many times with the
// same `agents.preflight_globs` list (one call per worker file-write).
// Cap is small (preflight_globs lists ship with ~12 entries by default).
const COMPILED_CACHE = new Map<string, RegExp>();

function compileGlob(glob: string): RegExp {
  const cached = COMPILED_CACHE.get(glob);
  if (cached) return cached;

  if (glob.length === 0) throw new InvalidGlobError(glob, 'empty');
  if (glob.startsWith('/')) {
    throw new InvalidGlobError(glob, 'must be repo-relative (no leading /)');
  }

  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any number of path segments. Two cases:
        //
        //   1. `**/` (followed by a slash): emit `(?:[^/]+/)*` — zero or more
        //      whole segments. This enforces segment boundaries so that
        //      `src/**/foo.ts` matches `src/foo.ts` and `src/a/b/foo.ts` but
        //      NOT `src/barfoo.ts` (Codex review on FORGE-97).
        //
        //   2. `**` at end (or not followed by /): emit `.+` — one or more
        //      arbitrary chars. The leading anchor + literal prefix already
        //      enforce the segment boundary on the left side, so this is safe.
        //      Using `.+` (not `.*`) keeps `src/**` from matching bare `src`.
        i += 2;
        if (glob[i] === '/') {
          out += '(?:[^/]+/)*';
          i += 1;
        } else {
          out += '.+';
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (REGEX_META.has(c)) {
      out += '\\' + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += '$';

  let compiled: RegExp;
  try {
    compiled = new RegExp(out);
  } catch (e) {
    throw new InvalidGlobError(glob, `regex compile failed: ${(e as Error).message}`);
  }
  COMPILED_CACHE.set(glob, compiled);
  return compiled;
}

// Test-only cache reset. Not exported from the package barrel.
export function __resetGlobMatchCacheForTests(): void {
  COMPILED_CACHE.clear();
}

export interface GlobMatchResult {
  readonly matched: boolean;
  readonly matchedGlob?: string;
}

export function matchAny(relativePath: string, globs: readonly string[]): GlobMatchResult {
  let p = relativePath;
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) {
    throw new Error(`matchAny expects a repo-relative path, got: ${relativePath}`);
  }
  // Paths outside the repo (path.relative produced '..' / '../...') never match.
  if (p === '..' || p.startsWith('../')) return { matched: false };

  for (const glob of globs) {
    if (compileGlob(glob).test(p)) {
      return { matched: true, matchedGlob: glob };
    }
  }
  return { matched: false };
}
