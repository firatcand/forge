// FORGE-226 (Loom I3): unit tests for the decision projector + decision recall.
//
// Seeds a real on-disk orchestrator tree (answered questions, autonomous_decision
// events, completed apply-journals) under a tmp forgeDir and asserts the projector
// produces decision nodes + decided_in/affects edges, deduped by
// (taskNodeId, decision_key), safely (symlink/malformed skip), and that reindex is
// idempotent + recall surfaces decisions both structurally and via FTS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectDecisions } from '../../../src/memory/project.ts';
import { reindex } from '../../../src/memory/ingest.ts';
import { openLocalBackend } from '../../../src/memory/local/backend.ts';
import { openDb } from '../../../src/memory/local/db.ts';

// ── fixture helpers ──────────────────────────────────────────────────────────
function attemptDirOf(forgeDir: string, task: string, attempt: string): string {
  return join(forgeDir, 'orchestrator', 'tasks', task, 'attempts', attempt);
}

function seedQuestion(
  forgeDir: string,
  task: string,
  attempt: string,
  q: {
    question_id: string;
    decision_key: string;
    question?: string;
    option_id: string;
    answered_at: string;
    note?: string;
    chosen_label?: string;
  },
): void {
  const aDir = attemptDirOf(forgeDir, task, attempt);
  mkdirSync(join(aDir, 'questions'), { recursive: true });
  mkdirSync(join(aDir, 'answers'), { recursive: true });
  const question = {
    version: 1,
    question_id: q.question_id,
    run_id: 'run-1',
    task_id: task,
    agent_id: 'agent-1',
    decision_key: q.decision_key,
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-06-01T00:00:00.000Z',
    expires_at: '2026-06-02T00:00:00.000Z',
    status: 'answered',
    question: q.question ?? `should we ${q.decision_key}?`,
    context: '',
    options: [
      { id: 'opt-a', label: q.chosen_label ?? 'Option A' },
      { id: 'opt-b', label: 'Option B' },
    ],
    classification: {
      decision_type: 'architectural',
      category: 'public_api',
      reversibility: 'low',
      blast_radius: 'project',
      default_action: 'ask',
      reason: 'because',
    },
  };
  const answer = {
    version: 1,
    question_id: q.question_id,
    answered_at: q.answered_at,
    answered_by: 'supervisor',
    option_id: q.option_id,
    ...(q.note ? { note: q.note } : {}),
  };
  writeFileSync(join(aDir, 'questions', `${q.question_id}.json`), JSON.stringify(question, null, 2));
  writeFileSync(join(aDir, 'answers', `${q.question_id}.json`), JSON.stringify(answer, null, 2));
}

function seedEvents(forgeDir: string, task: string, attempt: string, lines: unknown[]): void {
  const aDir = attemptDirOf(forgeDir, task, attempt);
  mkdirSync(aDir, { recursive: true });
  writeFileSync(join(aDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function seedCompletedJournal(forgeDir: string, slug: string, phasesTaskIds: string[]): void {
  const dir = join(forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal', 'completed');
  mkdirSync(dir, { recursive: true });
  const journal = {
    version: 1,
    slug,
    started_at: '2026-06-01T00:00:00.000Z',
    spec_sections: [],
    prd_sections: [],
    phases_tasks: phasesTaskIds.map((id) => ({
      id,
      field: 'description',
      value: 'updated',
      status: 'applied',
    })),
    tracker_issues: [],
    finalize: { commit_msg_written: true, index_appended: true, adr_deleted: true, archived: true },
    completed_at: '2026-06-02T00:00:00.000Z',
  };
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(journal, null, 2));
}

function makeResolver(): (raw: string) => string | null {
  const known = new Set(['task:P1-T01', 'task:P1-T02']);
  const tracker = new Map<string, string>([['FX-1', 'task:P1-T01']]);
  return (raw: string): string | null => {
    if (raw.startsWith('task:')) return known.has(raw) ? raw : null;
    const direct = `task:${raw}`;
    if (known.has(direct)) return direct;
    return tracker.get(raw) ?? null;
  };
}

const FIXTURE_PHASES = `project: dec-fixture
phases:
  - id: phase-1
    name: Phase one
    status: active
    goal: build things
    gate_criteria:
      - it works
    tasks:
      - id: P1-T01
        tracker_issue_id: FX-1
        title: First task
        description: do the first thing
        type: backend
        priority: P1
        estimate: M
        owner_type: backend-dev
        acceptance:
          - done
      - id: P1-T02
        title: Second task
        description: depends on first
        type: backend
        priority: P1
        estimate: S
        owner_type: backend-dev
        depends_on:
          - P1-T01
        acceptance:
          - done
`;

function snapshot(dbPath: string): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  return openDb(dbPath).then(({ db }) => {
    const nodes = db.prepare('SELECT id, kind, title, body, attrs FROM nodes ORDER BY id').all();
    const edges = db.prepare('SELECT src, dst, kind FROM edges ORDER BY src, dst, kind').all();
    db.close();
    return { nodes, edges };
  });
}

// ── Source 1: answered questions ─────────────────────────────────────────────
test('projects a decision node + decided_in edge from an answered question', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-q-'));
  try {
    seedQuestion(forgeDir, 'P1-T01', 'a1', {
      question_id: 'q1',
      decision_key: 'cache-strategy',
      option_id: 'opt-a',
      answered_at: '2026-06-01T10:00:00.000Z',
      note: 'use redis',
      chosen_label: 'Redis cache',
    });
    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    assert.equal(res.decisionNodes.length, 1);
    const node = res.decisionNodes[0]!;
    assert.equal(node.kind, 'decision');
    assert.equal(node.title, 'cache-strategy');
    assert.ok(node.id.startsWith('decision:question:'));
    assert.equal(node.attrs!.source, 'question');
    assert.equal(node.attrs!.source_question_id, 'q1');
    assert.equal(node.attrs!.chosen, 'opt-a');
    assert.match(node.body, /Redis cache/);
    assert.match(node.body, /use redis/);
    assert.deepEqual(res.decidedInEdges, [{ src: node.id, dst: 'task:P1-T01', kind: 'decided_in' }]);
    assert.deepEqual(res.affectsEdges, []);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── Source 2: autonomous decisions ───────────────────────────────────────────
test('projects a decision node from an autonomous_decision event', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-auto-'));
  try {
    seedEvents(forgeDir, 'P1-T01', 'a1', [
      { type: 'autonomous_decision', ts: '2026-06-01T11:00:00.000Z', decision_key: 'naming-convention', chosen_option_id: 'opt-x', reason: 'hard cap reached; chose recommendation' },
    ]);
    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    assert.equal(res.decisionNodes.length, 1);
    const node = res.decisionNodes[0]!;
    assert.equal(node.attrs!.source, 'autonomous');
    assert.equal(node.attrs!.source_question_id, null);
    assert.equal(node.attrs!.chosen, 'opt-x');
    assert.equal(res.decidedInEdges[0]!.dst, 'task:P1-T01');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── dedup (CRITICAL) ─────────────────────────────────────────────────────────
test('dedups the SAME decision_key answered in two attempts into ONE node (latest wins)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-dedup-'));
  try {
    // Same decision_key, two attempts, different chosen option + later timestamp.
    seedQuestion(forgeDir, 'P1-T01', 'a1', {
      question_id: 'q1', decision_key: 'db-engine', option_id: 'opt-a',
      answered_at: '2026-06-01T10:00:00.000Z',
    });
    seedQuestion(forgeDir, 'P1-T01', 'a2', {
      question_id: 'q2', decision_key: 'db-engine', option_id: 'opt-b',
      answered_at: '2026-06-02T10:00:00.000Z',
    });
    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    assert.equal(res.decisionNodes.length, 1, 'same (task, decision_key) → one node');
    const node = res.decisionNodes[0]!;
    // Latest answer wins.
    assert.equal(node.attrs!.chosen, 'opt-b');
    assert.equal(node.attrs!.source_question_id, 'q2');
    // Conflicting historical answers warned.
    assert.ok(res.warnings.some((w) => /conflicting/.test(w) && /db-engine/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── Source 3: ADR via completed apply-journal ────────────────────────────────
test('projects an ADR decision + affects edges from a completed apply-journal', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-adr-'));
  try {
    seedCompletedJournal(forgeDir, 'switch-to-grpc', ['P1-T01', 'P1-T02', 'P9-T99']);
    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    const adr = res.decisionNodes.find((n) => n.id === 'decision:adr:switch-to-grpc');
    assert.ok(adr, 'expected an ADR decision node');
    assert.equal(adr!.attrs!.source, 'adr');
    assert.equal(adr!.attrs!.slug, 'switch-to-grpc');
    // affects edges to the two known tasks; P9-T99 is unknown → skipped + warned.
    const dsts = res.affectsEdges.map((e) => e.dst).sort();
    assert.deepEqual(dsts, ['task:P1-T01', 'task:P1-T02']);
    assert.ok(res.affectsEdges.every((e) => e.kind === 'affects' && e.src === 'decision:adr:switch-to-grpc'));
    assert.ok(res.warnings.some((w) => /P9-T99/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── safety: symlinked + malformed files ──────────────────────────────────────
test('skips a symlinked answer file and a symlinked journal file (does not follow)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-symlink-'));
  try {
    // A legit decision so the walk continues past the symlink.
    seedQuestion(forgeDir, 'P1-T01', 'a1', {
      question_id: 'q1', decision_key: 'good', option_id: 'opt-a',
      answered_at: '2026-06-01T10:00:00.000Z',
    });
    // Symlinked answer file pointing at the good answer — must be skipped.
    const aDir = attemptDirOf(forgeDir, 'P1-T01', 'a1');
    const evil = join(forgeDir, 'evil-answer.json');
    writeFileSync(evil, JSON.stringify({ version: 1, question_id: 'q1', answered_at: '2026-06-03T10:00:00.000Z', option_id: 'opt-b' }));
    symlinkSync(evil, join(aDir, 'answers', 'sym.json'));
    // Symlinked journal.
    const cDir = join(forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal', 'completed');
    mkdirSync(cDir, { recursive: true });
    const evilJournal = join(forgeDir, 'evil-journal.json');
    writeFileSync(evilJournal, JSON.stringify({ version: 1, slug: 'evil', started_at: '2026-06-01T00:00:00.000Z' }));
    symlinkSync(evilJournal, join(cDir, 'sym.json'));

    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    // Only the one good decision; no ADR (the only journal is a symlink).
    assert.equal(res.decisionNodes.filter((n) => n.kind === 'decision').length, 1);
    assert.equal(res.decisionNodes[0]!.attrs!.decision_key, 'good');
    assert.ok(res.warnings.some((w) => /symlink/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('skips a symlinked answers/ DIRECTORY (does not follow a symlinked parent dir)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-symdir-ans-'));
  try {
    // A legit decision on a SECOND attempt so the walk has surviving output.
    seedQuestion(forgeDir, 'P1-T01', 'a2', {
      question_id: 'qok', decision_key: 'good', option_id: 'opt-a',
      answered_at: '2026-06-01T10:00:00.000Z',
    });
    // Decoy answers payload OUTSIDE the attempt tree; the in-tree answers/ dir is
    // a SYMLINK to it. A naive readdir would follow it and project the decoy.
    const aDir = attemptDirOf(forgeDir, 'P1-T01', 'a1');
    mkdirSync(aDir, { recursive: true });
    const decoy = join(forgeDir, 'decoy-answers');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, 'evil.json'),
      JSON.stringify({ version: 1, question_id: 'qx', answered_at: '2026-06-09T10:00:00.000Z', option_id: 'opt-b' }),
    );
    symlinkSync(decoy, join(aDir, 'answers'));

    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    // Only the good decision from a2 — the symlinked answers/ dir is skipped.
    assert.equal(res.decisionNodes.length, 1);
    assert.equal(res.decisionNodes[0]!.attrs!.decision_key, 'good');
    assert.ok(res.warnings.some((w) => /symlink/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('skips a symlinked completed/ JOURNAL DIRECTORY (does not follow a symlinked parent dir)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-symdir-journal-'));
  try {
    // Decoy journal payload outside the journal tree; the completed/ dir is a symlink.
    const decoy = join(forgeDir, 'decoy-completed');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, 'evil.json'),
      JSON.stringify({
        version: 1, slug: 'evil', started_at: '2026-06-01T00:00:00.000Z',
        spec_sections: [], prd_sections: [],
        phases_tasks: [{ id: 'P1-T01', field: 'description', value: 'x', status: 'applied' }],
        tracker_issues: [],
        finalize: { commit_msg_written: true, index_appended: true, adr_deleted: true, archived: true },
        completed_at: '2026-06-02T00:00:00.000Z',
      }),
    );
    const journalParent = join(forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal');
    mkdirSync(journalParent, { recursive: true });
    symlinkSync(decoy, join(journalParent, 'completed'));

    const res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    // No ADR node — the symlinked completed/ dir is skipped, not followed.
    assert.deepEqual(res.decisionNodes, []);
    assert.deepEqual(res.affectsEdges, []);
    assert.ok(res.warnings.some((w) => /symlink/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('warns + skips a malformed-JSON answer file, never throws', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-malformed-'));
  try {
    const aDir = attemptDirOf(forgeDir, 'P1-T01', 'a1');
    mkdirSync(join(aDir, 'answers'), { recursive: true });
    mkdirSync(join(aDir, 'questions'), { recursive: true });
    writeFileSync(join(aDir, 'answers', 'bad.json'), '{ not json');
    let res!: ReturnType<typeof projectDecisions>;
    assert.doesNotThrow(() => {
      res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    });
    assert.equal(res.decisionNodes.length, 0);
    assert.ok(res.warnings.some((w) => /not valid JSON/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('returns empty + no throw when there is no orchestrator dir', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'dec-empty-'));
  try {
    let res!: ReturnType<typeof projectDecisions>;
    assert.doesNotThrow(() => {
      res = projectDecisions({ forgeDir, repoRoot: forgeDir, resolveTaskNodeId: makeResolver() });
    });
    assert.deepEqual(res.decisionNodes, []);
    assert.deepEqual(res.decidedInEdges, []);
    assert.deepEqual(res.affectsEdges, []);
    assert.deepEqual(res.warnings, []);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── reindex integration: idempotency + status counts ─────────────────────────
test('reindex projects decisions, counts them, and is byte-identical across runs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dec-reindex-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), FIXTURE_PHASES);
  const forgeDir = join(repoRoot, '.forge');
  // answered question decided_in P1-T01; ADR affects both tasks (via tracker + phases ids).
  seedQuestion(forgeDir, 'P1-T01', 'a1', {
    question_id: 'q1', decision_key: 'cache-strategy', option_id: 'opt-a',
    answered_at: '2026-06-01T10:00:00.000Z',
  });
  seedEvents(forgeDir, 'P1-T02', 'a1', [
    { type: 'autonomous_decision', ts: '2026-06-01T11:00:00.000Z', decision_key: 'retry-policy', chosen_option_id: null, reason: 'cap reached' },
  ]);
  seedCompletedJournal(forgeDir, 'switch-to-grpc', ['P1-T01', 'P1-T02']);
  const dbPath = join(forgeDir, 'loom.db');

  try {
    const b1 = await openLocalBackend(dbPath);
    const r1 = await reindex({ repoRoot, backend: b1 });
    b1.close();
    const snap1 = await snapshot(dbPath);

    const b2 = await openLocalBackend(dbPath);
    const r2 = await reindex({ repoRoot, backend: b2 });
    const status = b2.status();
    b2.close();
    const snap2 = await snapshot(dbPath);

    assert.deepEqual(snap2, snap1, 'graph incl. decisions must be identical across runs');
    // 1 question decision + 1 autonomous decision + 1 ADR = 3 decision nodes.
    assert.equal(r1.decision_nodes, 3);
    assert.equal(r2.decision_nodes, 3);
    // 2 decided_in edges (question + autonomous), 2 affects edges (ADR → both tasks).
    assert.equal(r1.decided_in_edges, 2);
    assert.equal(r1.affects_edges, 2);
    assert.equal(status.by_kind.decision, 3);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── recall: structural (decided_in + ancestor affects) AND FTS kind ──────────
test('recall surfaces a decision structurally (decided_in the task) and via a depends_on ancestor', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dec-recall-struct-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), FIXTURE_PHASES);
  const forgeDir = join(repoRoot, '.forge');
  // Decision decided_in the ancestor P1-T01; recall for P1-T02 (depends_on P1-T01)
  // must surface it via the depends_on scope.
  seedQuestion(forgeDir, 'P1-T01', 'a1', {
    question_id: 'q1', decision_key: 'ancestor-decision', option_id: 'opt-a',
    answered_at: '2026-06-01T10:00:00.000Z',
  });
  // A decision decided_in P1-T02 directly too.
  seedEvents(forgeDir, 'P1-T02', 'a1', [
    { type: 'autonomous_decision', ts: '2026-06-01T11:00:00.000Z', decision_key: 'direct-decision', chosen_option_id: 'opt-y', reason: 'cap' },
  ]);
  const dbPath = join(forgeDir, 'loom.db');
  try {
    const b = await openLocalBackend(dbPath);
    await reindex({ repoRoot, backend: b });
    const hits = b.recallForTask('P1-T02');
    b.close();
    const decisionHits = hits.filter((h) => h.kind === 'decision');
    assert.equal(decisionHits.length, 2, `expected 2 decision hits, got ${JSON.stringify(hits)}`);
    assert.ok(decisionHits.every((h) => h.source === 'structural' && h.score === 1000));
    // One is decided in the task directly, one via the depends_on ancestor.
    assert.ok(decisionHits.some((h) => /decided in P1-T02/.test(h.why)));
    assert.ok(decisionHits.some((h) => /depends_on ancestor P1-T01/.test(h.why)));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('recall surfaces an applied-ADR decision for a phases task it AFFECTS (affects edge)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dec-recall-affects-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), FIXTURE_PHASES);
  const forgeDir = join(repoRoot, '.forge');
  // An applied ADR that affects P1-T02 (and P1-T01). Recall for P1-T02 must
  // surface the ADR decision structurally via its affects edge — there is NO
  // decided_in edge and no FTS overlap, so only the affects edge can produce it.
  seedCompletedJournal(forgeDir, 'switch-to-grpc', ['P1-T01', 'P1-T02']);
  const dbPath = join(forgeDir, 'loom.db');
  try {
    const b = await openLocalBackend(dbPath);
    await reindex({ repoRoot, backend: b });
    const hits = b.recallForTask('P1-T02');
    b.close();
    const adrHit = hits.find((h) => h.id === 'decision:adr:switch-to-grpc');
    assert.ok(adrHit, `expected the affects-ADR decision hit, got ${JSON.stringify(hits)}`);
    assert.equal(adrHit!.kind, 'decision');
    assert.equal(adrHit!.source, 'structural');
    assert.equal(adrHit!.score, 1000);
    assert.match(adrHit!.why, /affects/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('recall returns a decision FTS hit with kind=decision, ranked below structural', async () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'dec-recall-fts-'));
  const dbPath = join(dbDir, 'loom.db');
  try {
    const backend = await openLocalBackend(dbPath);
    // Task A's title has a rare word; a decision body shares that word → FTS hit.
    // The decision has NO edge to A, so it can ONLY appear via FTS.
    backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Quasar pipeline', body: 'build the quasar pipeline' },
      { id: 'decision:question:abc', kind: 'decision', title: 'pipeline-choice', body: 'we chose the quasar approach', attrs: { source: 'question' } },
      // A structural decision (edge to A) to prove ordering: structural > fts.
      { id: 'decision:question:def', kind: 'decision', title: 'struct-choice', body: 'unrelated prose', attrs: { source: 'question' } },
    ]);
    backend.upsertEdges([{ src: 'decision:question:def', dst: 'task:A', kind: 'decided_in' }]);
    const hits = backend.recallForTask('A');
    backend.close();
    const fts = hits.find((h) => h.id === 'decision:question:abc');
    assert.ok(fts, `expected the FTS decision hit, got ${JSON.stringify(hits)}`);
    assert.equal(fts!.kind, 'decision', 'FTS decision hit must carry kind=decision, not task');
    assert.equal(fts!.source, 'fts');
    const struct = hits.find((h) => h.id === 'decision:question:def');
    assert.ok(struct);
    assert.equal(struct!.source, 'structural');
    assert.ok(struct!.score > fts!.score, 'structural decision must outrank the fts decision');
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});
