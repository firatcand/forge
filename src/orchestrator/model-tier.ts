import { MODEL_TIERS, type ModelTier } from '../schemas/phases.ts';

// FORGE-211: pure resolver for the effective model tier of a single dispatch
// attempt. The route verb (FORGE-210) is the consumer — it derives
// `touchesCriticalPath` (write_globs ∩ preflight_globs / diff) and resolves the
// returned tier to a concrete model via the catalog (FORGE-212). This module
// only owns the tier ARITHMETIC and its escalation semantics.
//
// SEMANTICS (R1 — the stamp is authoritative, floor-only escalation):
//   base = taskTier ?? defaultTier
//     The task's stamp IS the floor. `defaultTier` is the fallback ONLY when the
//     task is UNSTAMPED — a `small` stamp must stay `small` even when the
//     default is `standard` (cost-routing: cheap tasks use cheap models). We do
//     NOT max() the stamp against the default; that would defeat the `small`
//     tier entirely.
//   Runtime overrides raise the tier UPWARD FROM THE FLOOR, never below it:
//     - touchesCriticalPath → max(base, 'frontier')  (CRITICAL.md paths)
//     - attemptCount > 0     → bump up by attemptCount notches (failed-attempt
//                              retry escalation), capped at the top tier.
//   "Never lowered at runtime" means never below the stamp/floor — NOT never
//   below the default. No input combination ever returns a tier below `base`.

export interface EffectiveModelTierInput {
  /** The task's `model_tier` stamp (the floor), if present. */
  taskTier?: ModelTier;
  /** Number of prior FAILED attempts for this task (0 on the first attempt). */
  attemptCount?: number;
  /** True when the attempt writes to a CRITICAL.md / preflight path. */
  touchesCriticalPath?: boolean;
  /** settings.agents.default_model_tier — fallback for an unstamped task. */
  defaultTier: ModelTier;
}

export function effectiveModelTier(input: EffectiveModelTierInput): ModelTier {
  const { taskTier, attemptCount = 0, touchesCriticalPath = false, defaultTier } = input;

  // The stamp is the authoritative floor; default only fills an unstamped task.
  const base = taskTier ?? defaultTier;
  const idx0 = MODEL_TIERS.indexOf(base);
  // Defensive: this is an exported pure fn; an unknown tier (e.g. via a cast,
  // a stale journal, or a future unchecked caller) would make indexOf return -1
  // and silently yield a wrong/undefined tier. Fail loud instead.
  if (idx0 < 0) {
    throw new Error(`effectiveModelTier: unknown tier '${String(base)}' (valid: ${MODEL_TIERS.join(', ')})`);
  }
  // attemptCount must be a non-negative finite integer, else the index math below
  // (idx + attemptCount) could produce NaN / a negative index.
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error(`effectiveModelTier: attemptCount must be a non-negative integer, got ${String(attemptCount)}`);
  }
  let idx = idx0;

  // CRITICAL path → escalate to (at least) the top tier — upward-only.
  if (touchesCriticalPath) {
    idx = Math.max(idx, MODEL_TIERS.indexOf('frontier'));
  }

  // Failed-attempt retry → bump up by `attemptCount` notches, capped at the top.
  if (attemptCount > 0) {
    idx = Math.min(idx + attemptCount, MODEL_TIERS.length - 1);
  }

  return MODEL_TIERS[idx]!;
}
