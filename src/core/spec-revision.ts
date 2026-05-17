import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const SPEC_PATH = 'spec/SPEC.md';

export class SpecRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecRevisionError';
  }
}

// Returns the revision identifier for spec/SPEC.md relative to `cwd`:
//   1. git sha of HEAD when SPEC.md was last touched (40-char git sha)
//   2. sha256 content digest (40 chars) when SPEC.md is untracked or the
//      directory isn't a git working tree
// Throws if SPEC.md doesn't exist — that's a misconfiguration, not a defensive
// fallback.
export function computeSpecRevision(cwd: string): string {
  const specAbs = path.resolve(cwd, SPEC_PATH);
  if (!existsSync(specAbs)) {
    throw new SpecRevisionError(`spec/SPEC.md not found at ${specAbs}`);
  }

  const gitSha = tryGitSha(cwd);
  if (gitSha) return gitSha;

  return contentDigest(specAbs);
}

function tryGitSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', SPEC_PATH], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

function contentDigest(absPath: string): string {
  const contents = readFileSync(absPath);
  return createHash('sha256').update(contents).digest('hex').slice(0, 40);
}
