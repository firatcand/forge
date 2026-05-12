// Fixture builders for LinearTracker unit tests. Mirrors the shape of
// github-responses.ts. All builders return plain LinearSdkLike-compatible
// objects (the wrapper layer's output, not raw @linear/sdk shapes).

import type {
  LinearIssueLike,
  LinearLabelLike,
  LinearStateType,
  LinearWorkflowStateLike,
} from '../../../src/trackers/linear.ts';

// ─── Workflow states ─────────────────────────────────────────────────────────

export const STATE_TODO: LinearWorkflowStateLike = {
  id: 'state-todo',
  name: 'Todo',
  type: 'unstarted',
};

export const STATE_BACKLOG: LinearWorkflowStateLike = {
  id: 'state-backlog',
  name: 'Backlog',
  type: 'backlog',
};

export const STATE_IN_PROGRESS: LinearWorkflowStateLike = {
  id: 'state-in-progress',
  name: 'In Progress',
  type: 'started',
};

export const STATE_DONE: LinearWorkflowStateLike = {
  id: 'state-done',
  name: 'Done',
  type: 'completed',
};

export const STATE_CANCELED: LinearWorkflowStateLike = {
  id: 'state-canceled',
  name: 'Canceled',
  type: 'canceled',
};

export const DEFAULT_WORKFLOW_STATES: LinearWorkflowStateLike[] = [
  STATE_TODO,
  STATE_BACKLOG,
  STATE_IN_PROGRESS,
  STATE_DONE,
  STATE_CANCELED,
];

// ─── Labels ──────────────────────────────────────────────────────────────────

export const LABEL_STATE_IN_REVIEW: LinearLabelLike = {
  id: 'label-state-in-review',
  name: 'state:in-review',
};

export const LABEL_STATE_BLOCKED: LinearLabelLike = {
  id: 'label-state-blocked',
  name: 'state:blocked',
};

export function makeClaimLabel(agentId: string): LinearLabelLike {
  return { id: `label-claim-${agentId}`, name: `claimed:agent-${agentId}` };
}

// ─── Issues ──────────────────────────────────────────────────────────────────

export interface MakeIssueOpts {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  state?: LinearWorkflowStateLike;
  labels?: ReadonlyArray<LinearLabelLike>;
}

export function makeIssue(opts: MakeIssueOpts = {}): LinearIssueLike {
  const id = opts.id ?? 'issue-1';
  return {
    id,
    identifier: opts.identifier ?? 'FORGE-1',
    title: opts.title ?? 'sample issue',
    description: opts.description === undefined ? '' : opts.description,
    url: opts.url ?? `https://linear.app/test/issue/${opts.identifier ?? 'FORGE-1'}`,
    state: opts.state ?? STATE_TODO,
    labels: [...(opts.labels ?? [])],
  };
}

// ─── Error shapes ────────────────────────────────────────────────────────────

export function makeLinearAuthError(
  message = 'Authentication required',
): Error & { status: number; type: string } {
  const err = new Error(message) as Error & { status: number; type: string };
  err.status = 401;
  err.type = 'AuthenticationError';
  return err;
}

export function makeLinearNotFoundError(
  message = 'Entity not found',
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 404;
  return err;
}

export function makeLinearRateLimitError(
  retryAfterSeconds?: number,
): Error & { status: number; type: string } {
  const msg =
    retryAfterSeconds === undefined
      ? 'Rate limit exceeded'
      : `Rate limit exceeded; retry-after: ${retryAfterSeconds}`;
  const err = new Error(msg) as Error & { status: number; type: string };
  err.status = 429;
  err.type = 'Ratelimited';
  return err;
}

export function makeLinearValidationError(
  message = 'Validation failed: invalid input',
): Error & { status: number; type: string } {
  const err = new Error(message) as Error & { status: number; type: string };
  err.status = 422;
  err.type = 'InvalidInput';
  return err;
}

export function makeLinearConflictError(
  message = 'already exists',
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 409;
  return err;
}

export function makeLinearTransportError(
  message = 'ECONNRESET',
): Error & { code: string; status: number } {
  const err = new Error(message) as Error & { code: string; status: number };
  err.code = 'ECONNRESET';
  err.status = 503;
  return err;
}

export function makeLinearTimeoutError(): Error & { code: string } {
  const err = new Error('request timed out') as Error & { code: string };
  err.code = 'ETIMEDOUT';
  return err;
}

// ─── State-mutation helper for MockLinearSdk ─────────────────────────────────

/**
 * Mutable issue state used by MockLinearSdk to simulate server-side state in
 * race tests + conformance tests. Shared across multiple LinearTracker
 * instances so claim-race coverage actually observes concurrent label
 * additions in deterministic order.
 */
export class MockServerState {
  private readonly issues = new Map<string, LinearIssueLike>();
  private readonly labelsByName = new Map<string, LinearLabelLike>();
  private nextLabelId = 1;

  constructor(initialIssues: ReadonlyArray<LinearIssueLike> = []) {
    for (const i of initialIssues) {
      this.issues.set(i.id, structuredClone(i));
      for (const l of i.labels) this.labelsByName.set(l.name, l);
    }
  }

  ensureLabel(name: string): LinearLabelLike {
    const existing = this.labelsByName.get(name);
    if (existing) return existing;
    const created: LinearLabelLike = {
      id: `mock-label-${this.nextLabelId++}-${name}`,
      name,
    };
    this.labelsByName.set(name, created);
    return created;
  }

  getIssue(id: string): LinearIssueLike {
    const issue = this.issues.get(id);
    if (!issue) throw makeLinearNotFoundError(`issue ${id} not found`);
    return structuredClone(issue);
  }

  setIssue(issue: LinearIssueLike): void {
    this.issues.set(issue.id, structuredClone(issue));
  }

  addLabel(issueId: string, labelName: string): LinearIssueLike {
    const issue = this.issues.get(issueId);
    if (!issue) throw makeLinearNotFoundError(`issue ${issueId} not found`);
    const label = this.ensureLabel(labelName);
    if (!issue.labels.some((l) => l.id === label.id)) {
      const next: LinearIssueLike = {
        ...issue,
        labels: [...issue.labels, label],
      };
      this.issues.set(issueId, next);
      return structuredClone(next);
    }
    return structuredClone(issue);
  }

  removeLabel(issueId: string, labelId: string): LinearIssueLike {
    const issue = this.issues.get(issueId);
    if (!issue) throw makeLinearNotFoundError(`issue ${issueId} not found`);
    const next: LinearIssueLike = {
      ...issue,
      labels: issue.labels.filter((l) => l.id !== labelId),
    };
    this.issues.set(issueId, next);
    return structuredClone(next);
  }

  listIssues(): LinearIssueLike[] {
    return [...this.issues.values()].map((i) => structuredClone(i));
  }

  /** All labels currently known to the mock server. */
  allLabels(): LinearLabelLike[] {
    return [...this.labelsByName.values()];
  }

  /** Find a label by its server-assigned id (or undefined if unknown). */
  labelById(id: string): LinearLabelLike | undefined {
    for (const l of this.labelsByName.values()) {
      if (l.id === id) return l;
    }
    return undefined;
  }
}
