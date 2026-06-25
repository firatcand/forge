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

import { ReviewVerdictSchema, type ReviewVerdict } from '../../schemas/verdict.ts';
import {
  composeReviewVerdict,
  type ComposeCtx,
} from '../../orchestrator/review-compose.ts';
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

// FORGE-187 R3: accept BOTH a raw ReviewVerdict and the second-opinion verb's
// success envelope `{ok:true,data:{...,verdict}}`. If the parsed object looks
// like that envelope, unwrap `data.verdict`; otherwise treat the object itself
// as the raw ReviewVerdict. Then validate against the schema.
function extractAndValidate(
  value: unknown,
  filePath: string,
  kind: 'primary' | 'second-opinion',
): { verdict: ReviewVerdict } | { error: Envelope } {
  const candidate = unwrapEnvelope(value);
  const parsed = ReviewVerdictSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: fail(
        'INVALID_VERDICT',
        `${kind} verdict at ${filePath} failed ReviewVerdictSchema: ${parsed.error.message}`,
        false,
        { kind, path: filePath },
      ),
    };
  }
  return { verdict: parsed.data };
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

export function runOrchestrateReviewCompose(
  opts: OrchestrateReviewComposeOptions,
): OrchestrateReviewComposeResult {
  // This verb is structured-only: the kind-tagged envelope is its sole output
  // in both --json and text invocations (a pure compose has no human-prose form
  // distinct from the envelope). `opts.json` is accepted for surface
  // consistency with the other verbs but does not change the output shape.
  const out = opts.stdout ?? process.stdout;

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
  const primaryParsed = extractAndValidate(primaryRead.value, opts.primaryPath, 'primary');
  if ('error' in primaryParsed) {
    return { exitCode: writeEnvelope(primaryParsed.error, out) };
  }

  // 2. Read + validate the OPTIONAL second-opinion verdict.
  let secondOpinion: ReviewVerdict | null = null;
  if (opts.secondOpinionPath) {
    const secondRead = readCappedJson(opts.secondOpinionPath, 'second-opinion');
    if ('error' in secondRead) {
      return { exitCode: writeEnvelope(secondRead.error, out) };
    }
    const secondParsed = extractAndValidate(secondRead.value, opts.secondOpinionPath, 'second-opinion');
    if ('error' in secondParsed) {
      return { exitCode: writeEnvelope(secondParsed.error, out) };
    }
    // Dual-lineage invariant (generalized FORGE-224): a second opinion MUST
    // come from a DIFFERENT host than the primary review. The host enum now
    // includes 'claude' as a valid reviewer, so the gate is no longer "reject
    // host:claude" — it is "reject same-host pairs". Accepting a same-host pair
    // (e.g. claude+claude, codex+codex) would let a critical-path change pass
    // with two reviews from the same lineage, defeating the adversarial gate.
    const primaryHost = primaryParsed.verdict.host;
    const secondHost = secondParsed.verdict.host;
    if (secondHost === primaryHost) {
      return {
        exitCode: writeEnvelope(
          fail(
            'INVALID_VERDICT',
            `second-opinion verdict at ${opts.secondOpinionPath} has host:'${secondHost}' which matches the primary review host; a second opinion must come from a different host than the primary review (same-host pairs, including claude+claude, are rejected).`,
            false,
            { kind: 'second-opinion', path: opts.secondOpinionPath, primaryHost, secondHost },
          ),
          out,
        ),
      };
    }
    secondOpinion = secondParsed.verdict;
  }

  // 3. Build the ComposeCtx and run the pure policy. composeReviewVerdict
  //    throws on an invalid ctx (empty/overlong branch or summary that would
  //    produce a non-schema Verdict) — surface that as INVALID_ARGS.
  const ctx: ComposeCtx = {
    branch: opts.branch,
    summary: opts.summary,
    hasCriticalPath: opts.criticalPath,
    secondOpinionAvailable: opts.secondOpinionAvailable,
  };
  let result;
  try {
    result = composeReviewVerdict(primaryParsed.verdict, secondOpinion, ctx);
  } catch (err) {
    return {
      exitCode: writeEnvelope(
        fail('INVALID_ARGS', err instanceof Error ? err.message : String(err), false),
        out,
      ),
    };
  }

  // 4. Emit the kind-tagged result.
  if (result.kind === 'verdict') {
    return { exitCode: writeEnvelope(ok({ kind: 'verdict', verdict: result.verdict }), out) };
  }
  return { exitCode: writeEnvelope(ok({ kind: result.kind, reason: result.reason }), out) };
}

export const reviewComposeHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Compose a machine Verdict from a primary review (+ optional second opinion) via the FORGE-186 policy; escalate or park instead when a human is required.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const primaryPath = parseFlag(rest, 'primary') ?? '';
    const secondOpinionPath = parseFlag(rest, 'second-opinion');
    const branch = parseFlag(rest, 'branch') ?? '';
    const summary = parseFlag(rest, 'summary') ?? '';
    const criticalPath = hasFlag(rest, 'critical-path');
    const secondOpinionAvailable = hasFlag(rest, 'second-opinion-available');
    const json = hasFlag(rest, 'json');
    return runOrchestrateReviewCompose({
      primaryPath,
      branch,
      summary,
      criticalPath,
      secondOpinionAvailable,
      forgeDir,
      json,
      ...(secondOpinionPath ? { secondOpinionPath } : {}),
    });
  },
};
