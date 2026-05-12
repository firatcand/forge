export type {
  Issue,
  IssueState,
  CreateIssuePayload,
  ClaimResult,
  ClaimFailureReason,
  TrackerType,
} from './types.ts';

export {
  TrackerError,
  isRetriableTrackerErrorCode,
} from './errors.ts';
export type { TrackerErrorCode } from './errors.ts';

export { BaseTracker } from './base.ts';
export type {
  Tracker,
  Logger,
  WithRetryOpts,
  NormalizeErrorHint,
} from './base.ts';

export {
  parseForgeFooters,
  serializeWithForgeFooters,
} from './footers.ts';
export type { ForgeFooters } from './footers.ts';

export {
  GH_LIST_LIMIT,
  GitHubTracker,
  classifyGitHubError,
} from './github.ts';
export type {
  GhExec,
  GhExecResult,
  GitHubTrackerOptions,
} from './github.ts';

export {
  LINEAR_LIST_LIMIT,
  LinearTracker,
  classifyLinearError,
  wrapLinearClient,
} from './linear.ts';
export type {
  LinearIssueLike,
  LinearWorkflowStateLike,
  LinearLabelLike,
  LinearCreateIssueInput,
  LinearUpdateIssueInput,
  LinearCreateProjectInput,
  LinearSdkLike,
  LinearStateType,
  LinearTrackerOptions,
} from './linear.ts';
