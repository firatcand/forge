import { z } from 'zod';

// ── The single source of truth for task-id shape ─────────────────────────────
//
// FORGE-130 unifies a previously-fragmented set of per-site task-id validators
// into ONE primitive (regex + predicate + zod schema). Each existing validation
// site WRAPS this primitive while preserving its own error codes and any
// intentional policy differences — see the consumer list below.
//
// Shape: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`
//   - First char MUST be alphanumeric (no leading `.`, `-`, or `_`).
//     Leading `.` would create dotfile path segments; leading `-` would be
//     interpreted as a flag by git/CLI tools; both are path-hazard vectors.
//   - Remaining chars: alphanumeric plus `.`, `_`, `-` (path-safe punctuation).
//   - No `/`, `\`, `#`, whitespace, or control chars — none of these can appear
//     in a filesystem-path segment safely, and `#` in particular is the legacy
//     GitHub `#42` shape that this schema deliberately rejects (the GitHub
//     adapter normalizes to `GH-42` at its boundary — see src/trackers/github.ts).
//   - 1–64 chars total (1 leading + up to 63 trailing).
//
// Accepted shapes (non-exhaustive):
//   - Linear / tracker:  FORGE-98, ABC-1234, ETOE-1
//   - GitHub (normalized): GH-42
//   - phases.yaml:        P2.5-T07, P1-T3
//   - lowercase:          lin-99
//   - UUIDs (run/attempt/Notion page ids): 018f1e2a-dead-7abc-bdef-01234567890a
//
// Rejected shapes:
//   - `#42`  (legacy GitHub — normalized to GH-42 at the adapter boundary)
//   - `../x`, `a/b`, `a\b`  (path traversal / separators)
//   - `.foo`, `-foo`, `_foo`  (leading punctuation)
//   - `..`  (leading dot → rejected by the leading-alnum anchor)
//   - 65+ chars, empty string
//
// ── Consumers (each WRAPS this primitive) ────────────────────────────────────
//   - src/schemas/cli-args.ts       — TaskIdSchema re-export (zod, INVALID_ARGS)
//   - src/orchestrator/questions/paths.ts — validateIdSegment (QuestionChannelError
//     INVALID_ID); ALSO validates run/attempt UUID *segments*, which all pass
//     this shape (hyphens + alnum).
//   - src/core/workspace.ts         — sanitizeIssueId / ALLOWED_PATTERN (granular
//     WorkspaceError codes: EMPTY, TOO_LONG, LEADING_DASH, PATH_TRAVERSAL,
//     CONTROL_CHAR, INVALID_CHAR). Workspace additionally narrows leading `.`
//     (its old ALLOWED_PATTERN permitted `.foo`; the unified shape does not).
//   - src/cli/orchestrate/gc.ts     — isValidTaskId (replaces FORGE-116's local
//     dual-regex copy).
//
// Two intentional narrowings vs the prior per-site shapes (FORGE-130 delta 1):
//   1. workspace.ts old ALLOWED_PATTERN `/^[A-Za-z0-9._-]+$/` permitted a leading
//      `.` (e.g. `.foo`). The unified shape requires a leading alphanumeric.
//   2. questions/paths.ts old ID_SEGMENT_REGEX `/^[A-Za-z0-9_-]+$/` permitted a
//      leading `_` or `-` (e.g. `_foo`, `-foo`). The unified shape rejects both.
// No repo path, fixture, or plausible adopter id depended on these — UUID
// run/attempt/Notion ids all start with a hex digit, and every tracker/phases
// shape starts alphanumeric. Tests in test/unit/schemas/task-id.test.ts prove it.

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const TASK_ID_MAX_LEN = 64;

export function isValidTaskId(id: string): boolean {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

export const TaskIdSchema = z
  .string()
  .regex(
    TASK_ID_RE,
    'task_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (alphanumeric start; letters, digits, . _ - ; max 64; no #, /, or whitespace)',
  );
