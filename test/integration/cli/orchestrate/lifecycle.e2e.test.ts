// Per-fixture lifecycle drive-through (FORGE-110).
//
// GATED: this file self-skips unless FORGE_E2E_FIXTURE is set to one of
// github | linear | notion. Plain `npm test` runs it as a no-op (the glob
// picks it up, but every test short-circuits with a skip), so there is no
// double-run of the heavier scenarios on every PR. CI runs it explicitly in
// the `e2e` job: a Node 22/24 × {github,linear,notion} matrix invoking
//   FORGE_E2E_FIXTURE=<name> node --test --import tsx <thisfile>
// See .github/workflows/ci.yml and test/integration/README.md.
//
// SCOPE — this file EXTENDS, it does not duplicate:
//   - e2e.test.ts already covers the spawned verb-chain (run start → phases →
//     claim → dispatch → heartbeat → question → complete/cancel) generically
//     under FORGE_NOOP_TRACKER. Here we drive the chain ONLY as far as needed
//     to host the amend-roadmap drift-warning assertion (an attempt must still
//     be RUNNING when amend-roadmap runs — ready_for_review is NOT in
//     ACTIVE_STATES, so the drift notice must be observed before `complete`).
//   - apply-decision.e2e.test.ts covers the apply+resume journal mechanics
//     generically (the partial-failure-then-resume split, INDEX idempotence).
//     Here we run the FULL update-spec closed loop ON a fixture: an accepted
//     ADR + payload-complete journal (per skills/update-spec/SKILL.md's worked
//     example) → dry-run plan → apply (markers/INDEX/commit-msg/ADR-deletion/
//     archive) → a crash-then-resume against the same fixture.
//   - reconcile.e2e.test.ts covers round-trip / orphan-prune / comment
//     preservation generically. Here we assert retitle-drift --pull and
//     body-writing --push on the fixture's own phases.yaml.
//
// SEAM REALITY (plan delta 2): the tracker FACTORY cannot inject a transport.
// The verbs that take a `trackerOverride` / `tracker` dep (reconcile,
// amend-roadmap, apply-decision, claim) receive an in-memory Tracker whose
// `type` matches the fixture's tracker — this exercises the Tracker CONTRACT
// per-fixture (amend-roadmap's SOURCE_TRACKER_MISMATCH gate is type-sensitive).
// Transport-level realism (scripted GhExec / NtnExec parsing of `gh` / `ntn`
// argv) is already covered exhaustively by the adapter unit suites
// (test/unit/trackers + test/fixtures/trackers/*); re-driving it here would be
// duplication. The spawned state-machine verbs run under FORGE_NOOP_TRACKER=1
// (the tracker is irrelevant to their assertions), EXCEPT the CAS race, which
// uses claim's `deps.tracker` ClaimableTracker seam with a scripted first-wins
// mock (named below).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { tsxBin, forgeBinEntry as entry } from '../../../helpers/spawn-tsx.ts';
import { runOrchestrateReconcile } from '../../../../src/cli/orchestrate/reconcile.ts';
import { runOrchestrateAmendRoadmap } from '../../../../src/cli/orchestrate/amend-roadmap.ts';
import { runOrchestrateApplyDecision } from '../../../../src/cli/orchestrate/apply-decision.ts';
import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult, Issue, IssueListPage, TrackerType } from '../../../../src/trackers/types.ts';
import type { ClaimFenceData } from '../../../../src/trackers/claim-fence.ts';
import { runMigrate } from '../../../../src/cli/migrate/migrate.ts';

// ── Gate ─────────────────────────────────────────────────────────────────────

const FIXTURE = process.env.FORGE_E2E_FIXTURE as 'github' | 'linear' | 'notion' | undefined;
const FIXTURE_TRACKER: Record<string, TrackerType> = {
  github: 'github',
  linear: 'linear',
  notion: 'notion',
};
const SKIP_MSG =
  'FORGE_E2E_FIXTURE not set to github|linear|notion — run via the CI `e2e` job ' +
  '(.github/workflows/ci.yml) or `FORGE_E2E_FIXTURE=github node --test --import tsx <file>`; ' +
  'see test/integration/README.md.';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

function gated(): boolean {
  return FIXTURE === 'github' || FIXTURE === 'linear' || FIXTURE === 'notion';
}

// ── World setup: copy examples/greenfield-<fixture> → temp + git init ──────────

interface World {
  readonly dir: string; // repo root (the copied fixture)
  readonly forgeDir: string;
  cleanup(): void;
}

function makeWorld(): World {
  const fixture = FIXTURE!;
  const src = join(repoRoot, 'examples', `greenfield-${fixture}`);
  const dir = mkdtempSync(join(tmpdir(), `forge-lifecycle-${fixture}-`));
  cpSync(src, dir, { recursive: true });
  // git init + commit so reconcile's computeSpecRevision and the update-spec
  // clean-target / commit steps have a real repo to operate against.
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'e2e@forge.test']);
  git(['config', 'user.name', 'Forge E2E']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture import']);
  return {
    dir,
    forgeDir: join(dir, '.forge'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Normalize dynamic fields (plan delta 4) — claim/attempt UUIDs, lease
// expiries, regenerated synced_at are dynamic BY DESIGN. We assert schema /
// consistency, never byte-equality on regenerated files.
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Spawned-verb helper (state machine: run start/phases/claim/…/complete) ────

function runVerb(
  args: readonly string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): { envelope: Record<string, unknown>; status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, FORGE_NOOP_TRACKER: '1', ...extraEnv };
  const res = spawnSync(tsxBin, [entry, ...args, '--json'], { cwd, env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '').trim();
  const stderr = String(res.stderr ?? '');
  let envelope: Record<string, unknown> = {};
  if (stdout) {
    // Single-envelope discipline: the JSON envelope is the LAST stdout line.
    const lastNewline = stdout.lastIndexOf('\n');
    const lastLine = lastNewline >= 0 ? stdout.slice(lastNewline + 1) : stdout;
    try {
      envelope = JSON.parse(lastLine);
    } catch {
      envelope = {};
    }
  }
  return { envelope, status: res.status ?? 1, stdout, stderr };
}

// ── In-memory Tracker (fixture-typed) for reconcile/amend/apply-decision ──────

interface FakeTrackerHandle {
  tracker: Tracker;
  setIssue(issue: Issue): void;
  getIssue(id: string): Issue | undefined;
  bodyCalls: { id: string; body: string }[];
  createCalls: unknown[];
  blockedByCalls: { issueId: string; blockerId: string }[];
}

// Locally defined per plan delta 2 ("No Linear FakeTracker fixture exists —
// define the in-memory one locally"). Generic over fixture tracker type so
// amend-roadmap's SOURCE_TRACKER_MISMATCH gate sees the right `type`.
function makeFakeTracker(
  type: TrackerType,
  initial: Issue[] = [],
  opts: { failBodyOnCall?: number } = {},
): FakeTrackerHandle {
  const issues = new Map<string, Issue>();
  for (const i of initial) issues.set(i.id, i);
  const bodyCalls: { id: string; body: string }[] = [];
  const createCalls: unknown[] = [];
  const blockedByCalls: { issueId: string; blockerId: string }[] = [];
  let bodyCallCount = 0;
  const tracker: Tracker = {
    type,
    listActiveIssues: async () => Array.from(issues.values()),
    listAllIssues: async (): Promise<IssueListPage> => ({
      issues: Array.from(issues.values()),
      truncated: false,
    }),
    async claim() {
      throw new Error('claim() not used through Tracker override in lifecycle e2e');
    },
    async releaseClaim() {},
    async updateState() {},
    async comment() {},
    async updateIssueBody(id: string, body: string) {
      bodyCallCount += 1;
      if (opts.failBodyOnCall && bodyCallCount === opts.failBodyOnCall) {
        throw new Error('simulated tracker body-write failure');
      }
      bodyCalls.push({ id, body });
      const cur = issues.get(id);
      if (cur) issues.set(id, { ...cur, title: cur.title });
    },
    async setClaimFence() {},
    async createProject() {
      return { id: 'proj', url: 'https://example.test/proj' };
    },
    async createIssue(payload) {
      createCalls.push(payload);
      const id = `uuid-${createCalls.length}`;
      const identifier = (payload as { forgeTaskId: string }).forgeTaskId.replace(/^P/, 'X');
      const created: Issue = {
        id,
        identifier,
        title: (payload as { title: string }).title,
        state: 'todo',
        blockerIds: [],
        forgeTaskId: (payload as { forgeTaskId: string }).forgeTaskId,
        url: `https://example.test/${identifier}`,
      };
      issues.set(id, created);
      return created;
    },
    async setBlockedBy(issueId: string, blockerId: string) {
      blockedByCalls.push({ issueId, blockerId });
    },
    async healthCheck() {
      return { ok: true };
    },
  };
  return {
    tracker,
    setIssue: (issue: Issue) => issues.set(issue.id, issue),
    getIssue: (id: string) => issues.get(id),
    bodyCalls,
    createCalls,
    blockedByCalls,
  };
}

function captureStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, chunks };
}

// Map fixture → the tracker_issue_id prefix used in its phases.yaml.
function issuePrefix(): string {
  return { github: 'GH', linear: 'LN', notion: 'NT' }[FIXTURE!];
}

// Issue rows mirroring the fixture's phases.yaml (forgeTaskId binding intact).
function fixtureIssues(): Issue[] {
  const p = issuePrefix();
  const rows: Array<[string, string, string]> = [
    ['P1-T01', '1', 'Bootstrap the project skeleton'],
    ['P1-T02', '2', 'Wire the data layer'],
    ['P1-T03', '3', 'Add the HTTP surface'],
    ['P2-T01', '4', 'Add observability'],
    ['P2-T02', '5', 'Build the dashboard'],
    ['P2-T03', '6', 'Final acceptance pass'],
  ];
  // phases.yaml binds tracker_issue_id = `${p}-${n}` (e.g. GH-1). reconcile
  // keys issues by `issue.id`, so the issue id MUST equal that bound value.
  return rows.map(([forgeTaskId, n, title]) => ({
    id: `${p}-${n}`,
    identifier: `${p}-${n}`,
    title,
    state: 'todo' as const,
    blockerIds: [],
    forgeTaskId,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fixture sanity
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle e2e — fixture sanity: phases validate + spec anchors resolve', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const { parseDocument } = await import('yaml');
  const { PhasesSchema } = await import('../../../../src/schemas/phases.ts');
  const { SettingsSchema } = await import('../../../../src/schemas/settings.ts');
  const { parseSectionRef } = await import('../../../../src/orchestrator/markdown-section.ts');

  const w = makeWorld();
  try {
    const phases = PhasesSchema.parse(
      parseDocument(readFileSync(join(w.dir, 'plans/phases.yaml'), 'utf8')).toJS(),
    );
    assert.equal(phases.phases.length, 2);
    assert.equal(phases.phases.flatMap((p) => p.tasks).length, 6);
    assert.equal(phases.source?.tracker, FIXTURE_TRACKER[FIXTURE!]);

    const settings = SettingsSchema.parse(
      parseDocument(readFileSync(join(w.dir, '.forge/settings.yaml'), 'utf8')).toJS(),
    );
    assert.equal(settings.tracker.type, FIXTURE_TRACKER[FIXTURE!]);

    // Spec anchors resolve (the two real headings).
    const spec = readFileSync(join(w.dir, 'spec/SPEC.md'), 'utf8');
    for (const ref of ['spec/SPEC.md §CLI surface', 'spec/SPEC.md §Data model']) {
      const { anchor } = parseSectionRef(ref);
      assert.ok(anchor.length > 0);
    }
    assert.match(spec, /## CLI surface/);
    assert.match(spec, /## Data model/);
  } finally {
    w.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lifecycle chain (only as far as RUNNING) + 6. amend-roadmap drift warning
//    The chain is driven via the spawned CLI under FORGE_NOOP_TRACKER. We stop
//    at RUNNING so the amend-roadmap drift notice can observe an ACTIVE attempt
//    (ready_for_review is NOT in ACTIVE_STATES — plan delta 1).
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle e2e — chain to RUNNING then amend-roadmap drift lists the active attempt', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const w = makeWorld();
  try {
    const { forgeDir, dir } = w;
    const p = issuePrefix();
    const t01 = `${p}-1`; // P1-T01's tracker_issue_id

    // run start
    let res = runVerb(['orchestrate', 'run', 'start', '--name', 'lifecycle', '--forge-dir', forgeDir], dir);
    assert.equal(res.status, 0, res.stderr);
    const runId = (res.envelope.data as { run_id: string }).run_id;
    assert.match(runId, UUIDV7);

    // phases --ready surfaces the dep-free tasks (P1-T01..P1-T03 + P2 are
    // blocked by deps). Asserts envelope shape only.
    res = runVerb(['orchestrate', 'phases', '--ready', '--phase', 'implement', '--forge-dir', forgeDir], dir);
    assert.equal(res.status, 0, res.stderr);
    const ready = (res.envelope.data as { tasks: Array<{ task_id: string }> }).tasks.map((x) => x.task_id);
    assert.ok(ready.includes(t01), `ready should include ${t01}, got ${ready.join(',')}`);
    // P2-T03 depends on P2-T01+P2-T02 → must NOT be ready.
    assert.ok(!ready.includes(`${p}-6`));

    // claim → ensure-worktree (skipped: no real git remote in temp; covered by
    // e2e.test.ts) → dispatch → heartbeat (dispatched→running).
    res = runVerb(['orchestrate', 'claim', t01, '--run', runId, '--forge-dir', forgeDir], dir);
    assert.equal(res.status, 0, res.stderr);
    const claimId = (res.envelope.data as { claim_id: string }).claim_id;
    assert.match(claimId, UUIDV7);

    const wt = join(dir, 'wt-1');
    mkdirSync(wt, { recursive: true });
    res = runVerb(
      ['orchestrate', 'dispatch', t01, '--claim', claimId, '--run', runId, '--worktree', wt, '--phase', 'implement', '--forge-dir', forgeDir],
      dir,
    );
    assert.equal(res.status, 0, res.stderr);
    const attemptId = (res.envelope.data as { attempt_id: string }).attempt_id;
    assert.match(attemptId, UUIDV7);

    res = runVerb(['orchestrate', 'heartbeat', t01, '--attempt', attemptId, '--forge-dir', forgeDir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.equal((res.envelope.data as { first_heartbeat: boolean }).first_heartbeat, true);

    // World-state: the task state is one of the active states (running, or
    // blocked_on_question→answered respawn-eligible). Assert state.json schema
    // and that the lease + events log exist.
    const statePath = join(forgeDir, 'orchestrator/tasks', t01, 'state.json');
    const stateAfterHeartbeat = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(stateAfterHeartbeat.task_id, t01);
    assert.ok(existsSync(join(forgeDir, 'orchestrator/tasks', t01, 'lease.json')));

    // Isolation guard (plan risks): the CLI wrote ONLY under the temp .forge,
    // never the real repo's orchestrator state.
    assert.ok(forgeDir.startsWith(tmpdir()));
    assert.ok(!existsSync(join(repoRoot, '.forge/orchestrator/tasks', t01)));

    // ── amend-roadmap mid-flight (scenario 6) ───────────────────────────────
    // Must run while state === 'running' (immediately after the first heartbeat,
    // BEFORE the question verb which transitions state away from running).
    // ACTIVE_STATES also includes claimed/dispatched/blocked_on_question/
    // awaiting_respawn; this test deliberately pins the STRONGEST member —
    // running — so the drift warning is proven against an actively-working attempt.
    {
      const stateNow = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(stateNow.state, 'running', `state must be 'running' before amend-roadmap; got '${stateNow.state}'`);

      const payloadPath = join(dir, 'amend-payload.json');
      writeFileSync(
        payloadPath,
        JSON.stringify({
          phase: 'phase-2',
          title: 'Add rate limiting',
          description: 'Throttle the public API.',
          type: 'backend',
          priority: 'P2',
          estimate: 'S',
          owner_type: 'backend-dev',
          acceptance: ['429 on burst'],
          depends_on: ['P1-T03'],
        }),
        'utf8',
      );
      const fake = makeFakeTracker(FIXTURE_TRACKER[FIXTURE!], fixtureIssues());
      const origWriteAmend = process.stdout.write.bind(process.stdout);
      const captured: string[] = [];
      process.stdout.write = ((c: unknown) => {
        captured.push(String(c));
        return true;
      }) as typeof process.stdout.write;
      let amendExit: number;
      try {
        const r = await runOrchestrateAmendRoadmap(
          { payloadPath, forgeDir, repoRoot: dir, json: true },
          { trackerOverride: fake.tracker },
        );
        amendExit = r.exitCode;
      } finally {
        process.stdout.write = origWriteAmend;
      }
      assert.equal(amendExit, 0, `amend-roadmap should succeed: ${captured.join('')}`);
      // Find the JSON envelope among captured chunks.
      let amendEnv: { ok: boolean; data?: { task_id: string; drift_warnings: Array<{ task_id: string }> } } | undefined;
      for (let i = captured.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(captured[i]!.trim());
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            amendEnv = parsed;
            break;
          }
        } catch {
          /* reporter noise */
        }
      }
      assert.ok(amendEnv, 'amend envelope not found');
      assert.equal(amendEnv!.data!.task_id, 'P2-T04'); // next id in phase-2 (after T03)
      // The drift notice lists the active attempt (the claimed task above). Its
      // task_id is the tracker_issue_id (claim used t01) OR the phases id —
      // whichever the verb keys state dirs by (claim used t01).
      const driftIds = amendEnv!.data!.drift_warnings.map((d) => d.task_id);
      assert.ok(driftIds.includes(t01), `drift should list active attempt ${t01}, got ${driftIds.join(',')}`);
      // amend created the issue + wired the relation.
      assert.equal(fake.createCalls.length, 1);
      assert.equal(fake.blockedByCalls.length, 1);
    }

    // question + answer round-trip (AFTER amend-roadmap, state is still running).
    res = runVerb(
      [
        'orchestrate', 'question', t01,
        '--attempt', attemptId,
        '--decision-key', 'arch:lifecycle:q1',
        '--question', 'Proceed with the relational store?',
        // No options file → the verb defaults to yes/no options, so the
        // recommended id must be 'yes' or 'no'.
        '--recommended-option-id', 'yes',
        '--what-happens-if-unanswered', 'Block until the supervisor answers.',
        '--forge-dir', forgeDir,
      ],
      dir,
    );
    assert.equal(res.status, 0, res.stderr);
    const questionId = (res.envelope.data as { question_id: string }).question_id;
    assert.ok(questionId);

    // answer prints PLAIN TEXT (not a JSON envelope): `<question_id> --option <id>`.
    res = runVerb(
      ['orchestrate', 'answer', questionId, '--option', 'yes', '--note', 'default', '--forge-dir', forgeDir],
      dir,
    );
    assert.equal(res.status, 0, `answer failed: ${res.stderr}`);
  } finally {
    w.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Multi-main CAS race — two concurrent claims, scripted first-wins tracker.
//    MECHANISM: claim's `deps.tracker` ClaimableTracker seam (see
//    src/cli/orchestrate/claim.ts ClaimDeps.tracker). A single shared
//    first-wins mock returns {ok:true} once then {ok:false, already_claimed}.
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle e2e — CAS race: exactly one claim wins, loser gets ALREADY_CLAIMED', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const w = makeWorld();
  try {
    const { forgeDir, dir } = w;
    const p = issuePrefix();
    const taskId = `${p}-1`;

    // First-wins ClaimableTracker: the FIRST claim() call returns ok:true;
    // every later call returns already_claimed. This is the scripted tracker
    // CAS that the real adapter's compare-and-set enforces in production.
    let claimed = false;
    const firstWins: ClaimableTracker = {
      type: FIXTURE_TRACKER[FIXTURE!],
      async claim(): Promise<ClaimResult> {
        if (claimed) return { ok: false, reason: 'already_claimed' };
        claimed = true;
        return { ok: true };
      },
      async releaseClaim() {},
      async setClaimFence(_id: string, _data: ClaimFenceData | null) {},
    };

    // Two runs, different run ids. Run start to get valid run ids on disk.
    const r1 = runVerb(['orchestrate', 'run', 'start', '--name', 'race-a', '--forge-dir', forgeDir], dir);
    const r2 = runVerb(['orchestrate', 'run', 'start', '--name', 'race-b', '--forge-dir', forgeDir], dir);
    const runA = (r1.envelope.data as { run_id: string }).run_id;
    const runB = (r2.envelope.data as { run_id: string }).run_id;

    // Capture envelopes written to stdout during the concurrent claims.
    // claim emits exactly one JSON line to process.stdout (via emit()) per call
    // when --json is set. We intercept stdout, collect all JSON lines, then verify
    // envelope-level guarantees (ok + error.code) rather than just exit codes.
    //
    // The two calls run concurrently (Promise.all) so the race is real: whichever
    // call reaches tracker.claim() first wins; the other sees the lease already
    // held (INVALID_STATE from pre-flight OR ALREADY_CLAIMED from the tracker).
    // The first-wins mock returns ok:true on the first tracker.claim() call and
    // {ok:false, reason:'already_claimed'} on every subsequent call — so the
    // loser that loses the tracker CAS gets ALREADY_CLAIMED.
    //
    // NOTE: because JS is single-threaded, "concurrent" here means event-loop
    // interleaving. The mock is stateful: first .claim() → ok:true, second → false.
    // The loser that calls tracker.claim() second gets {ok:false, reason:'already_claimed'}
    // → error.code ALREADY_CLAIMED. If the loser hits the local pre-flight (state
    // check) first, it sees INVALID_STATE instead. To guarantee ALREADY_CLAIMED
    // we must ensure the pre-flight passes for both — i.e. both see 'unclaimed'
    // state (or absent) before either writes the 'claimed' state. With Promise.all
    // the pre-flight checks interleave before either await tracker.claim() runs,
    // so both pass pre-flight and the tracker CAS decides the winner.
    const origWrite = process.stdout.write.bind(process.stdout);
    const capturedLines: string[] = [];
    process.stdout.write = ((c: unknown) => {
      capturedLines.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    let results: Array<{ exitCode: number }>;
    try {
      results = await Promise.all([
        runOrchestrateClaim(
          { taskId, runId: runA, forgeDir, json: true },
          { tracker: firstWins, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot: dir },
        ),
        runOrchestrateClaim(
          { taskId, runId: runB, forgeDir, json: true },
          { tracker: firstWins, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot: dir },
        ),
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const exits = results.map((r) => r.exitCode).sort();
    assert.deepEqual(exits, [0, 1], 'exactly one claim must win');

    // Parse all JSON envelopes from captured stdout lines.
    const envelopes: Array<{ ok: boolean; error?: { code: string } }> = [];
    for (const chunk of capturedLines) {
      for (const line of chunk.split('\n').map((l) => l.trim()).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            envelopes.push(parsed as { ok: boolean; error?: { code: string } });
          }
        } catch { /* skip non-JSON lines */ }
      }
    }

    // Exactly one ok:true (the winner).
    const winners = envelopes.filter((e) => e.ok === true);
    assert.equal(winners.length, 1, `expected exactly 1 ok:true envelope, got ${JSON.stringify(envelopes)}`);

    // The loser's envelope must carry ALREADY_CLAIMED.
    const losers = envelopes.filter((e) => e.ok === false);
    assert.equal(losers.length, 1, `expected exactly 1 ok:false envelope, got ${JSON.stringify(envelopes)}`);
    assert.equal(
      losers[0]!.error?.code,
      'ALREADY_CLAIMED',
      `loser error.code must be 'ALREADY_CLAIMED', got '${losers[0]!.error?.code}'`,
    );

    // World-state: exactly one lease + one claimed state, consistent.
    const statePath = join(forgeDir, 'orchestrator/tasks', taskId, 'state.json');
    const leasePath = join(forgeDir, 'orchestrator/tasks', taskId, 'lease.json');
    assert.ok(existsSync(statePath));
    assert.ok(existsSync(leasePath));
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.state, 'claimed');
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    // The winning run owns both the lease and the state's updated_by.
    assert.ok([runA, runB].includes(lease.owner_run_id), `lease.owner_run_id ${lease.owner_run_id} must be a started run`);
    assert.equal(state.updated_by.run_id, lease.owner_run_id);
  } finally {
    w.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 + 5. Full /update-spec closed loop ON the fixture + --resume crash recovery
// ─────────────────────────────────────────────────────────────────────────────

const SLUG = 'switch-storage-engine';
const ADR_DATE = '2026-01-02';

function authorAdr(dir: string): void {
  const adrDir = join(dir, 'spec/decisions');
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(
    join(adrDir, `${ADR_DATE}-${SLUG}.md`),
    `---
slug: ${SLUG}
date: ${ADR_DATE}
status: accepted
affected_tasks: []
affected_spec_sections:
  - "spec/SPEC.md §Data model"
affected_prd_sections: []
affected_phases_tasks:
  - P1-T02
---

# Switch storage engine

## Context
The example product outgrew its initial store.

## Decision
Adopt a relational store with versioned migrations.

## Consequences
Migrations become the schema source of truth.

## Alternatives considered
A document store — rejected for weak relational guarantees.
`,
    'utf8',
  );
}

// Author the payload-complete journal per skills/update-spec/SKILL.md's worked
// example: spec_sections (rewritten Data model), phases_tasks (P1-T02
// acceptance), empty prd/tracker arrays, finalize all-false.
function authorJournal(forgeDir: string, overrides: Record<string, unknown> = {}): string {
  const jdir = join(forgeDir, 'orchestrator/global/update-spec-apply-journal');
  mkdirSync(jdir, { recursive: true });
  const journal = {
    version: 1,
    slug: SLUG,
    started_at: '2026-01-02T00:00:00.000Z',
    spec_sections: [
      {
        ref: 'spec/SPEC.md#data-model',
        new_body: '## Data model\n\nThe persistence layer is PostgreSQL with versioned migrations.\n',
        status: 'pending',
      },
    ],
    prd_sections: [],
    phases_tasks: [{ id: 'P1-T02', field: 'acceptance', value: ['migrations run', 'rollback tested'], status: 'pending' }],
    tracker_issues: [],
    finalize: { commit_msg_written: false, index_appended: false, adr_deleted: false, archived: false },
    ...overrides,
  };
  const p = join(jdir, `${SLUG}.json`);
  writeFileSync(p, JSON.stringify(journal, null, 2));
  return p;
}

test('lifecycle e2e — update-spec closed loop: dry-run plan → apply (markers/INDEX/commit-msg/ADR-deletion/archive)', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const w = makeWorld();
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = origWrite;
    w.cleanup();
  });

  const { forgeDir, dir } = w;
  authorAdr(dir);
  const journalPath = authorJournal(forgeDir);

  const argsBase = { slug: SLUG, yesAll: false, dryRun: false, resume: false, repoRoot: dir, forgeDir, json: true };

  // Dry-run plan matches (no mutation).
  const dry = await runOrchestrateApplyDecision({ ...argsBase, dryRun: true });
  assert.equal(dry.exitCode, 0);
  // Nothing mutated by the dry run.
  assert.match(readFileSync(join(dir, 'spec/SPEC.md'), 'utf8'), /single relational store/);
  assert.ok(existsSync(join(dir, 'spec/decisions', `${ADR_DATE}-${SLUG}.md`)));

  // Real apply (no tracker entries → no tracker override needed).
  const applied = await runOrchestrateApplyDecision(argsBase);
  assert.equal(applied.exitCode, 0);

  // SPEC section rewritten between markers.
  const spec = readFileSync(join(dir, 'spec/SPEC.md'), 'utf8');
  assert.match(spec, /<!-- forge:adr-section:data-model -->/);
  assert.match(spec, /PostgreSQL with versioned migrations/);
  // CLI surface heading untouched.
  assert.match(spec, /## CLI surface/);

  // phases task acceptance amended.
  const phases = readFileSync(join(dir, 'plans/phases.yaml'), 'utf8');
  assert.match(phases, /rollback tested/);

  // INDEX appended, commit-msg written, ADR deleted, journal archived.
  assert.match(readFileSync(join(dir, 'spec/decisions/INDEX.md'), 'utf8'), new RegExp(`\`${SLUG}\``));
  assert.ok(existsSync(join(forgeDir, 'orchestrator/global/update-spec-apply-journal', `${SLUG}.commit-msg.txt`)));
  assert.ok(!existsSync(join(dir, 'spec/decisions', `${ADR_DATE}-${SLUG}.md`)));
  assert.ok(existsSync(join(forgeDir, 'orchestrator/global/update-spec-apply-journal/completed', `${SLUG}.json`)));
  assert.ok(!existsSync(journalPath));
});

test('lifecycle e2e — update-spec --resume crash recovery (tracker fails mid-push, heal, resume)', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const w = makeWorld();
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = origWrite;
    w.cleanup();
  });

  const { forgeDir, dir } = w;
  authorAdr(dir);
  // Journal WITH a tracker entry so we can fail the tracker push mid-apply.
  const journalPath = authorJournal(forgeDir, {
    tracker_issues: [{ id: `${issuePrefix()}-2`, new_body: 'rewritten body', retries: 0, status: 'pending' }],
  });

  const argsBase = { slug: SLUG, yesAll: false, dryRun: false, resume: false, repoRoot: dir, forgeDir, json: true };

  // Run 1: tracker fails on its first body write → retriable exit, journal
  // shows applied (spec/phases) / failed (tracker) split, ADR not deleted.
  const failTracker = makeFakeTracker(FIXTURE_TRACKER[FIXTURE!], fixtureIssues(), { failBodyOnCall: 1 });
  const r1 = await runOrchestrateApplyDecision(argsBase, { trackerOverride: failTracker.tracker });
  assert.notEqual(r1.exitCode, 0);
  const j1 = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(j1.spec_sections[0].status, 'applied');
  assert.equal(j1.phases_tasks[0].status, 'applied');
  assert.equal(j1.tracker_issues[0].status, 'failed');
  assert.ok(existsSync(join(dir, 'spec/decisions', `${ADR_DATE}-${SLUG}.md`))); // not finalized

  // Run 2: --resume with a healthy tracker → completes; markers idempotent (no
  // duplicate SPEC section writes).
  const healTracker = makeFakeTracker(FIXTURE_TRACKER[FIXTURE!], fixtureIssues());
  const r2 = await runOrchestrateApplyDecision({ ...argsBase, resume: true }, { trackerOverride: healTracker.tracker });
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(healTracker.bodyCalls.map((c) => c.id), [`${issuePrefix()}-2`]);
  // Exactly one managed-section block (markers idempotent).
  const spec = readFileSync(join(dir, 'spec/SPEC.md'), 'utf8');
  const blocks = spec.split('<!-- forge:adr-section:data-model -->').length - 1;
  assert.equal(blocks, 1);
  assert.ok(!existsSync(join(dir, 'spec/decisions', `${ADR_DATE}-${SLUG}.md`))); // finalized now
  assert.ok(!existsSync(journalPath));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. reconcile --pull retitle drift + --push bodies (on the fixture)
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle e2e — reconcile --pull applies retitle drift; --push writes bodies', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  const w = makeWorld();
  try {
    const { dir } = w;
    // Tracker returns the fixture's issues, but P1-T01 RETITLED.
    const issues = fixtureIssues();
    issues[0] = { ...issues[0]!, title: 'Bootstrap the project skeleton RETITLED' };
    const fake = makeFakeTracker(FIXTURE_TRACKER[FIXTURE!], issues);

    const o = captureStream();
    const pull = await runOrchestrateReconcile({
      cwd: dir,
      argv: ['--pull'],
      stdout: o.stream,
      stderr: captureStream().stream,
      trackerOverride: fake.tracker,
    });
    assert.equal(pull.exitCode, 0, o.chunks.join(''));
    const after = readFileSync(join(dir, 'plans/phases.yaml'), 'utf8');
    assert.match(after, /Bootstrap the project skeleton RETITLED/);
    // Comments preserved.
    assert.match(after, /# Frozen example roadmap/);

    // --push writes bodies back via updateIssueBody for every managed task.
    const o2 = captureStream();
    const push = await runOrchestrateReconcile({
      cwd: dir,
      argv: ['--push'],
      stdout: o2.stream,
      stderr: captureStream().stream,
      trackerOverride: fake.tracker,
    });
    assert.equal(push.exitCode, 0, o2.chunks.join(''));
    const pushEnv = JSON.parse(o2.chunks.join('').trim().split('\n').pop()!);
    assert.equal(pushEnv.ok, true);
    assert.ok(fake.bodyCalls.length >= 6, `expected ≥6 body writes, got ${fake.bodyCalls.length}`);
    const body1 = fake.bodyCalls.find((c) => c.id === `${issuePrefix()}-1`);
    assert.ok(body1, `body for ${issuePrefix()}-1 must be written`);
    assert.match(body1!.body, /Forge task ID:\*\* P1-T01/);
  } finally {
    w.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. migrate smoke — de-modernize a copy of the GITHUB fixture, migrate, re-run
//    clean. Only meaningful once (the github fixture); skip for linear/notion
//    to keep each cell focused + fast. Uses the BUILT dist CLI (plan §8).
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle e2e — migrate smoke: de-modernize → forge migrate --yes → detectors clean', async (t) => {
  if (!gated()) return t.skip(SKIP_MSG);
  if (FIXTURE !== 'github') {
    return t.skip('migrate smoke runs once, against the github fixture (tracker-agnostic detectors)');
  }
  const w = makeWorld();
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = origWrite;
    w.cleanup();
  });

  const { dir } = w;
  // De-modernize: strip the v0.4 settings blocks (codex/decisions/doctor), add
  // an @inherit line to DESIGN.md and a /push-to-linear reference. These are
  // exactly the v0.2.x drift signatures detectDrift looks for.
  const settingsPath = join(dir, '.forge/settings.yaml');
  let settings = readFileSync(settingsPath, 'utf8');
  settings = settings
    .replace(/codex:\n(?: {2}.*\n)+/, '')
    .replace(/decisions:\n(?: {2}.*\n)+/, '')
    .replace(/doctor:\n(?: {2}.*\n)+/, '');
  writeFileSync(settingsPath, settings, 'utf8');

  const designPath = join(dir, 'spec/DESIGN.md');
  writeFileSync(designPath, `# Design\n\n@inherit ../shared/design.md\n\nSee also /push-to-linear for tracker sync.\n`, 'utf8');

  // Run the BUILT dist CLI (plan §8): `node dist/bin/forge.cjs migrate --yes`.
  const distBin = join(repoRoot, 'dist/bin/forge.cjs');
  assert.ok(existsSync(distBin), 'dist/bin/forge.cjs must exist — run `npm run build` first');
  const mig = spawnSync('node', [distBin, 'migrate', '--yes'], { cwd: dir, encoding: 'utf8' });
  assert.equal(mig.status, 0, `migrate failed: ${mig.stderr}\n${mig.stdout}`);

  // Re-run the detectors (in-process) — must be clean of actionable drift.
  const o = captureStream();
  const e = captureStream();
  const re = await runMigrate({ cwd: dir, argv: ['--dry-run'], stdout: o.stream as unknown as NodeJS.WritableStream, stderr: e.stream as unknown as NodeJS.WritableStream });
  assert.equal(re.exitCode, 0, `re-run failed: ${e.chunks.join('')}`);
  const out = o.chunks.join('');
  // No remaining settings-block / push-to-linear actionable drift.
  assert.doesNotMatch(out, /lacks the v0\.4 .* block/);
  assert.doesNotMatch(out, /push-to-linear → \/push-to-tracker/);
} );
