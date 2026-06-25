// Canonical agent-host vocabulary. Lives in the schema layer (no upward deps)
// so settings.ts and the availability preflight share one source of truth.
// Previously these were CATALOG_HOSTS in the (now-removed) models-catalog.ts.

export const HOSTS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type Host = (typeof HOSTS)[number];

// Hosts eligible as a second-opinion / review host. Review hosts now include
// claude (FORGE-223/FORGE-224 shipped ClaudeHarness.runReview via `claude -p`).
// The only invariant is that the second-opinion / review host must DIFFER from
// the primary host — enforced by the settings refine + the review-compose
// same-host gate.
export const REVIEW_HOSTS = ['claude', 'codex', 'gemini'] as const;
export type ReviewHost = (typeof REVIEW_HOSTS)[number];
