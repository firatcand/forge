// Pure retry policy — exponential backoff with cap, attempt-count enforcement,
// and error classification. No I/O. Consumed by:
//   - `forge orchestrate complete` (writes failure_reason on terminal failure)
//   - `forge orchestrate phases --ready` (filters tasks whose backoff hasn't elapsed)
//   - `src/orchestrator/gc.ts` row classification
//
// Spec: spec/ORCHESTRATOR.md §"gc reconciliation rules" — retry-policy AC bullets.
// Settings: agents.retry_attempts (default 10), agents.retry_backoff_ms_max (default 300_000).

import { OrchestratorError } from '../core/errors.ts';
import type { FailureReason } from '../schemas/task-state.ts';

export interface RetryPolicy {
  readonly retry_attempts: number;
  readonly retry_backoff_ms_max: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retry_attempts: 10,
  retry_backoff_ms_max: 300_000,
};

export type ErrorClass = 'transient' | 'decision_key_budget' | 'fatal';

// Symphony backoff: delay = min(1000 * 2^(attempt-1), retry_backoff_ms_max).
// `attempt` is 1-indexed; the FIRST retry is attempt=1 → 1000ms backoff.
export function backoffMs(attempt: number, policy: RetryPolicy): number {
  if (attempt < 1) return 0;
  const exp = 1000 * Math.pow(2, attempt - 1);
  return Math.min(exp, policy.retry_backoff_ms_max);
}

// When is this task eligible to be retried, given the last failure timestamp?
export function nextEligibleAt(
  attempt: number,
  lastFailedAt: string | Date,
  policy: RetryPolicy,
): Date {
  const base = lastFailedAt instanceof Date ? lastFailedAt : new Date(lastFailedAt);
  return new Date(base.getTime() + backoffMs(attempt, policy));
}

export interface NextRetryDecision {
  readonly state: 'retry' | 'failed';
  readonly failure_reason?: FailureReason;
}

// Decide what happens to a task after an attempt fails.
//   decision_key_budget → terminal 'failed' with reason 'decision_key_budget' (no retry)
//   fatal               → terminal 'failed' with reason 'fatal'
//   transient + cap hit → terminal 'failed' with reason 'retries_exhausted'
//   transient + room    → 'retry' (caller schedules via nextEligibleAt)
//
// `attempt` is the just-completed attempt number (1-indexed). attempt === retry_attempts
// means the cap is hit and we must NOT schedule another retry.
export function nextRetryState(
  attempt: number,
  errorClass: ErrorClass,
  policy: RetryPolicy,
): NextRetryDecision {
  if (errorClass === 'decision_key_budget') {
    return { state: 'failed', failure_reason: 'decision_key_budget' };
  }
  if (errorClass === 'fatal') {
    return { state: 'failed', failure_reason: 'fatal' };
  }
  if (attempt >= policy.retry_attempts) {
    return { state: 'failed', failure_reason: 'retries_exhausted' };
  }
  return { state: 'retry' };
}

// Classify an error into a retry class. Producer for DECISION_KEY_EXHAUSTED
// is deferred (see FORGE-22 plan §Scope) — until it ships, decision_key_budget
// classification is dormant.
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof OrchestratorError) {
    if (err.code === 'DECISION_KEY_EXHAUSTED') return 'decision_key_budget';
    if (
      err.code === 'SCHEMA_INVALID' ||
      err.code === 'INVALID_ID' ||
      err.code === 'ILLEGAL_TRANSITION'
    ) {
      return 'fatal';
    }
  }
  return 'transient';
}
