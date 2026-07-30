// FORGE-232: GitHubRepoHost — the concrete `gh`-backed implementation of the
// FORGE-231 RepoHost seam (spec/ORCHESTRATOR.md §RepoHost; plan v3+v4 in
// .forge/loop-notes/). Owner decisions (2026-07-23, binding):
//   OD1 — merge primitive is `gh pr merge --squash --match-head-commit` with
//         COMPENSATING enrollment cleanup. The merge-queue race is mitigated,
//         not eliminated: crash-between-enrollment-and-cleanup and
//         enrollment-merges-before-revoke windows remain (owner-acknowledged).
//   OD2 — github.com only in v0.4 (no GHES; host is never persisted).
//   OD3 — pure library: no CLI verb; consumers are FORGE-233/234.
// Billing invariant: pure git/gh subprocess — this module must never import
// harness/model-runner code (enforced by a structural test).

import { OrchestratorError } from '../core/errors.ts';
import type { CasHolderIdentity } from '../core/fs-atomic.ts';
import {
  readShipRecord,
  upsertBaseResolution,
  type BaseResolutionBinding,
} from '../orchestrator/ship-record.ts';
import type { RepoHost } from './base.ts';
import { RepoHostError } from './errors.ts';
import {
  GhBranchRulesSchema,
  GhClassicProtectionSchema,
  GhPrChecksSchema,
  GhRepoViewSchema,
  GhRequiredChecksParamsSchema,
  GhRestPullPagesSchema,
  GhRestPullSchema,
  GhRulesetDetailSchema,
  GraphqlPrObservationSchema,
  Sha40,
  type GhRestPull,
  type GraphqlPrObservation,
} from './gh-schemas.ts';
import {
  BaseResolutionSchema,
  ChecksResultSchema,
  HeadShaResultSchema,
  MergeAttemptOutcomeSchema,
  MergeResultSchema,
  PullRequestRefSchema,
  type BaseResolution,
  type ChecksResult,
  type HeadShaResult,
  type MergeAttemptOutcome,
  type MergeResult,
  type ProbeReport,
  type PullRequestRef,
} from './types.ts';

// ─── Exec contracts (injected; no live processes in tests) ───────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Exec = (args: readonly string[]) => Promise<ExecResult>;

export interface GitHubRepoHostOptions {
  gh: Exec;
  git: Exec;
  /** Task worktree (git commands run here). */
  worktreePath: string;
  taskId: string;
  forgeDir: string;
  /** Frozen per-task base branch (worktree marker, owner decision SB). */
  baseBranch: string;
  /** Head (task) branch — push topology resolves FROM this branch. */
  headBranch: string;
  /** Reviewed binding the base resolution is fenced to. */
  reviewBinding: { attemptId: string; headSha: string };
  holder: CasHolderIdentity;
  /** Fence for ship-record writes (lease/attempt validation; caller-owned). */
  recordFence?: () => void;
  /** Enrollment/verification polling delay in ms (tests inject 0). */
  pollDelayMs?: number;
}

const FORGE_MARKER = (taskId: string): string => `<!-- forge:task:${taskId} -->`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Push-URL canonicalization (plan v3 §resolveBase; R2 #4) ─────────────────

// HTTPS: https://github.com/owner/repo(.git)  SSH: ssh://git@github.com/owner/repo(.git)
// scp:   git@github.com:owner/repo(.git)
export function parseGitHubUrl(url: string): { host: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  let m = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+)$/.exec(trimmed);
  if (m) return { host: m[1]!.toLowerCase(), repo: m[2]! };
  m = /^(?:[^@/]+@)([^:/]+):([^/]+\/[^/]+)$/.exec(trimmed);
  if (m) return { host: m[1]!.toLowerCase(), repo: m[2]! };
  return null;
}

// Effective push topology per git's precedence for the HEAD branch:
// branch.<head>.pushRemote → remote.pushDefault → branch.<head>.remote →
// origin; then ALL push URLs of that remote (git pushes to every one).
// Resolved in ONE pass (impl-R2 MAJ #2) — remote name and URLs can never
// come from different reads. `git config --get` exit 1 is the documented
// "key unset" result and advances precedence; ANY other failure (exit >1,
// executor rejection) is NOT evidence of absence and fails closed (null).
export interface PushTopology {
  remote: string;
  urls: string[];
}

export async function resolveEffectivePushTopology(
  git: Exec,
  headBranch: string,
): Promise<PushTopology | null> {
  const config = async (key: string): Promise<{ ok: true; value: string | null } | { ok: false }> => {
    let res: ExecResult;
    try {
      res = await git(['config', '--get', key]);
    } catch {
      return { ok: false };
    }
    if (res.exitCode === 0) {
      const v = res.stdout.trim();
      // impl-R3 MAJ: an EXPLICITLY EMPTY configured value (exit 0, empty
      // stdout — `git config branch.<b>.pushRemote ''`) disables pushing for
      // git itself; it must fail closed, never advance precedence to origin.
      if (v.length === 0) return { ok: false };
      return { ok: true, value: v };
    }
    if (res.exitCode === 1) return { ok: true, value: null }; // documented: key unset
    return { ok: false };
  };

  let remote: string | null = null;
  for (const key of [`branch.${headBranch}.pushRemote`, 'remote.pushDefault', `branch.${headBranch}.remote`]) {
    const r = await config(key);
    if (!r.ok) return null; // execution failure ≠ unset — fail closed
    if (r.value !== null) {
      remote = r.value;
      break;
    }
  }
  remote = remote ?? 'origin';

  let urlsRes: ExecResult;
  try {
    urlsRes = await git(['remote', 'get-url', '--push', '--all', remote]);
  } catch {
    return null;
  }
  if (urlsRes.exitCode !== 0) return null;
  const urls = urlsRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { remote, urls };
}

export class GitHubRepoHost implements RepoHost {
  private readonly o: GitHubRepoHostOptions;
  private readonly delay: number;

  constructor(opts: GitHubRepoHostOptions) {
    this.o = opts;
    this.delay = opts.pollDelayMs ?? 2000;
  }

  // FORGE-233: observation-only construction — mergeResult()/headSha() need
  // nothing but the gh executor (they operate on an explicit PullRequestRef).
  // Mutation-context fields are inert sentinels and the git executor FAILS
  // CLOSED, so no mutating method can acquire write authority through this
  // path (Codex FORGE-233 plan R1 #4).
  static forObservation(opts: { gh: Exec; forgeDir: string; taskId: string }): GitHubRepoHost {
    const failClosedGit: Exec = async () => ({
      stdout: '',
      stderr: 'observation-only host: git execution is not available',
      exitCode: 254,
    });
    return new GitHubRepoHost({
      gh: opts.gh,
      git: failClosedGit,
      worktreePath: '',
      taskId: opts.taskId,
      forgeDir: opts.forgeDir,
      baseBranch: '',
      headBranch: '',
      reviewBinding: { attemptId: 'observation-only', headSha: '0'.repeat(40) },
      holder: { run_id: 'observation-only', claim_id: 'observation-only', generation: 0 },
      pollDelayMs: 0,
    });
  }

  // FORGE-235: the explicitly MUTATION-CAPABLE persisted-identity constructor.
  // Identical wiring to forObservation (gh-only; git fails closed — the merge
  // path never touches the worktree), but a DISTINCT named capability so
  // auto-merge authority is granted deliberately. gc receives observers and
  // therefore cannot merge by construction; only the merge tick calls this.
  static forMerge(opts: { gh: Exec; forgeDir: string; taskId: string; pollDelayMs?: number }): GitHubRepoHost {
    const host = GitHubRepoHost.forObservation(opts);
    return host;
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  // CRIT impl-R1 #1: a REJECTED executor promise (timeout/spawn wrapper) must
  // never bypass enrollment reconciliation or revoke confirmation — rejections
  // become nonzero ExecResults so every downstream path (Phase A, revoke,
  // classification) still runs.
  private async gh(args: readonly string[]): Promise<ExecResult> {
    try {
      return await this.o.gh(args);
    } catch (err) {
      return { stdout: '', stderr: `executor rejected: ${err instanceof Error ? err.message : String(err)}`, exitCode: 254 };
    }
  }

  private async ghJson<T>(
    args: readonly string[],
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } },
    what: string,
  ): Promise<T> {
    const res = await this.gh(args);
    if (res.exitCode !== 0) {
      throw new RepoHostError('transport', `gh ${what} failed (exit ${res.exitCode})`, {
        stderr: res.stderr.slice(0, 500),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new RepoHostError('schema', `gh ${what} returned non-JSON output`, {}, { cause: err });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success || validated.data === undefined) {
      throw new RepoHostError('schema', `gh ${what} payload failed schema validation`, {
        zodError: validated.error?.message,
      });
    }
    return validated.data;
  }

  // impl-R2 MAJ #3: every ship-record read at the adapter boundary maps to
  // RepoHostError — a truncated/corrupt record must surface as 'schema', an
  // I/O failure as 'transport', never a leaked OrchestratorError/SyntaxError.
  private readRecordSafe(): ReturnType<typeof readShipRecord> {
    try {
      return readShipRecord(this.o.forgeDir, this.o.taskId);
    } catch (err) {
      if ((err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID') || err instanceof SyntaxError) {
        throw new RepoHostError('schema', err.message, { taskId: this.o.taskId }, { cause: err });
      }
      throw new RepoHostError(
        'transport',
        `ship record unreadable for task ${this.o.taskId}`,
        { taskId: this.o.taskId },
        { cause: err },
      );
    }
  }

  private recordedRepo(): string {
    const record = this.readRecordSafe();
    if (record?.base) return record.base.repo;
    throw new RepoHostError(
      'record_missing',
      `no persisted base for task ${this.o.taskId} — resolveBase() must run before PR operations`,
      { taskId: this.o.taskId },
    );
  }

  // ─── resolveBase (plan v3; R2 #3 #4) ───────────────────────────────────────

  async resolveBase(): Promise<BaseResolution> {
    const record = this.readRecordSafe();
    if (record?.base) {
      // Persisted-first WITH fence: route through the fenced replay so a stale
      // attempt with a superseded reviewed binding gets the typed conflict,
      // never the stored base (Codex plan R2 #3).
      const replayed = this.persistBase(record.base);
      return this.validateBase(replayed);
    }

    // First resolution. Base repo identity from gh; push topology from the
    // HEAD branch per git's actual precedence (Codex plan R2 #4).
    const view = await this.ghJson(
      ['repo', 'view', '--json', 'nameWithOwner,isFork,parent'],
      GhRepoViewSchema,
      'repo view',
    );
    const topology = await resolveEffectivePushTopology(this.git.bind(this), this.o.headBranch);
    if (topology === null) {
      throw new RepoHostError('unsupported_host', 'cannot resolve the effective push topology', {});
    }
    const { remote: pushRemote, urls: pushUrls } = topology;
    if (pushUrls.length === 0) {
      throw new RepoHostError('unsupported_host', `remote ${pushRemote} has no push URL`, {});
    }
    for (const url of pushUrls) {
      const parsed = parseGitHubUrl(url);
      if (parsed === null || parsed.host !== 'github.com') {
        throw new RepoHostError(
          'unsupported_host',
          `push URL is not a github.com repository (OD2: github.com only in v0.4)`,
          { url },
        );
      }
      if (parsed.repo.toLowerCase() !== view.nameWithOwner.toLowerCase()) {
        // EVERY push destination must be the base repo — a single divergent
        // push URL (fork, mirror) is fork topology, parked by the consumer.
        throw new RepoHostError(
          'fork_topology',
          `push destination ${parsed.repo} differs from base repo ${view.nameWithOwner} — fork topology is out of v0.4 scope`,
          { push: parsed.repo, base: view.nameWithOwner },
        );
      }
    }

    const base: BaseResolutionBinding = {
      repo: view.nameWithOwner,
      branch: this.o.baseBranch,
      push_remote: pushRemote,
    };
    this.persistBase(base);
    return this.validateBase(base);
  }

  // MAJ impl-R1 #5: the adapter's error boundary is RepoHostError — the
  // orchestrator-level persistence codes are mapped so a consumer can
  // distinguish repo-host binding conflicts from generic state failures.
  private persistBase(base: BaseResolutionBinding): BaseResolutionBinding {
    try {
      const record = upsertBaseResolution(this.o.forgeDir, this.o.taskId, {
        base,
        expectedReviewAttemptId: this.o.reviewBinding.attemptId,
        expectedReviewedHeadSha: this.o.reviewBinding.headSha,
        holder: this.o.holder,
        fence: this.o.recordFence,
      });
      return record.base!;
    } catch (err) {
      if (err instanceof OrchestratorError) {
        if (err.code === 'STALE_ATTEMPT' || err.code === 'STATE_VERSION_CONFLICT') {
          throw new RepoHostError('binding_conflict', err.message, { taskId: this.o.taskId }, { cause: err });
        }
        if (err.code === 'STATE_NOT_FOUND') {
          throw new RepoHostError('record_missing', err.message, { taskId: this.o.taskId }, { cause: err });
        }
        throw new RepoHostError('transport', err.message, { taskId: this.o.taskId }, { cause: err });
      }
      throw err;
    }
  }

  private validateBase(base: BaseResolutionBinding): BaseResolution {
    const parsed = BaseResolutionSchema.safeParse(base);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'base resolution failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  private async git(args: readonly string[]): Promise<ExecResult> {
    try {
      return await this.o.git(args);
    } catch (err) {
      return { stdout: '', stderr: `executor rejected: ${err instanceof Error ? err.message : String(err)}`, exitCode: 254 };
    }
  }

  // ─── probe (plan v3; R1 #1) ────────────────────────────────────────────────

  async probe(): Promise<ProbeReport> {
    try {
      return await this.probeInner();
    } catch (err) {
      // The probe ALWAYS composes its failure union (impl-R2 MAJ #3) — a
      // thrown error of any shape becomes a fail-closed report, never a
      // rejection the consumer has to distinguish.
      if (err instanceof RepoHostError) {
        const reason =
          err.code === 'transport' ? 'transport' : err.code === 'schema' ? 'transport' : 'unsupported_host';
        return { ok: false, reason, detail: err.message.slice(0, 2000) };
      }
      return {
        ok: false,
        reason: 'transport',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      };
    }
  }

  private async probeInner(): Promise<ProbeReport> {
    const repo = this.recordedRepo();
    const branchRaw = this.readRecordSafe()!.base!.branch;
    const branch = encodeURIComponent(branchRaw);

    // (a) repo-level: squash method + permissions.
    const view = await this.ghJson(
      ['repo', 'view', repo, '--json', 'nameWithOwner,isFork,parent,squashMergeAllowed,viewerPermission,viewerCanAdminister'],
      GhRepoViewSchema,
      'repo view',
    );
    if (view.squashMergeAllowed === undefined || view.viewerPermission === undefined || view.viewerCanAdminister === undefined) {
      return { ok: false, reason: 'transport', detail: 'repo view omitted required permission fields' };
    }
    const writePermission = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(view.viewerPermission);

    // (b) effective ruleset rules — PAGINATED (a later page can hold the
    // merge_queue or required-check rule; R1 #1).
    const rulesRes = await this.gh(['api', '--paginate', '--slurp', `repos/${repo}/rules/branches/${branch}`]);
    if (rulesRes.exitCode !== 0) {
      return { ok: false, reason: 'auth', detail: `effective-rules read failed: ${rulesRes.stderr.slice(0, 500)}` };
    }
    let rulesPages: unknown;
    try {
      rulesPages = JSON.parse(rulesRes.stdout);
    } catch {
      return { ok: false, reason: 'transport', detail: 'effective-rules payload is not JSON' };
    }
    // --slurp yields an array of pages; each page is an array of rules.
    const pagesParsed = GhBranchRulesSchema.array().safeParse(rulesPages);
    if (!pagesParsed.success) {
      return { ok: false, reason: 'transport', detail: 'effective-rules payload failed schema validation' };
    }
    const rules = pagesParsed.data.flat();

    const rulesetChecks = new Set<string>();
    let merge_queue_enabled = false;
    // (ruleset_id, source_type) — identity is MANDATORY for governing rules
    // (CRIT impl-R1 #2): a rule we cannot trace to a readable ruleset detail
    // is a rule whose bypass list we cannot prove empty.
    const rulesetRefs = new Map<number, string>();
    for (const rule of rules) {
      const governs = rule.type === 'merge_queue' || rule.type === 'required_status_checks' || rule.type === 'pull_request';
      if (governs) {
        if (rule.ruleset_id === undefined || rule.ruleset_source_type === undefined) {
          return {
            ok: false,
            reason: 'auth',
            detail: `effective rule '${rule.type}' carries no ruleset identity — bypass actors cannot be verified`,
          };
        }
        rulesetRefs.set(rule.ruleset_id, rule.ruleset_source_type);
      }
      if (rule.type === 'merge_queue') merge_queue_enabled = true;
      if (rule.type === 'required_status_checks') {
        const params = GhRequiredChecksParamsSchema.safeParse(rule.parameters ?? {});
        if (!params.success) {
          return { ok: false, reason: 'transport', detail: 'required_status_checks rule parameters malformed' };
        }
        for (const c of params.data.required_status_checks ?? []) rulesetChecks.add(c.context);
      }
    }

    // (c) per-ruleset detail: bypass_actors must be EXPLICITLY present and
    // empty — omitted/unreadable/malformed is NOT evidence of no bypass.
    let rulesetBypass = false;
    const owner = repo.split('/')[0]!;
    for (const [id, sourceType] of rulesetRefs) {
      // Detail endpoint is routed BY SOURCE (CRIT impl-R1 #2): repository and
      // organization rulesets live at different paths; an unknown source
      // scope cannot be verified → fail closed.
      let detailPath: string;
      if (sourceType === 'Repository') detailPath = `repos/${repo}/rulesets/${id}`;
      else if (sourceType === 'Organization') detailPath = `orgs/${owner}/rulesets/${id}`;
      else {
        return {
          ok: false,
          reason: 'auth',
          detail: `ruleset ${id} has unsupported source '${sourceType}' — bypass actors cannot be verified`,
        };
      }
      const detailRes = await this.gh(['api', detailPath]);
      if (detailRes.exitCode !== 0) {
        return {
          ok: false,
          reason: 'auth',
          detail: `ruleset ${id} detail unreadable — bypass actors cannot be verified`,
        };
      }
      let detail: unknown;
      try {
        detail = JSON.parse(detailRes.stdout);
      } catch {
        return { ok: false, reason: 'transport', detail: `ruleset ${id} detail is not JSON` };
      }
      const parsed = GhRulesetDetailSchema.safeParse(detail);
      if (!parsed.success) {
        return { ok: false, reason: 'transport', detail: `ruleset ${id} detail failed schema validation` };
      }
      if (parsed.data.bypass_actors === undefined) {
        return {
          ok: false,
          reason: 'auth',
          detail: `ruleset ${id} omits bypass_actors — cannot prove the bypass list is empty`,
        };
      }
      if (parsed.data.bypass_actors.length > 0) rulesetBypass = true;
    }

    // (d) classic protection. 403 → cannot verify → fail closed. 404 counts as
    // "classic absent" ONLY after the repo + branch are proven to exist AND the
    // response is the documented branch-not-protected message.
    const classicRes = await this.gh(['api', `repos/${repo}/branches/${branch}/protection`]);
    const classicChecks = new Set<string>();
    let classicBypass = false;
    if (classicRes.exitCode === 0) {
      let classic: unknown;
      try {
        classic = JSON.parse(classicRes.stdout);
      } catch {
        return { ok: false, reason: 'transport', detail: 'classic protection payload is not JSON' };
      }
      const parsed = GhClassicProtectionSchema.safeParse(classic);
      if (!parsed.success) {
        return { ok: false, reason: 'transport', detail: 'classic protection payload failed schema validation' };
      }
      const rsc = parsed.data.required_status_checks;
      if (rsc) {
        for (const c of rsc.contexts ?? []) classicChecks.add(c);
        for (const c of rsc.checks ?? []) classicChecks.add(c.context);
      }
      // enforce_admins disabled + an admin identity = classic bypass in play.
      // A non-admin viewer is not flagged (no bypass available to it, and the
      // merge path has no --admin by construction).
      if (parsed.data.enforce_admins?.enabled === false && view.viewerCanAdminister === true) {
        classicBypass = true;
      }
    } else if (/403/.test(classicRes.stderr) || /HTTP 403/.test(classicRes.stderr)) {
      return {
        ok: false,
        reason: 'auth',
        detail: 'classic branch protection unreadable (requires Administration:read) — cannot verify',
      };
    } else if (/not protected/i.test(classicRes.stderr)) {
      // Documented branch-not-protected response — but only trust it after
      // independently proving the repo and branch exist (ambiguous 404s stay
      // fail-closed; Codex plan R1 #1).
      const repoOk = await this.gh(['api', `repos/${repo}`]);
      const branchOk = await this.gh(['api', `repos/${repo}/branches/${branch}`]);
      if (repoOk.exitCode !== 0 || branchOk.exitCode !== 0) {
        return { ok: false, reason: 'not_found', detail: 'repo or branch existence could not be proven' };
      }
      // classic absent — rulesets alone govern.
    } else {
      return {
        ok: false,
        reason: 'transport',
        detail: `classic protection read failed: ${classicRes.stderr.slice(0, 500)}`,
      };
    }

    const blocking = new Set<string>([...classicChecks, ...rulesetChecks]);
    const report: ProbeReport = {
      ok: true,
      blocking_check_count: blocking.size,
      squash_allowed: view.squashMergeAllowed,
      write_permission: writePermission,
      bypass_rules_present: rulesetBypass || classicBypass,
      merge_queue_enabled,
    };
    return report;
  }

  // ─── createOrGetPullRequest (plan v4 Δ3 + ΔB) ──────────────────────────────

  async createOrGetPullRequest(head: string, base: string): Promise<PullRequestRef> {
    const repo = this.recordedRepo();
    const owner = repo.split('/')[0]!;

    const existing = await this.classifyExisting(repo, owner, head, base);
    if (existing) return existing;

    const marker = FORGE_MARKER(this.o.taskId);
    const createRes = await this.gh([
      'pr', 'create',
      '--repo', repo,
      '--head', head,
      '--base', base,
      '--title', `${this.o.taskId}: ${head}`,
      '--body', `Automated forge ship for task ${this.o.taskId}.\n\n${marker}\n`,
    ]);

    if (createRes.exitCode === 0) {
      // Validated create URL is the authoritative new identity (plan v4 ΔB).
      // Verification is a repository-scoped read of THAT number (MIN impl-R1
      // #1) — a stale whole-set listing must not substitute a different PR.
      const ref = this.parseCreateUrl(createRes.stdout, repo);
      for (let i = 0; i < 2; i += 1) {
        const readRes = await this.gh(['api', `repos/${repo}/pulls/${ref.number}`]);
        if (readRes.exitCode === 0) {
          try {
            const pullRaw: unknown = JSON.parse(readRes.stdout);
            const pullParsed = GhRestPullSchema.safeParse(pullRaw);
            if (
              pullParsed.success &&
              pullParsed.data.number === ref.number &&
              pullParsed.data.head.ref === head &&
              pullParsed.data.base.ref === base &&
              (pullParsed.data.body ?? '').includes(marker)
            ) {
              // Payload verified AGAINST the URL-derived identity (impl-R2
              // MIN #1) — a malformed response for /pulls/N naming another
              // number can never substitute a different PR.
              return ref;
            }
          } catch {
            // fall through to retry / ΔB fallback
          }
        }
        if (this.delay > 0) await sleep(this.delay);
      }
      return ref;
    }

    // Create failed (duplicate race / transport): unconditional reconciliation;
    // recover the winner or propagate the ORIGINAL create failure.
    try {
      const recovered = await this.classifyExisting(repo, owner, head, base);
      if (recovered) return recovered;
    } catch (err) {
      if (err instanceof RepoHostError && err.code === 'pr_conflict') throw err;
      // fall through to the original error
    }
    throw new RepoHostError('transport', `gh pr create failed (exit ${createRes.exitCode})`, {
      stderr: createRes.stderr.slice(0, 500),
    });
  }

  private parseCreateUrl(stdout: string, repo: string): PullRequestRef {
    const m = new RegExp(`https://github\\.com/${repo.replace(/[.\\/]/g, '\\$&')}/pull/(\\d+)`).exec(stdout);
    if (!m) {
      throw new RepoHostError('schema', 'gh pr create output did not contain a PR URL for the recorded repo', {
        stdout: stdout.slice(0, 300),
      });
    }
    const number = Number(m[1]);
    return this.validateRef({ repo, number, url: `https://github.com/${repo}/pull/${number}` });
  }

  // Whole-set classification over ALL exact head+base matches (plan v4 Δ3):
  // exactly ONE marked open match → return; any marked closed/merged match,
  // any unmarked exact match, or >1 marked open → pr_conflict; empty → null.
  private async classifyExisting(
    repo: string,
    owner: string,
    head: string,
    base: string,
  ): Promise<PullRequestRef | null> {
    const pages = await this.ghJson(
      [
        'api', '-X', 'GET', '--paginate', '--slurp',
        `repos/${repo}/pulls`,
        '-f', `head=${owner}:${head}`,
        '-f', `base=${base}`,
        '-f', 'state=all',
      ],
      GhRestPullPagesSchema,
      'pulls list',
    );
    const all = pages.flat().filter((p) => p.head.ref === head && p.base.ref === base);
    if (all.length === 0) return null;

    const marker = FORGE_MARKER(this.o.taskId);
    const marked = all.filter((p) => (p.body ?? '').includes(marker));
    const unmarked = all.filter((p) => !(p.body ?? '').includes(marker));
    const markedOpen = marked.filter((p) => p.state === 'open');
    const markedClosed = marked.filter((p) => p.state !== 'open');

    if (unmarked.length > 0 || markedClosed.length > 0 || markedOpen.length > 1) {
      throw new RepoHostError(
        'pr_conflict',
        `ambiguous or conflicting PR set for ${head}→${base} — fail closed`,
        {
          detail: all
            .map((p) => `#${p.number}:${p.state}${(p.body ?? '').includes(marker) ? ':marked' : ''}`)
            .join(','),
        },
      );
    }
    const hit: GhRestPull | undefined = markedOpen[0];
    if (!hit) return null;
    return this.validateRef({ repo, number: hit.number, url: hit.html_url });
  }

  private validateRef(ref: { repo: string; number: number; url: string }): PullRequestRef {
    const parsed = PullRequestRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'pull request ref failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  // ─── GraphQL observation (plan v4 Δ2 — single query for enrollment + proof) ─

  private async observe(pr: PullRequestRef): Promise<GraphqlPrObservation['data']['repository']['pullRequest']> {
    const [ownerName, repoName] = pr.repo.split('/');
    const query =
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state mergedAt headRefOid baseRefName mergeCommit{oid} autoMergeRequest{enabledAt} isInMergeQueue mergeQueueEntry{id state}}}}';
    const res = await this.gh([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${ownerName}`,
      '-f', `name=${repoName}`,
      '-F', `number=${pr.number}`,
    ]);
    if (res.exitCode !== 0) {
      throw new RepoHostError('transport', `PR observation query failed (exit ${res.exitCode})`, {
        stderr: res.stderr.slice(0, 500),
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout);
    } catch (err) {
      throw new RepoHostError('schema', 'PR observation payload is not JSON', {}, { cause: err });
    }
    const parsed = GraphqlPrObservationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'PR observation payload failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data.data.repository.pullRequest;
  }

  // ─── mergeResult — the ONLY merge proof (platform state, plan v4 Δ2) ───────

  async mergeResult(pr: PullRequestRef): Promise<MergeResult> {
    let obs;
    try {
      obs = await this.observe(pr);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.validateMergeResult({ merged: false, state: 'unknown', reason: detail.slice(0, 2000) });
    }
    if (obs === null) {
      return this.validateMergeResult({ merged: false, state: 'unknown', reason: 'pull request not found' });
    }
    if (obs.state === 'MERGED') {
      const oid = obs.mergeCommit?.oid ?? '';
      const headOid = obs.headRefOid;
      if (
        obs.mergedAt === null ||
        !Sha40.safeParse(oid.toLowerCase()).success ||
        !Sha40.safeParse(headOid.toLowerCase()).success
      ) {
        // Missing/malformed proof fields are NEVER a negative merge proof —
        // and never a positive one either (plan v3 §mergeAtomic step 4).
        return this.validateMergeResult({
          merged: false,
          state: 'unknown',
          reason: 'merged state observed but proof fields are missing or malformed',
        });
      }
      return this.validateMergeResult({
        merged: true,
        base_ref: obs.baseRefName,
        merge_commit_sha: oid.toLowerCase(),
        merged_head_sha: headOid.toLowerCase(),
      });
    }
    if (obs.state === 'CLOSED') {
      return this.validateMergeResult({ merged: false, state: 'closed_unmerged' });
    }
    return this.validateMergeResult({ merged: false, state: 'open' });
  }

  private validateMergeResult(r: unknown): MergeResult {
    const parsed = MergeResultSchema.safeParse(r);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'merge result failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  // ─── headSha ───────────────────────────────────────────────────────────────

  async headSha(pr: PullRequestRef): Promise<HeadShaResult> {
    let obs;
    try {
      obs = await this.observe(pr);
    } catch (err) {
      const auth = err instanceof RepoHostError && /auth/i.test(err.message);
      return this.validateHeadSha({ ok: false, reason: auth ? 'auth' : 'transport' });
    }
    if (obs === null) return this.validateHeadSha({ ok: false, reason: 'not_found' });
    if (obs.state === 'CLOSED') return this.validateHeadSha({ ok: false, reason: 'closed' });
    const sha = obs.headRefOid.toLowerCase();
    if (!Sha40.safeParse(sha).success) return this.validateHeadSha({ ok: false, reason: 'no_head' });
    return this.validateHeadSha({ ok: true, sha });
  }

  private validateHeadSha(r: unknown): HeadShaResult {
    const parsed = HeadShaResultSchema.safeParse(r);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'head sha result failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  // ─── requiredChecksGreen (plan v3; R2 #6 — JSON-led bucket mapping) ────────

  async requiredChecksGreen(pr: PullRequestRef): Promise<ChecksResult> {
    const res = await this.gh([
      'pr', 'checks', String(pr.number), '--repo', pr.repo, '--required', '--json', 'name,bucket',
    ]);
    // Exit code (incl. the documented exit 8 = pending) is DIAGNOSTIC only —
    // classification is JSON-led. No parseable JSON + nonzero → unknown.
    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout);
    } catch {
      return this.validateChecks({
        status: 'unknown',
        reason: `no parseable checks output (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`,
      });
    }
    const parsed = GhPrChecksSchema.safeParse(raw);
    if (!parsed.success) {
      return this.validateChecks({ status: 'unknown', reason: 'checks payload failed schema validation' });
    }
    const checks = parsed.data;
    if (checks.length === 0) {
      // Zero REQUIRED checks must never read as green (defense in depth — the
      // probe bar already excludes such bases).
      return this.validateChecks({ status: 'unknown', reason: 'no_required_checks' });
    }
    const buckets = checks.map((c) => c.bucket);
    const known = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);
    if (buckets.some((b) => !known.has(b))) {
      return this.validateChecks({ status: 'unknown', reason: `unknown check bucket: ${buckets.join(',')}` });
    }
    const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
    if (failed.length > 0) {
      // FORGE-235: the names were already parsed — surfacing them (bounded) is
      // what makes ci_red_reported actionable instead of just a count.
      return this.validateChecks({
        status: 'red',
        failing_count: failed.length,
        failing: failed.slice(0, 20).map((c) => ({ name: c.name.slice(0, 200), bucket: c.bucket.slice(0, 40) })),
      });
    }
    const pending = buckets.filter((b) => b === 'pending').length;
    if (pending > 0) return this.validateChecks({ status: 'pending', pending_count: pending });
    return this.validateChecks({ status: 'green' });
  }

  private validateChecks(r: unknown): ChecksResult {
    const parsed = ChecksResultSchema.safeParse(r);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'checks result failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  // ─── mergeAtomic (plan v3+v4: OD1 + Δ1/Δ2/Δ4 + ΔA/ΔC) ─────────────────────

  async mergeAtomic(pr: PullRequestRef, expectedHeadSha: string): Promise<MergeAttemptOutcome> {
    // 1. Re-probe fence (OD1a): any regression → typed failure, no mutation.
    const report = await this.probe();
    const barFailure = evaluateProbeBar(report);
    if (barFailure !== null) {
      return this.validateOutcome({ ok: false, reason: 'protection_rejected', detail: barFailure });
    }

    // 2. The merge command — no --admin, no --auto, BY CONSTRUCTION.
    const mergeRes = await this.gh([
      'pr', 'merge', String(pr.number),
      '--repo', pr.repo,
      '--squash',
      '--match-head-commit', expectedHeadSha,
    ]);

    // 3. Phase A — bounded post-command observation (plan v4 Δ1 + ΔA). The
    //    first absent read never terminates; stable absence = 2 consecutive
    //    known-absent reads; exhaustion without merged/enrollment/stable
    //    absence → loud failure, NEVER head/check classification.
    const phaseA = await this.observeEnrollment(pr, 'detect');
    if (phaseA.kind === 'merged') return this.mergedOutcome(phaseA.result, expectedHeadSha);
    if (phaseA.kind === 'unconfirmed') {
      return this.validateOutcome({
        ok: false,
        reason: 'transport',
        detail: `standing_enrollment_unconfirmed: ${phaseA.detail}`,
      });
    }
    if (phaseA.kind === 'enrolled') {
      // Revoke by enrollment form (plan v3: --disable-auto CANNOT dequeue).
      const revokeFailure = await this.revokeEnrollment(pr, phaseA);
      if (revokeFailure !== null) {
        return this.validateOutcome({ ok: false, reason: 'transport', detail: revokeFailure });
      }
      // Phase B — post-revocation confirmation.
      const phaseB = await this.observeEnrollment(pr, 'confirm');
      if (phaseB.kind === 'merged') return this.mergedOutcome(phaseB.result, expectedHeadSha);
      if (phaseB.kind !== 'absent') {
        return this.validateOutcome({
          ok: false,
          reason: 'transport',
          detail: 'standing_enrollment_unconfirmed: enrollment still observable after revocation',
        });
      }
      return this.validateOutcome({
        ok: false,
        reason: 'protection_rejected',
        detail: `merge command created standing enrollment (revoked): ${mergeRes.stderr.slice(0, 300)}`,
      });
    }

    // 4. Stable absence, not merged: classify per the plan-v4 Δ4 table.
    return this.classifyUnmerged(pr, expectedHeadSha, mergeRes);
  }

  private async mergedOutcome(result: MergeResult, expectedHeadSha: string): Promise<MergeAttemptOutcome> {
    if (!result.merged) {
      return this.validateOutcome({ ok: false, reason: 'transport', detail: 'merged observation lost on re-read' });
    }
    if (result.merged_head_sha !== expectedHeadSha.toLowerCase()) {
      // Plan v4 Δ4 / R2 #2: a merged PR with the WRONG head is never success.
      return this.validateOutcome({
        ok: false,
        reason: 'tainted_merge',
        detail: `merged head ${result.merged_head_sha} != expected ${expectedHeadSha.toLowerCase()}`,
      });
    }
    return this.validateOutcome({ ok: true, merge_commit_sha: result.merge_commit_sha });
  }

  private async classifyUnmerged(
    pr: PullRequestRef,
    expectedHeadSha: string,
    mergeRes: ExecResult,
  ): Promise<MergeAttemptOutcome> {
    const head = await this.headSha(pr);
    if (head.ok) {
      if (head.sha !== expectedHeadSha.toLowerCase()) {
        return this.validateOutcome({
          ok: false,
          reason: 'head_drift',
          detail: `head ${head.sha} != expected ${expectedHeadSha.toLowerCase()}`,
        });
      }
      const checks = await this.requiredChecksGreen(pr);
      if (checks.status === 'red' || checks.status === 'pending') {
        return this.validateOutcome({
          ok: false,
          reason: 'checks_not_green',
          detail: `required checks ${checks.status}`,
        });
      }
      if (checks.status === 'unknown') {
        return this.validateOutcome({
          ok: false,
          reason: 'transport',
          detail: `checks state unknown: ${checks.reason}`,
        });
      }
      // Green checks + right head + unmerged (plan v4 ΔC): a DEFINITE server
      // policy refusal is 'protection_rejected'; an executor/network/no-ack
      // failure is 'transport' — conservative default is transport.
      // ΔC (MAJ impl-R1 #2): stderr is diagnostic — 'protection_rejected'
      // needs API-shaped merge-refusal evidence AND no transport/auth noise;
      // everything ambiguous stays 'transport' (retryable, not parked).
      const transportNoise =
        /(SAML|SSO|rate limit|secondary rate|timed? ?out|EAI_|ENOTFOUND|ECONN|dial tcp|proxy|TLS|certificate|executor rejected|connection|network)/i.test(
          mergeRes.stderr,
        );
      const definitePolicy =
        mergeRes.exitCode !== 0 &&
        !transportNoise &&
        /(not mergeable|review is required|review required|required status check|merge queue is required|protected branch|base branch was modified|HTTP 405|HTTP 422)/i.test(
          mergeRes.stderr,
        );
      if (definitePolicy) {
        return this.validateOutcome({
          ok: false,
          reason: 'protection_rejected',
          detail: mergeRes.stderr.slice(0, 500),
        });
      }
      return this.validateOutcome({
        ok: false,
        reason: 'transport',
        detail: `merge not acknowledged (exit ${mergeRes.exitCode}): ${mergeRes.stderr.slice(0, 400)}`,
      });
    }
    if (head.reason === 'auth' || head.reason === 'transport') {
      return this.validateOutcome({ ok: false, reason: 'transport', detail: `head unreadable (${head.reason})` });
    }
    // closed / not_found / no_head: ONE final merge-state reconciliation, then
    // fail closed — NEVER head_drift (plan v4 Δ4).
    const final = await this.mergeResult(pr);
    if (final.merged) {
      if (final.merged_head_sha === expectedHeadSha.toLowerCase()) {
        return this.validateOutcome({ ok: true, merge_commit_sha: final.merge_commit_sha });
      }
      return this.validateOutcome({
        ok: false,
        reason: 'tainted_merge',
        detail: `merged head ${final.merged_head_sha} != expected ${expectedHeadSha.toLowerCase()}`,
      });
    }
    return this.validateOutcome({
      ok: false,
      reason: 'pr_closed',
      detail: head.reason === 'closed' ? 'pr_closed_unmerged' : 'pr_missing',
    });
  }

  private validateOutcome(r: unknown): MergeAttemptOutcome {
    const parsed = MergeAttemptOutcomeSchema.safeParse(r);
    if (!parsed.success) {
      throw new RepoHostError('schema', 'merge attempt outcome failed schema validation', {
        zodError: parsed.error.message,
      });
    }
    return parsed.data;
  }

  // Bounded enrollment observation (plan v4 Δ1 + ΔA): 3 reads × delay.
  // Returns: merged | enrolled (with forms) | absent (2 consecutive known-
  // absent) | unconfirmed (exhaustion without any of the above).
  // mode 'detect' (Phase A): a positive enrollment observation returns
  // immediately — it must be revoked. mode 'confirm' (Phase B, MAJ impl-R1
  // #1): a positive read may be STALE cache after a successful revoke, so
  // polling continues through it; only exhaustion-with-last-read-positive
  // parks as still-enrolled.
  private async observeEnrollment(pr: PullRequestRef, mode: 'detect' | 'confirm'): Promise<
    | { kind: 'merged'; result: MergeResult }
    | { kind: 'enrolled'; auto: boolean; queued: boolean; nodeId: string }
    | { kind: 'absent' }
    | { kind: 'unconfirmed'; detail: string }
  > {
    let consecutiveAbsent = 0;
    let lastEnrolled: { auto: boolean; queued: boolean; nodeId: string } | null = null;
    let lastDetail = 'no successful observation';
    for (let read = 0; read < 3; read += 1) {
      if (read > 0 && this.delay > 0) await sleep(this.delay);
      let obs;
      try {
        obs = await this.observe(pr);
      } catch (err) {
        consecutiveAbsent = 0; // unknown reads never count toward stable absence
        lastDetail = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (obs === null) {
        consecutiveAbsent = 0;
        lastDetail = 'pull request not observable';
        continue;
      }
      if (obs.state === 'MERGED') {
        const result = await this.mergeResult(pr);
        return { kind: 'merged', result };
      }
      const auto = obs.autoMergeRequest !== null;
      const queued = obs.isInMergeQueue || obs.mergeQueueEntry !== null;
      if (auto || queued) {
        if (mode === 'detect') return { kind: 'enrolled', auto, queued, nodeId: obs.id };
        lastEnrolled = { auto, queued, nodeId: obs.id };
        consecutiveAbsent = 0;
        lastDetail = 'enrollment still observable';
        continue;
      }
      lastEnrolled = null;
      consecutiveAbsent += 1;
      lastDetail = 'absent';
      if (consecutiveAbsent >= 2 && read >= 2) return { kind: 'absent' };
    }
    if (consecutiveAbsent >= 2) return { kind: 'absent' };
    if (mode === 'confirm' && lastEnrolled !== null) {
      return { kind: 'enrolled', ...lastEnrolled };
    }
    return { kind: 'unconfirmed', detail: lastDetail };
  }

  // Revoke standing enrollment by form. Auto-merge → gh pr merge --disable-auto;
  // queue → GraphQL dequeuePullRequest (--disable-auto returns
  // ErrAlreadyInMergeQueue when queued and cannot dequeue — Codex plan R2 #1).
  private async revokeEnrollment(
    pr: PullRequestRef,
    enrolled: { auto: boolean; queued: boolean; nodeId: string },
  ): Promise<string | null> {
    if (enrolled.queued) {
      const res = await this.gh([
        'api', 'graphql',
        '-f', 'query=mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}',
        '-f', `id=${enrolled.nodeId}`,
      ]);
      if (res.exitCode !== 0) {
        return `standing_enrollment: dequeuePullRequest failed: ${res.stderr.slice(0, 400)}`;
      }
    }
    if (enrolled.auto) {
      const res = await this.gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, '--disable-auto']);
      if (res.exitCode !== 0) {
        return `standing_enrollment: --disable-auto failed: ${res.stderr.slice(0, 400)}`;
      }
    }
    return null;
  }
}

// ─── Probe bar (consumer parking predicate; exported for FORGE-234) ──────────

// Returns null when the report satisfies the 'auto' minimum bar
// (ORCHESTRATOR:887), else the park-able reason string.
export function evaluateProbeBar(report: ProbeReport): string | null {
  if (!report.ok) return `probe failed (${report.reason}): ${report.detail}`;
  if (report.blocking_check_count < 1) return 'no blocking required status check on the base branch';
  if (!report.squash_allowed) return 'squash merge method is not allowed';
  if (!report.write_permission) return 'authenticated identity lacks write permission';
  if (report.bypass_rules_present) return 'admin bypass is in play on the base branch';
  if (report.merge_queue_enabled) return 'base branch has a merge queue (unsupported for auto)';
  return null;
}
