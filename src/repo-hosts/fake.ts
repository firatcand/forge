// FORGE-231: scriptable in-memory RepoHost for tests (FORGE-231/233/234).
// Every scripted result is validated through the SAME zod schemas the real
// adapter uses, so a test can never script a shape production would reject.

import { OrchestratorError } from '../core/errors.ts';
import type { RepoHost } from './base.ts';
import {
  BaseResolutionSchema,
  ChecksResultSchema,
  HeadShaResultSchema,
  MergeAttemptOutcomeSchema,
  MergeResultSchema,
  ProbeReportSchema,
  PullRequestRefSchema,
  type ProbeReport,
  type BaseResolution,
  type ChecksResult,
  type HeadShaResult,
  type MergeAttemptOutcome,
  type MergeResult,
  type PullRequestRef,
} from './types.ts';

export interface FakeRepoHostScript {
  base?: BaseResolution;
  probe?: unknown;
  pullRequest?: PullRequestRef;
  checks?: ChecksResult;
  mergeAttempt?: MergeAttemptOutcome;
  mergeResult?: MergeResult;
  headSha?: HeadShaResult;
}

export interface FakeRepoHostCall {
  op: string;
  args: readonly unknown[];
}

export class FakeRepoHost implements RepoHost {
  readonly calls: FakeRepoHostCall[] = [];

  constructor(private readonly script: FakeRepoHostScript = {}) {}

  private scripted<T>(op: string, value: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }): T {
    if (value === undefined) {
      throw new OrchestratorError('IO_ERROR', `FakeRepoHost: no scripted result for ${op}`, { op });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data === undefined) {
      throw new OrchestratorError('SCHEMA_INVALID', `FakeRepoHost: scripted ${op} result failed schema validation`, {
        op,
        zodError: parsed.error?.message,
      });
    }
    return parsed.data;
  }

  async resolveBase(): Promise<BaseResolution> {
    this.calls.push({ op: 'resolveBase', args: [] });
    return this.scripted('resolveBase', this.script.base, BaseResolutionSchema);
  }

  async probe(): Promise<ProbeReport> {
    this.calls.push({ op: 'probe', args: [] });
    return this.scripted('probe', this.script.probe, ProbeReportSchema);
  }

  async createOrGetPullRequest(head: string, base: string): Promise<PullRequestRef> {
    this.calls.push({ op: 'createOrGetPullRequest', args: [head, base] });
    return this.scripted('createOrGetPullRequest', this.script.pullRequest, PullRequestRefSchema);
  }

  async requiredChecksGreen(pr: PullRequestRef): Promise<ChecksResult> {
    this.calls.push({ op: 'requiredChecksGreen', args: [pr] });
    return this.scripted('requiredChecksGreen', this.script.checks, ChecksResultSchema);
  }

  async mergeAtomic(pr: PullRequestRef, expectedHeadSha: string): Promise<MergeAttemptOutcome> {
    this.calls.push({ op: 'mergeAtomic', args: [pr, expectedHeadSha] });
    return this.scripted('mergeAtomic', this.script.mergeAttempt, MergeAttemptOutcomeSchema);
  }

  async mergeResult(pr: PullRequestRef): Promise<MergeResult> {
    this.calls.push({ op: 'mergeResult', args: [pr] });
    return this.scripted('mergeResult', this.script.mergeResult, MergeResultSchema);
  }

  async headSha(pr: PullRequestRef): Promise<HeadShaResult> {
    this.calls.push({ op: 'headSha', args: [pr] });
    return this.scripted('headSha', this.script.headSha, HeadShaResultSchema);
  }
}
