// FORGE-234: ship-operation matrix (plan v1-v3 + R3 deltas). Hermetic —
// FakeRepoHost + scripted git/tracker/verify/gitleaks; no live processes.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runShipOperation, shipReceiptPath, type ShipOpDeps } from '../../../src/orchestrator/ship-op.ts';
import { FakeRepoHost, type FakeRepoHostScript } from '../../../src/repo-hosts/fake.ts';
import type { Exec } from '../../../src/repo-hosts/github.ts';
import { parseLeaseFile, type Lease } from '../../../src/schemas/lease.ts';
import { SettingsSchema, type Settings } from '../../../src/schemas/settings.ts';

const SHA = 'a'.repeat(40);
const SHA_OTHER = 'b'.repeat(40);
const TASK = 'FORGE-S1';
const ATTEMPT = '01890000-0000-7000-8000-000000000001';
const REPO = 'octo/base';
const PR = { repo: REPO, number: 7, url: `https://github.com/${REPO}/pull/7` };

interface Fx {
  forgeDir: string;
  worktree: string;
  settings: Settings;
  readLease: () => Lease;
}

function settingsOf(policy: 'approval' | 'auto', verify = true): Settings {
  return SettingsSchema.parse({
    version: 1,
    project: { name: 'fx' },
    tracker: { type: 'github', config: { repo: REPO } },
    secrets: { manager: 'env_file' },
    ship: { merge_policy: policy },
    ...(policy === 'auto' ? { agents: { review_host_cli: 'codex' } } : {}),
    ...(verify ? { verify: { commands: ['true'] } } : {}),
  });
}

function fixture(opts: { policy?: 'approval' | 'auto'; verify?: boolean; stateVersion?: number } = {}): Fx {
  const forgeDir = mkdtempSync(join(tmpdir(), 'forge-234-'));
  const worktree = mkdtempSync(join(tmpdir(), 'forge-234-wt-'));
  const taskDir = join(forgeDir, 'orchestrator', 'tasks', TASK);
  const attemptDir = join(taskDir, 'attempts', ATTEMPT);
  mkdirSync(attemptDir, { recursive: true });
  const sv = opts.stateVersion ?? 5;
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      version: 1, task_id: TASK, state: 'reviewed', state_version: sv, attempt_count: 1,
      failure_count: 0, last_failure_key: null, review_attempt_count: 1, ship_attempt_count: 1,
      current_attempt_id: ATTEMPT, updated_at: new Date().toISOString(),
      updated_by: { run_id: 'run-001', claim_id: 'claim-001', generation: 0 },
    }),
  );
  writeFileSync(
    join(taskDir, 'lease.json'),
    JSON.stringify({
      version: 1, claim_id: 'claim-001', task_id: TASK, attempt_id: null, owner_run_id: 'run-001',
      acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      last_heartbeat_at: new Date().toISOString(), generation: 0, spec_revision: 'digest:empty',
    }),
  );
  writeFileSync(
    join(attemptDir, 'manifest.json'),
    JSON.stringify({
      version: 1, attempt_id: ATTEMPT, task_id: TASK, run_id: 'run-001', claim_id: 'claim-001',
      generation: 0, phase: 'ship', worktree_path: worktree, dispatched_at: new Date().toISOString(),
      ship_target_sha: SHA,
    }),
  );
  writeFileSync(
    join(taskDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: TASK, revision: 2, reviewed_head_sha: SHA, review_attempt_id: 'att-rev',
      base: { repo: REPO, branch: 'main', push_remote: 'origin' }, pr: null,
      merge_attempt: 'not_started', updated_at: new Date().toISOString(),
    }),
  );
  mkdirSync(join(worktree, '.forge'), { recursive: true });
  writeFileSync(
    join(worktree, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId: TASK, branch: `feat/${TASK}`, base_branch: 'main' }),
  );
  const readLease = (): Lease => {
    const parsed = parseLeaseFile(JSON.parse(readFileSync(join(taskDir, 'lease.json'), 'utf8')));
    if (parsed.kind !== 'active') throw new Error('lease not active');
    return parsed.lease;
  };
  return { forgeDir, worktree, settings: settingsOf(opts.policy ?? 'approval', opts.verify), readLease };
}

interface GitScript {
  headSha?: string;
  pushExit?: number[] | number;
  pushStderr?: string;
}

function gitFake(fx: Fx, script: GitScript = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  let pushCount = 0;
  const exec: Exec = async (args) => {
    calls.push([...args]);
    const a = [...args];
    if (a.includes('rev-parse') && a.includes('HEAD') && !a.includes('--abbrev-ref')) {
      return { stdout: `${script.headSha ?? SHA}\n`, stderr: '', exitCode: 0 };
    }
    if (a.includes('--abbrev-ref')) return { stdout: `feat/${TASK}\n`, stderr: '', exitCode: 0 };
    if (a.includes('merge-base')) return { stdout: `${'9'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    if (a.includes('push')) {
      const exits = Array.isArray(script.pushExit) ? script.pushExit : [script.pushExit ?? 0];
      const exit = exits[Math.min(pushCount, exits.length - 1)]!;
      pushCount += 1;
      return { stdout: '', stderr: exit === 0 ? '' : (script.pushStderr ?? 'fatal: unable to access: connection timed out'), exitCode: exit };
    }
    return { stdout: '', stderr: `unscripted git: ${a.join(' ')}`, exitCode: 1 };
  };
  return { exec, calls };
}

const PROBE_OK = {
  ok: true, blocking_check_count: 2, squash_allowed: true, write_permission: true,
  bypass_rules_present: false, merge_queue_enabled: false,
};

function depsOf(fx: Fx, over: Partial<ShipOpDeps> & { script?: FakeRepoHostScript; gitScript?: GitScript } = {}): { deps: ShipOpDeps; host: FakeRepoHost; git: { exec: Exec; calls: string[][] } } {
  const host = new FakeRepoHost({
    base: { repo: REPO, branch: 'main', push_remote: 'origin' },
    probe: PROBE_OK,
    pullRequest: PR,
    headSha: { ok: true, sha: SHA },
    ...over.script,
  });
  const git = gitFake(fx, over.gitScript ?? {});
  const { script: _s, gitScript: _g, ...depOverrides } = over;
  const deps: ShipOpDeps = {
    git: git.exec,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
    repoHost: host,
    tracker: { updateState: async () => ({ ok: true as const }) },
    gitleaks: async () => ({ clean: true, detail: 'no leaks' }),
    sleepMs: async () => {},
    ...depOverrides,
  };
  return { deps, host, git };
}

const argsOf = (fx: Fx) => ({ forgeDir: fx.forgeDir, taskId: TASK, attemptId: ATTEMPT, settings: fx.settings });

// ─── Happy path ──────────────────────────────────────────────────────────────

test('ship success: SHA-bound push, PR bound, tracker updated, fenced receipt written', async () => {
  const fx = fixture();
  const { deps, git } = depsOf(fx);
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'success');
  const push = git.calls.find((c) => c.includes('push'))!;
  assert.ok(push.includes(`${SHA}:refs/heads/feat/${TASK}`), 'push is the immutable object refspec, never the branch ref');
  const receipt = JSON.parse(readFileSync(shipReceiptPath(fx.forgeDir, TASK, ATTEMPT), 'utf8'));
  assert.equal(receipt.target_sha, SHA);
  assert.equal(receipt.admitted_state_version, 5);
  assert.equal(receipt.probe, 'skipped_approval', 'approval policy has no probe bar');
  assert.deepEqual(receipt.pr, PR);
  const record = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'ship-record.json'), 'utf8'));
  assert.deepEqual(record.pr, PR, 'PR identity persisted');
  if (out.kind === 'success') {
    const input = JSON.parse(readFileSync(out.verdictInputPath, 'utf8'));
    assert.equal(input.verdict, 'ready_for_review');
    assert.equal(input.target_sha, SHA);
  }
});

test('the verb NEVER merges: no mergeAtomic call, no gh pr merge / --auto anywhere', async () => {
  const fx = fixture({ policy: 'auto' });
  const { deps, host, git } = depsOf(fx);
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'success');
  assert.ok(!host.calls.some((c) => c.op === 'mergeAtomic'), 'mergeAtomic is FORGE-235 tick territory');
  assert.ok(!git.calls.some((c) => c.join(' ').includes('pr merge') || c.includes('--auto')), 'no standing merge commands');
});

// ─── Probe (auto policy) ─────────────────────────────────────────────────────

test('auto policy: probe passes → receipt.probe=passed; bar failure → park probe_bar_failed; probe error → park probe_unavailable', async () => {
  const fxa = fixture({ policy: 'auto' });
  const a = depsOf(fxa);
  const outA = await runShipOperation(argsOf(fxa), a.deps, fxa.readLease);
  assert.equal(outA.kind, 'success');
  assert.equal(JSON.parse(readFileSync(shipReceiptPath(fxa.forgeDir, TASK, ATTEMPT), 'utf8')).probe, 'passed');

  const fxb = fixture({ policy: 'auto' });
  const b = depsOf(fxb, { script: { probe: { ...PROBE_OK, merge_queue_enabled: true } } });
  const outB = await runShipOperation(argsOf(fxb), b.deps, fxb.readLease);
  assert.equal(outB.kind, 'park');
  if (outB.kind === 'park') assert.equal(outB.reason, 'probe_bar_failed');

  const fxc = fixture({ policy: 'auto' });
  const c = depsOf(fxc, { script: { probe: { ok: false, reason: 'auth', detail: 'cannot verify' } } });
  const outC = await runShipOperation(argsOf(fxc), c.deps, fxc.readLease);
  assert.equal(outC.kind, 'park');
  if (outC.kind === 'park') assert.equal(outC.reason, 'probe_unavailable');
});

// ─── Failure paths (budgeted; pinned carriers) ───────────────────────────────

test('verify failure → failure carrier changes_needed pinned to the target', async () => {
  const fx = fixture();
  const { deps } = depsOf(fx, { runCommand: async () => ({ exitCode: 1, stdout: '', stderr: '1 test failed', timedOut: false }) });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'failure');
  if (out.kind === 'failure') {
    assert.equal(out.reason, 'verify_failed');
    const input = JSON.parse(readFileSync(out.verdictInputPath, 'utf8'));
    assert.equal(input.verdict, 'changes_needed');
    assert.equal(input.target_sha, SHA);
  }
});

test('secrets gate fails closed: missing gitleaks, scanner error, findings', async () => {
  for (const gitleaks of [
    undefined,
    async () => {
      throw new Error('scanner exploded');
    },
    async () => ({ clean: false, detail: 'aws key at src/x.ts:3' }),
  ] as const) {
    const fx = fixture();
    const { deps } = depsOf(fx, { gitleaks: gitleaks as ShipOpDeps['gitleaks'] });
    const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
    assert.equal(out.kind, 'failure');
    if (out.kind === 'failure') assert.equal(out.reason, 'secrets_scan_failed');
  }
});

test('push: transient failure retries then succeeds; exhaustion → push_failed', async () => {
  const fx = fixture();
  const { deps, git } = depsOf(fx, { gitScript: { pushExit: [1, 0] } });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'success');
  assert.equal(git.calls.filter((c) => c.includes('push')).length, 2);

  const fx2 = fixture();
  const d2 = depsOf(fx2, { gitScript: { pushExit: 1 } });
  const out2 = await runShipOperation(argsOf(fx2), d2.deps, fx2.readLease);
  assert.equal(out2.kind, 'failure');
  if (out2.kind === 'failure') assert.equal(out2.reason, 'push_failed');
});

test('tracker: retriable retries then ok; exhaustion → tracker_failed, NO receipt exists', async () => {
  let n = 0;
  const fx = fixture();
  const { deps } = depsOf(fx, {
    tracker: {
      updateState: async () => {
        n += 1;
        return n < 3 ? { ok: false as const, retriable: true, detail: 'rate limited' } : { ok: true as const };
      },
    },
  });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'success');

  const fx2 = fixture();
  const d2 = depsOf(fx2, {
    tracker: { updateState: async () => ({ ok: false as const, retriable: true, detail: 'still down' }) },
  });
  const out2 = await runShipOperation(argsOf(fx2), d2.deps, fx2.readLease);
  assert.equal(out2.kind, 'failure');
  if (out2.kind === 'failure') assert.equal(out2.reason, 'tracker_failed');
  assert.equal(existsSync(shipReceiptPath(fx2.forgeDir, TASK, ATTEMPT)), false, 'no receipt without the tracker milestone');
});

// ─── Drift ───────────────────────────────────────────────────────────────────

test('worktree HEAD drift → drift outcome, push NEVER runs', async () => {
  const fx = fixture();
  const { deps, git } = depsOf(fx, { gitScript: { headSha: SHA_OTHER } });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'drift');
  assert.ok(!git.calls.some((c) => c.includes('push')), 'drift refuses before any push');
});

test('remote PR head mismatch after create → drift', async () => {
  const fx = fixture();
  const { deps } = depsOf(fx, { script: { headSha: { ok: true, sha: SHA_OTHER } } });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'drift');
});

// ─── Parks ───────────────────────────────────────────────────────────────────

test('pr_conflict from createOrGet → park with incident fingerprint', async () => {
  const fx2 = fixture();
  const { deps: d2 } = depsOf(fx2);
  const { RepoHostError } = await import('../../../src/repo-hosts/errors.ts');
  (d2.repoHost as FakeRepoHost).createOrGetPullRequest = async () => {
    throw new RepoHostError('pr_conflict', 'ambiguous PR set for feat/FORGE-S1');
  };
  const out2 = await runShipOperation(argsOf(fx2), d2, fx2.readLease);
  assert.equal(out2.kind, 'park');
  if (out2.kind === 'park') {
    assert.equal(out2.reason, 'pr_conflict');
    assert.ok(out2.fingerprint.includes('pr_conflict'));
  }
});

test('no RepoHost → park unsupported_host', async () => {
  const fx = fixture();
  const { deps } = depsOf(fx, { repoHost: null });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'park');
  if (out.kind === 'park') assert.equal(out.reason, 'unsupported_host');
});

// ─── Fences + admission ──────────────────────────────────────────────────────

test('lease expiry mid-operation (before push) → refused, no push', async () => {
  const fx = fixture();
  let calls = 0;
  const expiringLease = (): Lease => {
    calls += 1;
    const lease = fx.readLease();
    // Expire after admission + first fences (verify runs before push fences).
    return calls <= 2 ? lease : { ...lease, expires_at: new Date(Date.now() - 1000).toISOString() };
  };
  const { deps, git } = depsOf(fx);
  const out = await runShipOperation(argsOf(fx), deps, expiringLease);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.code, 'LEASE_EXPIRED');
  assert.ok(!git.calls.some((c) => c.includes('push')), 'expired lease never pushes');
});

test('state-version movement (park/answer round-trip) invalidates the invocation (ΔR2/Δ14)', async () => {
  const fx = fixture();
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const original = JSON.parse(readFileSync(statePath, 'utf8'));
  let bumped = false;
  const { deps } = depsOf(fx, {
    runCommand: async () => {
      // While verify runs, the task round-trips park→answer: same state,
      // same attempt, same lease — only state_version moves (+2).
      if (!bumped) {
        writeFileSync(statePath, JSON.stringify({ ...original, state_version: original.state_version + 2 }));
        bumped = true;
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  });
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.code, 'STALE_ATTEMPT');
});

test('legacy ship manifest without ship_target_sha → typed re-dispatch refusal, zero mutation', async () => {
  const fx = fixture();
  const manifestPath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'attempts', ATTEMPT, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.ship_target_sha;
  writeFileSync(manifestPath, JSON.stringify(m));
  const { deps, git } = depsOf(fx);
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') {
    assert.equal(out.code, 'STALE_ATTEMPT');
    assert.match(out.detail, /re-dispatch/);
  }
  assert.equal(git.calls.length, 0);
});

test('record binding moved off the manifest pin → refused', async () => {
  const fx = fixture();
  const recordPath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'ship-record.json');
  const r = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, JSON.stringify({ ...r, revision: r.revision + 1, reviewed_head_sha: SHA_OTHER }));
  const { deps } = depsOf(fx);
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.code, 'STALE_ATTEMPT');
});

// ─── Idempotent re-run (crash recovery) ──────────────────────────────────────

test('re-run after crash-past-PR-create adopts the PR (record already bound) and converges', async () => {
  const fx = fixture();
  const first = depsOf(fx);
  const out1 = await runShipOperation(argsOf(fx), first.deps, fx.readLease);
  assert.equal(out1.kind, 'success');
  // Second invocation (replay): same PR scripted → createOrGet idempotent hit,
  // binding replays, receipt overwritten identically.
  const second = depsOf(fx);
  const out2 = await runShipOperation(argsOf(fx), second.deps, fx.readLease);
  assert.equal(out2.kind, 'success');
  const record = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'ship-record.json'), 'utf8'));
  assert.deepEqual(record.pr, PR);
});

// ─── impl-R1 fix-round additions ─────────────────────────────────────────────

test('per-retry fence: lease stolen during push backoff refuses BEFORE the retry mutation (impl-R1 CRIT #3)', async () => {
  const fx = fixture();
  let pushes = 0;
  const stealingLease = () => {
    const lease = fx.readLease();
    // After the first push attempt fails and backoff elapses, the lease is stolen.
    return pushes >= 1 ? { ...lease, claim_id: 'claim-thief' } : lease;
  };
  const { deps } = depsOf(fx, {
    gitScript: { pushExit: [1, 0] },
  });
  const origGit = deps.git;
  deps.git = async (args) => {
    if ([...args].includes('push')) pushes += 1;
    return origGit(args);
  };
  const out = await runShipOperation(argsOf(fx), deps, stealingLease as never);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.equal(out.code, 'LEASE_STOLEN');
  assert.equal(pushes, 1, 'the second push never ran under stolen authority');
});

test('unresolvable scan base fails CLOSED through the budgeted path (impl-R1 CRIT #2)', async () => {
  const fx = fixture();
  const { deps } = depsOf(fx);
  const origGit = deps.git;
  deps.git = async (args) => {
    if ([...args].includes('merge-base')) return { stdout: '', stderr: 'fatal: no merge base', exitCode: 128 };
    return origGit(args);
  };
  const out = await runShipOperation(argsOf(fx), deps, fx.readLease);
  assert.equal(out.kind, 'failure');
  if (out.kind === 'failure') {
    assert.equal(out.reason, 'secrets_scan_failed');
    assert.match(out.detail, /scan base/);
  }
});
