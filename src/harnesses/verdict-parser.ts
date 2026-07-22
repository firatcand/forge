import { PinnedReviewVerdictSchema, ReviewVerdictSchema, type ReviewVerdict } from '../schemas/verdict.ts';
import { truncateUtf8 } from '../schemas/byte-bounded.ts';
import { HarnessError, type HarnessHost } from './base.ts';

const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n```/;
const MAX_FINDING_MESSAGE_BYTES = 2000;

// FORGE-223: `claude` joins as a reviewable host. ClaudeHarness.runReview now
// runs a `claude -p` subprocess and parses its fenced verdict through this same
// path; ReviewVerdictSchema.host already accepts 'claude' (FORGE-187).
export type ReviewableHost = Extract<HarnessHost, 'codex' | 'gemini' | 'claude'>;

export interface ParseOpts {
  readonly host: ReviewableHost;
  readonly stdout: string;
}

export function parseHarnessVerdict({ host, stdout }: ParseOpts): ReviewVerdict {
  const fenced = stdout.match(FENCED_JSON_RE);
  if (fenced) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenced[1]);
    } catch (err) {
      throw new HarnessError(
        'INVALID_STDOUT',
        host,
        `${host} emitted a fenced JSON block that failed to parse`,
        { stdout_excerpt: truncateUtf8(fenced[1], 2000) },
        { cause: err },
      );
    }
    const result = ReviewVerdictSchema.safeParse(parsed);
    if (!result.success) {
      throw new HarnessError(
        'INVALID_STDOUT',
        host,
        `${host} emitted a JSON block that does not match ReviewVerdictSchema`,
        { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      );
    }
    if (result.data.host !== host) {
      throw new HarnessError(
        'INVALID_STDOUT',
        host,
        `${host} emitted a verdict claiming host="${result.data.host}"`,
        { expected: host, actual: result.data.host },
      );
    }
    return result.data;
  }

  return synthesizeVerdict(host, stdout);
}

export function synthesizeVerdict(host: ReviewableHost, stdout: string): ReviewVerdict {
  const trimmed = stdout.trim();
  const message = trimmed.length === 0
    ? `${host} produced no stdout; stderr captured in attempt logs.`
    : truncateUtf8(trimmed, MAX_FINDING_MESSAGE_BYTES);

  return ReviewVerdictSchema.parse({
    version: 1,
    verdict: 'changes_requested',
    findings: [
      {
        severity: 'improvement',
        path: '<unstructured>',
        message,
      },
    ],
    host,
  });
}

// FORGE-231: pinned variant for the ORCHESTRATED review path. On top of the
// existing parse + host-equality checks, requires target_sha (Pinned schema)
// and verifies it equals the SHA the dispatch manifest pinned. A verdict for
// a different commit — or an unpinned one — must never satisfy the gate.
export function parsePinnedReviewVerdict(
  host: ReviewableHost,
  stdout: string,
  expectedTargetSha: string,
): ReviewVerdict {
  const verdict = parseHarnessVerdict({ host, stdout });
  const pinned = PinnedReviewVerdictSchema.safeParse(verdict);
  if (!pinned.success) {
    throw new HarnessError(
      'INVALID_STDOUT',
      host,
      `${host} emitted a verdict without the required pinned target_sha`,
      { issues: pinned.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    );
  }
  if (pinned.data.target_sha !== expectedTargetSha) {
    throw new HarnessError(
      'INVALID_STDOUT',
      host,
      `${host} emitted a verdict pinned to ${pinned.data.target_sha}, expected ${expectedTargetSha}`,
      { expected: expectedTargetSha, actual: pinned.data.target_sha },
    );
  }
  return pinned.data;
}

