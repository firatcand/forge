import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertLegalTransition } from '../../../src/orchestrator/state-machine.ts';
import { OrchestratorError } from '../../../src/core/errors.ts';

// FORGE-184: a review-phase worker that hits an architectural question parks
// from ready_for_review. No new state/trigger — it reuses 'question_written'
// → blocked_on_question, the same move running already had.

test('ready_for_review --[question_written]--> blocked_on_question is legal (FORGE-184)', () => {
  assert.doesNotThrow(() =>
    assertLegalTransition('ready_for_review', 'blocked_on_question', 'question_written'),
  );
});

test('running --[question_written]--> blocked_on_question stays legal (regression)', () => {
  assert.doesNotThrow(() =>
    assertLegalTransition('running', 'blocked_on_question', 'question_written'),
  );
});

test('a sampling of still-illegal transitions throw ILLEGAL_TRANSITION', () => {
  // ready_for_review cannot complete straight to ready_for_review (that's a
  // review-passed move via 'review_passed' → reviewed, not a re-complete).
  assert.throws(
    () =>
      assertLegalTransition(
        'ready_for_review',
        'reviewed',
        'complete_ready_for_review',
      ),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );

  // shipped is terminal — nothing fires from it.
  assert.throws(
    () => assertLegalTransition('shipped', 'reviewed', 'review_passed'),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );

  // FORGE-234: reviewed:question_written became LEGAL (ship policy park);
  // an arbitrary-state question (e.g. claimed) is still illegal.
  assert.doesNotThrow(() =>
    assertLegalTransition('reviewed', 'blocked_on_question', 'question_written'),
  );
  assert.throws(
    () => assertLegalTransition('claimed', 'blocked_on_question', 'question_written'),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});
