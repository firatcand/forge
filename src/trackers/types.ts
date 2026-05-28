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
  // FORGE-145: local-lease claim identity mirrored onto the tracker via the
  // `forge:claim` body fence (see src/trackers/claim-fence.ts). Populated on
  // read by each adapter; absent when no fence is present. Advisory only —
  // never the authority for lease ownership, which stays the generation-fenced
  // local lease. gc reads these to detect tracker/local claim divergence.
  claimId?: string;
  claimGeneration?: number;
  claimOwnerRunId?: string;
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
