// FORGE-186 — pure review-verdict composition.
//
// Given a primary review verdict and an OPTIONAL second-opinion verdict, plus
// the surrounding context (branch, summary, whether the diff touches a
// CRITICAL.md / architectural path, and whether a second opinion was reachable),
// decide the single composed outcome:
//   - escalate : an architectural block finding — emit NO machine Verdict; a
//                human must make the call (apply-decision / amend-roadmap).
//   - park     : a second opinion was REQUIRED (critical path) but unavailable —
//                we cannot safely auto-verdict, so hold.
//   - verdict  : a normal machine Verdict (ready_for_review | changes_needed).
//
// composeReviewVerdict + makeVerdict are PURE: no I/O, no clock, no
// filesystem. FORGE-231 adds the TRUSTED GATEWAY layer below them
// (composeTrustedReviewOutcome + deriveCriticalPath): the single code path
// that parses raw review artifacts, validates host provenance + lineage +
// SHA pinning, DERIVES critical-path status from revision-pinned inputs, and
// then runs the pure policy. Both the CLI verb and the orchestrated
// completion gate call the gateway — a composed artifact on disk is never
// trusted for outcome, host, or criticality.

import { execa } from 'execa';
import { OrchestratorError } from '../core/errors.ts';
import { parseCriticalGlobsFromContent } from '../core/critical-globs.ts';
import { matchAny } from './glob-match.ts';
import type { ReviewVerdict, Verdict } from '../schemas/verdict.ts';
import { PinnedReviewVerdictSchema, ReviewVerdictSchema, VerdictSchema } from '../schemas/verdict.ts';

export interface ComposeCtx {
  readonly branch: string; // non-empty; caller supplies
  readonly summary: string; // non-empty; caller supplies
  readonly hasCriticalPath: boolean; // ≥1 architectural / CRITICAL.md path in the diff
  readonly secondOpinionAvailable: boolean; // review_host_cli configured & reachable
}

export type ComposeResult =
  | { readonly kind: 'verdict'; readonly verdict: Verdict }
  | { readonly kind: 'escalate'; readonly reason: string }
  | { readonly kind: 'park'; readonly reason: string };

function hasBlockFinding(review: ReviewVerdict | null): boolean {
  if (!review) return false;
  return review.findings.some((f) => f.severity === 'block');
}

// Build a schema-valid machine Verdict. compose does NOT run tests or lint, so
// both are stamped ran:false with zeroed counters (lint.clean:true is the
// vacuous "nothing ran, nothing dirty" default per the ticket).
//
// This module advertises a Verdict *bridge*, so it must GUARANTEE its output
// satisfies VerdictSchema rather than trusting ComposeCtx prose. We validate the
// constructed object and throw on violation — an empty/overlong branch or
// summary is a caller bug (invalid ComposeCtx), surfaced loudly instead of
// silently emitting a Verdict that `complete` would later reject.
function makeVerdict(
  verdict: Verdict['verdict'],
  ctx: ComposeCtx,
): { readonly kind: 'verdict'; readonly verdict: Verdict } {
  const built: Verdict = {
    version: 1,
    verdict,
    summary: ctx.summary,
    tests: { ran: false, passed: 0, failed: 0, skipped: 0, duration_ms: 0, output_excerpt: '' },
    lint: { ran: false, clean: true, violations: 0, output_excerpt: '' },
    branch: ctx.branch,
    save_point: '',
  };
  const parsed = VerdictSchema.safeParse(built);
  if (!parsed.success) {
    throw new Error(
      `review-compose: invalid ComposeCtx produced a non-schema Verdict — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return { kind: 'verdict', verdict: parsed.data };
}

export function composeReviewVerdict(
  primary: ReviewVerdict,
  secondOpinion: ReviewVerdict | null,
  ctx: ComposeCtx,
): ComposeResult {
  // Policy ordering is load-bearing. Escalate and park both pre-empt the
  // both-pass / changes branches; escalate is checked before park because a
  // blocking architectural finding already routes to a human (who can weigh the
  // missing second opinion themselves) — that is a stronger outcome than holding
  // for a review that won't change the need for a human decision.

  // 1. An architectural block finding on a critical path → escalate (emit no
  //    machine Verdict; a human decides). Fires even when no second opinion was
  //    obtained — the block finding alone warrants escalation. A block finding
  //    WITHOUT a critical path is mechanical and falls through to changes_needed.
  if (ctx.hasCriticalPath && (hasBlockFinding(primary) || hasBlockFinding(secondOpinion))) {
    return {
      kind: 'escalate',
      reason: 'Architectural block finding on a critical path — human decision required.',
    };
  }

  // 2. A critical-path change with no blocking finding MUST still be backed by an
  //    ACTUAL second opinion. If none was obtained (secondOpinion === null) we
  //    cannot safely auto-verdict, so hold — regardless of whether the host was
  //    reportedly available. Basing this on secondOpinion === null (not on
  //    secondOpinionAvailable) closes the gap where a caller claims availability
  //    but never ran/passed the review: the invariant is "no machine verdict on
  //    a critical path without a real second opinion." secondOpinionAvailable
  //    only refines the reason message.
  if (ctx.hasCriticalPath && secondOpinion === null) {
    return {
      kind: 'park',
      reason: ctx.secondOpinionAvailable
        ? 'Critical-path change requires a second opinion, but none was obtained.'
        : 'Critical-path change requires a second opinion, but the review host is unavailable.',
    };
  }

  // 3. Either review asked for changes, OR carries a block finding →
  //    changes_needed. A block finding on a critical path already escalated in
  //    step 2, so any block finding still seen here is mechanical — but a `pass`
  //    verdict can legally carry a `block` finding (the ReviewVerdict schema
  //    does not forbid it), and that must NOT slip through to ready_for_review.
  if (
    primary.verdict === 'changes_requested' ||
    secondOpinion?.verdict === 'changes_requested' ||
    hasBlockFinding(primary) ||
    hasBlockFinding(secondOpinion)
  ) {
    return makeVerdict('changes_needed', ctx);
  }

  // 4. All required reviews passed with no block findings → ready_for_review.
  return makeVerdict('ready_for_review', ctx);
}

// ---------------------------------------------------------------------------
// FORGE-231: trusted critical-path derivation + the shared policy gateway.
// ---------------------------------------------------------------------------

const GIT_ENV = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } as const;
const GIT_TIMEOUT_MS = 15_000;

async function gitOut(gitDir: string, args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd: gitDir,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    reject: false,
  });
  if (result.exitCode !== 0 || result.failed) {
    throw new OrchestratorError('IO_ERROR', `git ${args[0]} failed during critical-path derivation`, {
      args,
      exitCode: result.exitCode ?? null,
      stderr: String(result.stderr ?? '').slice(0, 500),
    });
  }
  return String(result.stdout ?? '');
}

// Presence probe with a THREE-way outcome: present | verified-absent | error.
// `git ls-tree <sha> -- CRITICAL.md` exits 0 with EMPTY stdout when the path
// is absent AT THAT REVISION (clean, verifiable absence) and non-empty stdout
// when present; a non-zero exit (bad revision, missing repo, …) is an ERROR
// and must fail closed. (cat-file -e is unsuitable: it exits 128, not 1, for
// a missing path.)
async function criticalPolicyBlob(
  gitDir: string,
  sha: string,
): Promise<{ present: boolean; content: string }> {
  const probe = await execa('git', ['ls-tree', sha, '--', 'CRITICAL.md'], {
    cwd: gitDir,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    reject: false,
  });
  if (probe.exitCode !== 0 || probe.failed) {
    throw new OrchestratorError('IO_ERROR', `cannot verify CRITICAL.md presence at ${sha}`, {
      exitCode: probe.exitCode ?? null,
      stderr: String(probe.stderr ?? '').slice(0, 500),
    });
  }
  if (String(probe.stdout ?? '').trim().length === 0) {
    return { present: false, content: '' };
  }
  return { present: true, content: await gitOut(gitDir, ['show', `${sha}:CRITICAL.md`]) };
}

export interface CriticalPathDerivation {
  readonly critical: boolean;
  readonly changedFiles: readonly string[];
  /** Why the classification fired (diagnostics; safe constants only). */
  readonly reason: 'policy_file_changed' | 'glob_match' | 'none';
}

// Derive critical-path status from IMMUTABLE inputs (R6/R7/R8):
// - changed files come from `git diff --name-only --no-renames <base>...<target>`
//   with BOTH endpoints pinned SHAs; --no-renames lists a renamed policy file
//   at BOTH its old and new path (R8 CRIT-2 — rename detection would report
//   only the destination and let `CRITICAL.md → POLICY.md` dodge the check);
// - the policy file itself is INTRINSICALLY critical: any presence or
//   blob-identity difference of CRITICAL.md between the endpoints, or its
//   appearance in the changed list, classifies critical BEFORE glob parsing;
// - globs are the tighten-only UNION of both endpoints' CRITICAL.md (a target
//   commit deleting/weakening the policy cannot clear base-revision globs);
// - FAIL-CLOSED: verified absence at both endpoints ⇒ empty globs (repos
//   without a policy behave as today); any ERROR (bad revision, failed
//   show/diff, …) throws — never silently non-critical.
export async function deriveCriticalPath(
  gitDir: string,
  baseSha: string,
  targetSha: string,
): Promise<CriticalPathDerivation> {
  for (const [label, sha] of [['baseSha', baseSha], ['targetSha', targetSha]] as const) {
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new OrchestratorError('INVALID_ID', `critical-path derivation requires a pinned 40-hex ${label}`, {
        [label]: sha,
      });
    }
  }
  const diffOut = await gitOut(gitDir, [
    'diff',
    '--name-only',
    '--no-renames',
    `${baseSha}...${targetSha}`,
  ]);
  const changedFiles = diffOut.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const base = await criticalPolicyBlob(gitDir, baseSha);
  const target = await criticalPolicyBlob(gitDir, targetSha);

  // Intrinsic criticality: the policy file changed in ANY observable way.
  const policyChanged =
    changedFiles.includes('CRITICAL.md') ||
    base.present !== target.present ||
    (base.present && target.present && base.content !== target.content);
  if (policyChanged) {
    return { critical: true, changedFiles, reason: 'policy_file_changed' };
  }

  // Tighten-only union of both endpoints' globs.
  const globs = [
    ...new Set([
      ...(base.present ? parseCriticalGlobsFromContent(base.content) : []),
      ...(target.present ? parseCriticalGlobsFromContent(target.content) : []),
    ]),
  ];
  if (globs.length > 0) {
    for (const file of changedFiles) {
      if (matchAny(file, globs).matched) {
        return { critical: true, changedFiles, reason: 'glob_match' };
      }
    }
  }
  return { critical: false, changedFiles, reason: 'none' };
}

export interface TrustedComposeInputs {
  /** JSON-parsed content of the primary review verdict file. */
  readonly primaryRaw: unknown;
  /** JSON-parsed content of the optional second-opinion verdict file. */
  readonly secondOpinionRaw?: unknown;
  /**
   * The host that is TRUSTED to have produced the primary review (from
   * settings / the session — never from a worker-writable file). When
   * supplied, the self-declared verdict host must match. Absent = lenient
   * interactive mode (caller must warn); the same-host lineage check below
   * runs regardless.
   */
  readonly expectedPrimaryHost?: ReviewVerdict['host'];
  /**
   * The pinned commit the review must speak for. When supplied, the primary
   * is parsed with PinnedReviewVerdictSchema and its target_sha (and the
   * second opinion's, when it carries one) must equal it. Absent =
   * interactive unpinned mode.
   */
  readonly expectedTargetSha?: string;
  /**
   * Critical-path inputs. `derive` runs deriveCriticalPath over pinned SHAs;
   * `flag` is STRICTLY TIGHTENING (effective = derived ∨ flag) — a caller can
   * force critical, never clear it (R6 CRIT-3).
   */
  readonly criticality: {
    readonly derive: { readonly gitDir: string; readonly baseSha: string; readonly targetSha: string } | null;
    readonly flag: boolean;
  };
  readonly branch: string;
  readonly summary: string;
  readonly secondOpinionAvailable: boolean;
}

export type TrustedComposeOutcome =
  | {
      readonly kind: 'verdict' | 'escalate' | 'park';
      readonly result: ComposeResult;
      readonly primary: ReviewVerdict;
      readonly secondOpinion: ReviewVerdict | null;
      readonly hasCriticalPath: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    };

// The single trusted policy path (R6 CRIT-3): raw parsing + host provenance +
// dual lineage + SHA pinning + DERIVED criticality + pure composition. Throws
// only for derivation failures (fail-closed I/O); everything artifact-shaped
// returns kind:'invalid' so callers emit their own typed envelopes.
export async function composeTrustedReviewOutcome(
  inputs: TrustedComposeInputs,
): Promise<TrustedComposeOutcome> {
  // (a) raw parsing — pinned schema when a target SHA is expected.
  const primarySchema = inputs.expectedTargetSha ? PinnedReviewVerdictSchema : ReviewVerdictSchema;
  const primaryParsed = primarySchema.safeParse(inputs.primaryRaw);
  if (!primaryParsed.success) {
    return {
      kind: 'invalid',
      reason: `primary review verdict failed ${inputs.expectedTargetSha ? 'pinned ' : ''}schema validation`,
      detail: { kind: 'primary', zodError: primaryParsed.error.message },
    };
  }
  const primary = primaryParsed.data;

  // (b) host provenance: the trusted caller names the host that actually
  // produced the review; a self-declared label cannot fake it.
  if (inputs.expectedPrimaryHost && primary.host !== inputs.expectedPrimaryHost) {
    return {
      kind: 'invalid',
      reason: `primary review verdict has host:'${primary.host}' which does not match the expected primary review host '${inputs.expectedPrimaryHost}' supplied by the orchestrator; the dual-lineage gate verifies provenance, not the self-declared host.`,
      detail: { kind: 'primary', claimed: primary.host, expected: inputs.expectedPrimaryHost },
    };
  }

  // SHA pinning: the witness must speak for the pinned commit.
  if (inputs.expectedTargetSha && primary.target_sha !== inputs.expectedTargetSha) {
    return {
      kind: 'invalid',
      reason: `primary review verdict is pinned to ${primary.target_sha ?? '<none>'} but the orchestrator expected ${inputs.expectedTargetSha}`,
      detail: { kind: 'primary', claimed: primary.target_sha ?? null, expected: inputs.expectedTargetSha },
    };
  }

  let secondOpinion: ReviewVerdict | null = null;
  if (inputs.secondOpinionRaw !== undefined && inputs.secondOpinionRaw !== null) {
    // In PINNED mode the second opinion must be pinned too (R1 CRIT-1): an
    // unpinned artifact from another host could satisfy the critical-path
    // second-opinion requirement while vouching for an unknown commit.
    const secondSchema = inputs.expectedTargetSha ? PinnedReviewVerdictSchema : ReviewVerdictSchema;
    const secondParsed = secondSchema.safeParse(inputs.secondOpinionRaw);
    if (!secondParsed.success) {
      return {
        kind: 'invalid',
        reason: `second-opinion verdict failed ${inputs.expectedTargetSha ? 'pinned ' : ''}schema validation`,
        detail: { kind: 'second-opinion', zodError: secondParsed.error.message },
      };
    }
    // Dual lineage: a second opinion MUST come from a DIFFERENT host than the
    // primary review (same-host pairs, including claude+claude, are rejected).
    if (secondParsed.data.host === primary.host) {
      return {
        kind: 'invalid',
        reason: `second-opinion verdict has host:'${secondParsed.data.host}' which matches the primary review host; a second opinion must come from a different host than the primary review (same-host pairs, including claude+claude, are rejected).`,
        detail: { kind: 'second-opinion', primaryHost: primary.host, secondHost: secondParsed.data.host },
      };
    }
    // Pin equality when both sides carry a target: a second opinion for a
    // DIFFERENT commit must not vouch for this one.
    if (
      inputs.expectedTargetSha &&
      secondParsed.data.target_sha !== undefined &&
      secondParsed.data.target_sha !== inputs.expectedTargetSha
    ) {
      return {
        kind: 'invalid',
        reason: `second-opinion verdict is pinned to ${secondParsed.data.target_sha} but the orchestrator expected ${inputs.expectedTargetSha}`,
        detail: { kind: 'second-opinion', claimed: secondParsed.data.target_sha, expected: inputs.expectedTargetSha },
      };
    }
    secondOpinion = secondParsed.data;
  }

  // (c) trusted criticality: derived ∨ tightening flag. Derivation failures
  // THROW (fail-closed) — a review of unverifiable criticality never composes.
  let derived = false;
  if (inputs.criticality.derive !== null) {
    const d = inputs.criticality.derive;
    derived = (await deriveCriticalPath(d.gitDir, d.baseSha, d.targetSha)).critical;
  }
  const hasCriticalPath = derived || inputs.criticality.flag;

  // (d)+(e) second-opinion requirement policy + composition (pure).
  let result = composeReviewVerdict(primary, secondOpinion, {
    branch: inputs.branch,
    summary: inputs.summary,
    hasCriticalPath,
    secondOpinionAvailable: inputs.secondOpinionAvailable,
  });
  // A PINNED composition carries the pin forward on the composed carrier, so
  // downstream consumers (the completion gate) can verify carrier and witness
  // speak for the same commit.
  if (result.kind === 'verdict' && inputs.expectedTargetSha) {
    result = { kind: 'verdict', verdict: { ...result.verdict, target_sha: inputs.expectedTargetSha } };
  }
  return { kind: result.kind, result, primary, secondOpinion, hasCriticalPath };
}
