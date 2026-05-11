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

export interface CreateIssuePayload {
  title: string;
  body: string;
  forgeTaskId: string;
  ownerType: string;
  acceptance: string[];
  dependsOn: string[];
}

export type ClaimFailureReason =
  | 'already_claimed'
  | 'state_changed'
  | 'transient_error';

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: ClaimFailureReason; detail?: string };

export type TrackerType = 'linear' | 'github' | 'notion';
