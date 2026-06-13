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
// This module is PURE: no I/O, no clock, no filesystem. The caller runs reviews,
// detects critical paths, and probes reviewer availability; compose only decides.

import type { ReviewVerdict, Verdict } from '../schemas/verdict.ts';
import { VerdictSchema } from '../schemas/verdict.ts';

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
