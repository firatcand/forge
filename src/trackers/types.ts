export type IssueState =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'
  | 'blocked';

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  state: IssueState;
  blockerIds: string[];
  url?: string;
  forgeTaskId?: string;
}

// Result of listAllIssues. `truncated` is true when the adapter hit its
// page/limit cap, so the set may be incomplete. reconcile --pull MUST NOT prune
// orphans from a truncated view — an absent issue could simply be off-page, not
// deleted. Callers fail closed (skip orphan detection) when truncated.
export interface IssueListPage {
  issues: Issue[];
  truncated: boolean;
}

export interface CreateIssuePayload {
  title: string;
  body: string;
  forgeTaskId: string;
  ownerType: string;
  acceptance: string[];
  dependsOn: string[];
}

// v2 contract (FORGE-72): 'state_changed' deleted; 'version_conflict' added.
// Semantics are identical ("the version we expected isn't current") — every
// adapter call site that returned state_changed now returns version_conflict.
// Per-adapter CAS hardening (real version readback) lands in FORGE-76/77.
export type ClaimFailureReason =
  | 'already_claimed'
  | 'version_conflict'
  | 'transient_error';

export type ClaimResult =
  | { ok: true; tracker_version?: string }
  | { ok: false; reason: ClaimFailureReason; detail?: string };

export type TrackerType = 'linear' | 'github' | 'notion';
