// Canonical agent-host vocabulary. Lives in the schema layer (no upward deps)
// so settings.ts and the availability preflight share one source of truth.
// Previously these were CATALOG_HOSTS in the (now-removed) models-catalog.ts.

export const HOSTS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type Host = (typeof HOSTS)[number];

// Hosts eligible as a second-opinion review host (never the primary).
export const REVIEW_HOSTS = ['codex', 'gemini'] as const;
export type ReviewHost = (typeof REVIEW_HOSTS)[number];
