import { ReviewVerdictSchema, type ReviewVerdict } from '../schemas/verdict.ts';
import { truncateUtf8 } from '../schemas/byte-bounded.ts';
import { HarnessError, type HarnessHost } from './base.ts';

const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n```/;
const MAX_FINDING_MESSAGE_BYTES = 2000;

export type ReviewableHost = Extract<HarnessHost, 'codex' | 'gemini'>;

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
