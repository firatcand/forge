// `forge orchestrate review-compose` (FORGE-187 / P4-T04) — read-band verb that
// wraps the pure `composeReviewVerdict` policy module (src/orchestrator/
// review-compose.ts, shipped in FORGE-186). 186 shipped the policy with no
// caller; this verb is its CLI bridge so the auto-review SKILL.md (bash) — and
// the future native `/goal` driver — can invoke the one tested policy instead
// of re-implementing it in prose.
//
// Read band (precedent: guardrail-check): pure compute, no lease, no
// state-machine write, no tracker mutation. It reads the primary (and optional
// second-opinion) ReviewVerdict files, runs the policy, and emits one of:
//   - ok({ kind:'verdict', verdict })  — a schema-valid machine Verdict
//   - ok({ kind:'escalate', reason })  — architectural block; a human decides
//   - ok({ kind:'park', reason })      — critical path, no second opinion
//
// Both `--primary` and `--second-opinion` accept BOTH a raw ReviewVerdict file
// AND the `second-opinion` verb's envelope `{ok:true,data:{verdict}}` so the
// skill can pipe `second-opinion --json` output straight in (FORGE-187 R3).

import { lstatSync, readFileSync } from 'node:fs';

import type { ReviewVerdict } from '../../schemas/verdict.ts';
import { REVIEW_HOSTS, type ReviewHost } from '../../schemas/hosts.ts';
import { composeTrustedReviewOutcome } from '../../orchestrator/review-compose.ts';
import { fail, ok, type Envelope } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// Per-file read cap — .forge / caller-supplied JSON is untrusted. Mirrors the
// dashboard's FILE_MAX_BYTES idiom.
const FILE_MAX_BYTES = 1 * 1024 * 1024;

// Local emit that honors the injected stdout stream (test fixtures use
// PassThrough; the shared emit() writes straight to process.stdout and is
// invisible to captured streams). Precedent: questions.ts / dashboard.ts.
function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

export interface OrchestrateReviewComposeOptions {
  readonly primaryPath: string;
  readonly secondOpinionPath?: string;
  readonly branch: string;
  readonly summary: string;
  readonly criticalPath: boolean;
  readonly secondOpinionAvailable: boolean;
  readonly forgeDir: string;
  readonly json?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // FORGE-225: the expected host of the PRIMARY review, supplied by the TRUSTED
  // caller (the orchestrator/skill knows which session host produced the primary
  // review). When set, the primary verdict's self-declared `host` is verified
  // against it (anti-spoofing). When absent, provenance verification is inactive
  // and a warning is emitted (lenient/back-compat). Never sourced from a
  // worker-writable file. One of the ReviewVerdict hosts (claude|codex|gemini).
  readonly expectedPrimaryHost?: ReviewHost;
  readonly expectedTargetSha?: string;
}

export interface OrchestrateReviewComposeResult {
  readonly exitCode: number;
}

// Read + size-cap a JSON file. Returns the parsed value, or an error envelope.
// `kind` names which input failed so the message points at the right file.
function readCappedJson(
  filePath: string,
  kind: 'primary' | 'second-opinion',
): { value: unknown } | { error: Envelope } {
  let size: number;
  try {
    // lstat (not stat): reject a symlink or a non-regular file (FIFO / char
    // device like /dev/zero reports size 0 then reads unbounded, defeating the
    // cap) before reading caller-supplied input.
    const st = lstatSync(filePath);
    if (!st.isFile()) {
      return {
        error: fail(
          'INVALID_VERDICT',
          `${kind} verdict at ${filePath} is not a regular file.`,
          false,
          { kind, path: filePath },
        ),
      };
    }
    size = st.size;
  } catch (err) {
    return {
      error: fail(
        'MISSING_INPUT',
        `failed to stat ${kind} verdict at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { kind, path: filePath },
      ),
    };
  }
  if (size > FILE_MAX_BYTES) {
    return {
      error: fail(
        'INVALID_VERDICT',
        `${kind} verdict at ${filePath} is ${size} bytes; max is ${FILE_MAX_BYTES}.`,
        false,
        { kind, path: filePath, size, max: FILE_MAX_BYTES },
      ),
    };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      error: fail(
        'MISSING_INPUT',
        `failed to read ${kind} verdict at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { kind, path: filePath },
      ),
    };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return {
      error: fail(
        'INVALID_VERDICT',
        `${kind} verdict at ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { kind, path: filePath },
      ),
    };
  }
}


// Unwrap the second-opinion envelope shape if present; otherwise return as-is.
function unwrapEnvelope(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { data?: unknown }).data === 'object' &&
    (value as { data?: unknown }).data !== null &&
    'verdict' in ((value as { data: Record<string, unknown> }).data)
  ) {
    return (value as { data: { verdict: unknown } }).data.verdict;
  }
  return value;
}

export async function runOrchestrateReviewCompose(
  opts: OrchestrateReviewComposeOptions,
): Promise<OrchestrateReviewComposeResult> {
  // This verb is structured-only: the kind-tagged envelope is its sole output
  // in both --json and text invocations (a pure compose has no human-prose form
  // distinct from the envelope). `opts.json` is accepted for surface
  // consistency with the other verbs but does not change the output shape.
  const out = opts.stdout ?? process.stdout;
  // FORGE-225: warnings go to STDERR so the stdout envelope stays a single pure
  // JSON line for the consumer (the core logger writes human output to stdout —
  // not usable here). Injectable for tests.
  const err = opts.stderr ?? process.stderr;

  if (!opts.primaryPath) {
    return {
      exitCode: writeEnvelope(fail('MISSING_INPUT', '--primary is required', false, { kind: 'primary' }), out),
    };
  }

  // 1. Read + validate the primary verdict.
  const primaryRead = readCappedJson(opts.primaryPath, 'primary');
  if ('error' in primaryRead) {
    return { exitCode: writeEnvelope(primaryRead.error, out) };
  }
  // 1b-3 (FORGE-231): the ENTIRE trust pipeline — schema validation, host
  // provenance (FORGE-225), dual-lineage same-host rejection, and composition
  // — now runs in the shared gateway (composeTrustedReviewOutcome), the same
  // code path the orchestrated completion gate uses. This verb only maps the
  // gateway's typed rejection back onto its legacy envelope messages. The
  // --critical-path flag is STRICTLY TIGHTENING (derived ∨ flag); this
  // interactive verb has no pinned SHAs, so derivation is disabled here.
  if (!opts.expectedPrimaryHost) {
    err.write(
      'warn: review-compose — provenance verification inactive: no --expected-primary-host supplied; ' +
        'the dual-lineage gate is trusting the self-declared primary verdict host. Pass ' +
        '--expected-primary-host <session-host> to verify provenance.\n',
    );
  }

  let secondRaw: unknown | undefined;
  if (opts.secondOpinionPath) {
    const secondRead = readCappedJson(opts.secondOpinionPath, 'second-opinion');
    if ('error' in secondRead) {
      return { exitCode: writeEnvelope(secondRead.error, out) };
    }
    secondRaw = unwrapEnvelope(secondRead.value);
  }

  let outcome;
  try {
    outcome = await composeTrustedReviewOutcome({
      primaryRaw: unwrapEnvelope(primaryRead.value),
      secondOpinionRaw: secondRaw,
      expectedPrimaryHost: opts.expectedPrimaryHost as ReviewVerdict['host'] | undefined,
      expectedTargetSha: opts.expectedTargetSha,
      criticality: { derive: null, flag: opts.criticalPath },
      branch: opts.branch,
      summary: opts.summary,
      secondOpinionAvailable: opts.secondOpinionAvailable,
    });
  } catch (composeErr) {
    return {
      exitCode: writeEnvelope(
        fail('INVALID_ARGS', composeErr instanceof Error ? composeErr.message : String(composeErr), false),
        out,
      ),
    };
  }

  if (outcome.kind === 'invalid') {
    const d = outcome.detail;
    const isSecond = d.kind === 'second-opinion';
    const path = isSecond ? opts.secondOpinionPath ?? '' : opts.primaryPath;
    // Legacy envelope message formats (verb tests + skill docs reference them).
    let message: string;
    if (typeof d.zodError === 'string') {
      message = `${String(d.kind)} verdict at ${path} failed ReviewVerdictSchema: ${d.zodError}`;
    } else if ('primaryHost' in d) {
      message = `second-opinion verdict at ${path} has host:'${String(d.secondHost)}' which matches the primary review host; a second opinion must come from a different host than the primary review (same-host pairs, including claude+claude, are rejected).`;
    } else if ('expected' in d && typeof d.expected === 'string' && /^[0-9a-f]{40}$/.test(d.expected)) {
      message = `${String(d.kind)} verdict at ${path} ${outcome.reason}`;
    } else {
      message = `primary review verdict at ${path} has host:'${String(d.claimed)}' which does not match the expected primary review host '${String(d.expected)}' supplied by the orchestrator; the dual-lineage gate verifies provenance, not the self-declared host.`;
    }
    return {
      exitCode: writeEnvelope(
        fail('INVALID_VERDICT', message, false, { ...d, path }),
        out,
      ),
    };
  }
  const result = outcome.result;

  // 4. Emit the kind-tagged result.
  if (result.kind === 'verdict') {
    return { exitCode: writeEnvelope(ok({ kind: 'verdict', verdict: result.verdict }), out) };
  }
  return { exitCode: writeEnvelope(ok({ kind: result.kind, reason: result.reason }), out) };
}

export const reviewComposeHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Compose a machine Verdict from a primary review (+ optional second opinion) via the FORGE-186 policy; verifies primary-review provenance when --expected-primary-host is supplied (FORGE-225); escalate or park instead when a human is required.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const primaryPath = parseFlag(rest, 'primary') ?? '';
    const secondOpinionPath = parseFlag(rest, 'second-opinion');
    const branch = parseFlag(rest, 'branch') ?? '';
    const summary = parseFlag(rest, 'summary') ?? '';
    const criticalPath = hasFlag(rest, 'critical-path');
    const secondOpinionAvailable = hasFlag(rest, 'second-opinion-available');
    const json = hasFlag(rest, 'json');
    // FORGE-225: optional provenance flag. Validate against the ReviewVerdict
    // host enum (claude|codex|gemini) — NOT the broader Host enum (which includes
    // cursor, never a review host). A bad value is a clear INVALID_ARGS, not a
    // confusing host-mismatch downstream.
    const expectedPrimaryHostRaw = parseFlag(rest, 'expected-primary-host');
    // FORGE-231: optional pin — when supplied, the primary witness must be
    // pinned to this 40-hex SHA and the composed verdict carries it forward.
    const expectedTargetSha = parseFlag(rest, 'expected-target-sha');
    if (expectedTargetSha !== undefined && !/^[0-9a-f]{40}$/.test(expectedTargetSha)) {
      return {
        exitCode: writeEnvelope(
          fail('INVALID_ARGS', '--expected-target-sha must be a 40-hex commit SHA', false),
          process.stdout,
        ),
      };
    }
    // A present-but-valueless flag (`--expected-primary-host` at end of argv →
    // parseFlag undefined) or an invalid value must FAIL, never silently disable
    // provenance verification (security footgun). hasFlag detects the token even
    // when parseFlag yields undefined.
    if (
      hasFlag(rest, 'expected-primary-host') &&
      (expectedPrimaryHostRaw === undefined ||
        !(REVIEW_HOSTS as readonly string[]).includes(expectedPrimaryHostRaw))
    ) {
      return {
        exitCode: writeEnvelope(
          fail(
            'INVALID_ARGS',
            `--expected-primary-host must be one of: ${REVIEW_HOSTS.join(', ')} (got ${
              expectedPrimaryHostRaw === undefined ? '(no value)' : `'${expectedPrimaryHostRaw}'`
            })`,
            false,
          ),
          process.stdout,
        ),
      };
    }
    return runOrchestrateReviewCompose({
      primaryPath,
      branch,
      summary,
      criticalPath,
      secondOpinionAvailable,
      forgeDir,
      json,
      ...(secondOpinionPath ? { secondOpinionPath } : {}),
      ...(expectedPrimaryHostRaw ? { expectedPrimaryHost: expectedPrimaryHostRaw as ReviewHost } : {}),
      expectedTargetSha,
    });
  },
};
