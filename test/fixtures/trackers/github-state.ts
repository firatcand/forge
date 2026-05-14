// State-backed mock for the `gh` CLI used by GitHubTracker.
//
// Parallel to MockServerState in linear-responses.ts. Unlike Linear's
// MockGh-in-github.test.ts (a sequenced-response queue), this mock holds
// in-memory state and dispatches each `gh args[]` invocation into mutations
// against that state. This lets the shared `runTrackerConformance` helper
// call the 9 Tracker methods in any order without rigging up a per-test
// response queue.
//
// Scope: covers exactly the gh subcommands GitHubTracker emits today. Adding
// a new gh call in src/trackers/github.ts requires extending the dispatcher
// here.

import { GitHubTracker } from '../../../src/trackers/github.ts';
import type {
  GhExec,
  GhExecResult,
  Logger,
} from '../../../src/trackers/index.ts';
import type { GithubTrackerConfig } from '../../../src/schemas/settings.ts';

// ─── State shape ─────────────────────────────────────────────────────────────

export interface MockGhIssue {
  /** gh node ID (opaque string). */
  id: string;
  /** Numeric issue number — what the tracker passes as issueId. */
  number: number;
  title: string;
  body: string | null;
  /** Canonical issue URL — what `gh issue create` echoes back. */
  url: string;
  labels: string[];
  state: 'open' | 'closed';
  closeReason?: 'completed' | 'not planned';
}

export interface MockGhMilestone {
  number: number;
  title: string;
  description?: string;
  html_url: string;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

const DEFAULT_REPO_FOR_URL = 'firatcand/forge-test';

export function makeMockGhIssue(
  opts: Partial<MockGhIssue> & { number: number },
  repo: string = DEFAULT_REPO_FOR_URL,
): MockGhIssue {
  return {
    id: opts.id ?? `I_mock_${opts.number}`,
    number: opts.number,
    title: opts.title ?? `Mock issue ${opts.number}`,
    body: opts.body ?? null,
    url:
      opts.url ?? `https://github.com/${repo}/issues/${opts.number}`,
    labels: opts.labels ? [...opts.labels] : [],
    state: opts.state ?? 'open',
    ...(opts.closeReason !== undefined
      ? { closeReason: opts.closeReason }
      : {}),
  };
}

// ─── execa-shaped error ──────────────────────────────────────────────────────

function ghError(stderr: string, exitCode = 1): Error & {
  stderr: string;
  stdout: string;
  exitCode: number;
} {
  const err = new Error(`Command failed: gh\n${stderr}`) as Error & {
    stderr: string;
    stdout: string;
    exitCode: number;
  };
  err.stderr = stderr;
  err.stdout = '';
  err.exitCode = exitCode;
  return err;
}

// ─── State server ────────────────────────────────────────────────────────────

export interface MockGhServerStateOpts {
  repo: string;
  initialIssues?: MockGhIssue[];
}

export class MockGhServerState {
  private readonly issues = new Map<number, MockGhIssue>();
  private readonly labels = new Set<string>();
  private readonly milestones = new Map<number, MockGhMilestone>();
  private nextIssueNumber: number;
  private nextMilestoneNumber = 1;
  readonly repo: string;
  /** Diagnostic record of every dispatched gh call. */
  readonly calls: Array<readonly string[]> = [];

  constructor(opts: MockGhServerStateOpts) {
    this.repo = opts.repo;
    for (const issue of opts.initialIssues ?? []) {
      this.issues.set(issue.number, structuredClone(issue));
      for (const l of issue.labels) this.labels.add(l);
    }
    const maxSeed = Math.max(0, ...[...this.issues.keys()]);
    this.nextIssueNumber = maxSeed + 1 < 100 ? 100 : maxSeed + 1;
  }

  exec: GhExec = async (args) => {
    const argv = [...args];
    this.calls.push(argv);
    return this.dispatch(argv);
  };

  // ─── inspectors (parallel to Linear MockServerState) ───────────────────────

  getIssue(number: number): MockGhIssue | undefined {
    const issue = this.issues.get(number);
    return issue ? structuredClone(issue) : undefined;
  }

  allLabels(): string[] {
    return [...this.labels].sort();
  }

  allMilestones(): MockGhMilestone[] {
    return [...this.milestones.values()].map((m) => structuredClone(m));
  }

  // ─── dispatcher ────────────────────────────────────────────────────────────

  private dispatch(args: string[]): GhExecResult {
    const [cmd, sub, ...rest] = args;

    if (cmd === 'auth' && sub === 'status') {
      return okResult('Logged in to github.com as mock-user\n');
    }

    if (cmd === 'issue') {
      switch (sub) {
        case 'list':
          return this.handleIssueList(rest);
        case 'view':
          return this.handleIssueView(rest);
        case 'edit':
          return this.handleIssueEdit(rest);
        case 'create':
          return this.handleIssueCreate(rest);
        case 'close':
          return this.handleIssueClose(rest);
        case 'reopen':
          return this.handleIssueReopen(rest);
        case 'comment':
          return this.handleIssueComment(rest);
      }
    }

    if (cmd === 'label' && sub === 'create') {
      return this.handleLabelCreate(rest);
    }

    if (cmd === 'api') {
      return this.handleApi(sub, rest);
    }

    throw ghError(
      `MockGhServerState: unhandled command: gh ${args.join(' ')}\n`,
      1,
    );
  }

  // ─── issue list ────────────────────────────────────────────────────────────

  private handleIssueList(rest: string[]): GhExecResult {
    const state = flagValue(rest, '--state') ?? 'open';
    const jsonFields = parseJsonFields(flagValue(rest, '--json'));
    const all = [...this.issues.values()];
    const filtered =
      state === 'open'
        ? all.filter((i) => i.state === 'open')
        : state === 'closed'
          ? all.filter((i) => i.state === 'closed')
          : all;
    const projected = filtered.map((i) => projectIssue(i, jsonFields));
    return jsonResult(projected);
  }

  // ─── issue view ────────────────────────────────────────────────────────────

  private handleIssueView(rest: string[]): GhExecResult {
    const number = parsePositionalNumber(rest, 'issue view');
    const issue = this.requireIssue(number);
    const jsonFields = parseJsonFields(flagValue(rest, '--json'));
    return jsonResult(projectIssue(issue, jsonFields));
  }

  // ─── issue edit ────────────────────────────────────────────────────────────

  private handleIssueEdit(rest: string[]): GhExecResult {
    const number = parsePositionalNumber(rest, 'issue edit');
    const issue = this.requireIssue(number);

    const addLabels = collectLabels(rest, '--add-label');
    const removeLabels = collectLabels(rest, '--remove-label');
    const newBody = flagValue(rest, '--body');

    let labels = [...issue.labels];
    for (const l of addLabels) {
      this.labels.add(l);
      if (!labels.includes(l)) labels.push(l);
    }
    if (removeLabels.length > 0) {
      labels = labels.filter((l) => !removeLabels.includes(l));
    }
    // Stable lex order so JSON projections are deterministic across runs.
    labels.sort();

    const next: MockGhIssue = {
      ...issue,
      labels,
      ...(newBody !== undefined ? { body: newBody } : {}),
    };
    this.issues.set(number, next);
    return okResult('');
  }

  // ─── issue create ──────────────────────────────────────────────────────────

  private handleIssueCreate(rest: string[]): GhExecResult {
    const title = flagValue(rest, '--title');
    const body = flagValue(rest, '--body');
    if (title === undefined) {
      throw ghError(
        'MockGhServerState: issue create requires --title\n',
        1,
      );
    }
    const number = this.nextIssueNumber++;
    const issue: MockGhIssue = {
      id: `I_mock_${number}`,
      number,
      title,
      body: body ?? null,
      url: `https://github.com/${this.repo}/issues/${number}`,
      labels: [],
      state: 'open',
    };
    this.issues.set(number, issue);
    // Real `gh issue create` prints the URL followed by a newline.
    return okResult(`${issue.url}\n`);
  }

  // ─── issue close / reopen ──────────────────────────────────────────────────

  private handleIssueClose(rest: string[]): GhExecResult {
    const number = parsePositionalNumber(rest, 'issue close');
    const issue = this.requireIssue(number);
    const reason = flagValue(rest, '--reason');
    if (reason !== undefined && reason !== 'completed' && reason !== 'not planned') {
      throw ghError(
        `MockGhServerState: issue close --reason must be 'completed' or 'not planned', got: ${reason}\n`,
        1,
      );
    }
    const next: MockGhIssue = {
      ...issue,
      state: 'closed',
      ...(reason ? { closeReason: reason as 'completed' | 'not planned' } : {}),
    };
    this.issues.set(number, next);
    return okResult('');
  }

  private handleIssueReopen(rest: string[]): GhExecResult {
    const number = parsePositionalNumber(rest, 'issue reopen');
    const issue = this.requireIssue(number);
    // Idempotent — already-open returns success silently (tracker tolerates).
    const { closeReason: _drop, ...rest2 } = issue;
    const next: MockGhIssue = { ...rest2, state: 'open' };
    this.issues.set(number, next);
    return okResult('');
  }

  // ─── issue comment ─────────────────────────────────────────────────────────

  private handleIssueComment(rest: string[]): GhExecResult {
    const number = parsePositionalNumber(rest, 'issue comment');
    this.requireIssue(number);
    // No state to mutate — tracker doesn't read comments back.
    return okResult('');
  }

  // ─── label create ──────────────────────────────────────────────────────────

  private handleLabelCreate(rest: string[]): GhExecResult {
    // First positional is the label name.
    const name = rest.find((a) => !a.startsWith('-'));
    if (name === undefined) {
      throw ghError('MockGhServerState: label create requires a name\n', 1);
    }
    // --force makes it idempotent; we treat all label create as idempotent.
    this.labels.add(name);
    return okResult('');
  }

  // ─── api (milestones) ──────────────────────────────────────────────────────

  private handleApi(path: string | undefined, rest: string[]): GhExecResult {
    if (path === undefined) {
      throw ghError('MockGhServerState: gh api requires a path\n', 1);
    }
    const milestonePath = `repos/${this.repo}/milestones`;
    if (path !== milestonePath) {
      throw ghError(
        `MockGhServerState: unsupported api path: ${path}\n`,
        1,
      );
    }
    const method = flagValue(rest, '--method') ?? 'GET';
    if (method !== 'POST') {
      throw ghError(
        `MockGhServerState: api ${path} only supports POST, got: ${method}\n`,
        1,
      );
    }
    const fields = collectFormFields(rest);
    const title = fields.title;
    if (title === undefined) {
      throw ghError(
        'MockGhServerState: api milestones POST requires -f title=...\n',
        1,
      );
    }
    const number = this.nextMilestoneNumber++;
    const milestone: MockGhMilestone = {
      number,
      title,
      ...(fields.description !== undefined
        ? { description: fields.description }
        : {}),
      html_url: `https://github.com/${this.repo}/milestone/${number}`,
    };
    this.milestones.set(number, milestone);
    return jsonResult(milestone);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private requireIssue(number: number): MockGhIssue {
    const issue = this.issues.get(number);
    if (!issue) {
      throw ghError(
        `MockGhServerState: HTTP 404: could not resolve to an Issue with the number ${number}\n`,
        1,
      );
    }
    return issue;
  }
}

// ─── arg helpers ─────────────────────────────────────────────────────────────

/** Returns the value following `flag` (eg `--repo foo` → `foo`). */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/**
 * Collects label values across every occurrence of `flag`, flattening
 * comma-separated values. Handles both forms the tracker may emit:
 *   --remove-label state:in-progress,state:in-review
 *   --add-label X --add-label Y    (future-proofing)
 */
function collectLabels(
  args: readonly string[],
  flag: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) {
      const value = args[i + 1];
      for (const piece of value.split(',')) {
        const trimmed = piece.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
  }
  return out;
}

/** Collects every `-f key=value` pair into a record. */
function collectFormFields(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-f') {
      const value = args[i + 1];
      const eq = value.indexOf('=');
      if (eq > 0) {
        out[value.slice(0, eq)] = value.slice(eq + 1);
      }
    }
  }
  return out;
}

/** First non-flag positional argument, parsed as a numeric issue/milestone number. */
function parsePositionalNumber(
  args: readonly string[],
  context: string,
): number {
  const positional = args.find((a) => !a.startsWith('-'));
  if (positional === undefined) {
    throw ghError(
      `MockGhServerState: ${context} requires an issue number\n`,
      1,
    );
  }
  const n = Number(positional);
  if (!Number.isInteger(n) || n <= 0) {
    throw ghError(
      `MockGhServerState: ${context} got non-numeric positional: ${positional}\n`,
      1,
    );
  }
  return n;
}

/** Parse the `--json` flag's comma-separated field list. */
function parseJsonFields(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

// ─── response shaping ────────────────────────────────────────────────────────

function okResult(stdout: string): GhExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function jsonResult(value: unknown): GhExecResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 };
}

/**
 * Project an in-memory issue to a JSON-output object matching real `gh`
 * behaviour: only the fields listed in `--json` are present, and labels are
 * shaped as `[{name}]` to satisfy the Zod schemas in src/schemas/trackers.ts.
 *
 * If `fields` is undefined, returns the full projection. Sorting labels
 * lexicographically keeps output deterministic across runs (matters for any
 * future race-style test, harmless for conformance).
 */
function projectIssue(
  issue: MockGhIssue,
  fields: Set<string> | undefined,
): Record<string, unknown> {
  const labels = [...issue.labels].sort().map((name) => ({ name }));
  const all: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    labels,
    body: issue.body,
    url: issue.url,
  };
  if (fields === undefined) return all;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in all) out[f] = all[f];
  }
  return out;
}

// ─── state-backed tracker factory ────────────────────────────────────────────

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Wraps GitHubTracker construction with the state mock's `exec` and an
 * instant-retry sleep. Use in tests that call `runTrackerConformance`.
 */
export function makeStateBackedGitHubTracker(
  server: MockGhServerState,
  config?: Partial<GithubTrackerConfig['config']>,
): GitHubTracker {
  const trackerConfig: GithubTrackerConfig = {
    type: 'github',
    config: { repo: server.repo, ...config },
  };
  return new GitHubTracker(trackerConfig, silentLogger(), {
    gh: server.exec,
    retry: { sleep: async () => {} },
  });
}
