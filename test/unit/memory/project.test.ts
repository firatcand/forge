// FORGE-218 (Loom I2a): unit tests for the event projector.
//
// Seeds a real on-disk orchestrator tree under a tmp forgeDir and asserts the
// projector turns `files_modified` events into file nodes + touches edges,
// safely (B2 path sanitize), tolerantly (B3 never-throw on a corrupt tree), and
// with the dangling-edge guard (an unknown task id emits no edge).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectEvents } from '../../../src/memory/project.ts';

// Write an events.jsonl under <forgeDir>/orchestrator/tasks/<task>/attempts/<aid>.
function seedEvents(
  forgeDir: string,
  taskId: string,
  attemptId: string,
  lines: string[],
): void {
  const dir = join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

function filesModifiedLine(files: string[]): string {
  return JSON.stringify({
    type: 'files_modified',
    ts: '2026-06-17T00:00:00.000Z',
    files,
  });
}

// Resolver that knows two task nodes: phases id P1-T01 (with tracker id FX-1)
// and P1-T02. Mirrors ingest's closure shape (phases id OR tracker id → node).
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

test('projector emits file nodes + touches edges for safe paths only', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-'));
  try {
    seedEvents(forgeDir, 'P1-T01', 'a1', [
      filesModifiedLine(['src/a/one.ts', 'src/a/two.ts']),
      // a malformed JSON line → tolerated (skipped) by readAttemptEvents.
      '{ this is not json',
      // unsafe paths: a `../` escape and a posix-absolute path → both skipped+warned.
      filesModifiedLine(['../escape.ts', '/etc/passwd']),
      // a duplicate safe path → deduped into a single file node + one edge.
      filesModifiedLine(['src/a/one.ts']),
    ]);

    const res = projectEvents({
      forgeDir,
      repoRoot: forgeDir,
      resolveTaskNodeId: makeResolver(),
    });

    const fileIds = res.fileNodes.map((n) => n.id).sort();
    assert.deepEqual(fileIds, ['file:src/a/one.ts', 'file:src/a/two.ts']);
    // File nodes have empty body and path title.
    for (const n of res.fileNodes) {
      assert.equal(n.kind, 'file');
      assert.equal(n.body, '');
      assert.equal(n.title, n.id.slice('file:'.length));
    }
    // One touches edge per (task, file) distinct pair.
    const edges = res.touchesEdges.map((e) => `${e.src}→${e.dst}`).sort();
    assert.deepEqual(edges, ['task:P1-T01→file:src/a/one.ts', 'task:P1-T01→file:src/a/two.ts']);
    assert.ok(res.touchesEdges.every((e) => e.kind === 'touches'));
    // Both unsafe paths warned.
    assert.ok(res.warnings.some((w) => /\.\.\/escape\.ts/.test(w) && /unsafe/.test(w)));
    assert.ok(res.warnings.some((w) => /\/etc\/passwd/.test(w) && /unsafe/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('projector resolves a tracker-id task dir to the phases node', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-trk-'));
  try {
    // The on-disk dir is the TRACKER id (FX-1) — must resolve to task:P1-T01.
    seedEvents(forgeDir, 'FX-1', 'a1', [filesModifiedLine(['src/a/x.ts'])]);
    const res = projectEvents({
      forgeDir,
      repoRoot: forgeDir,
      resolveTaskNodeId: makeResolver(),
    });
    assert.deepEqual(res.touchesEdges, [
      { src: 'task:P1-T01', dst: 'file:src/a/x.ts', kind: 'touches' },
    ]);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('projector skips an unknown task id with a warning (dangling-edge guard)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-dangle-'));
  try {
    // A valid dir name that matches NO task node → all its touches skipped.
    seedEvents(forgeDir, 'P9-T99', 'a1', [filesModifiedLine(['src/a/x.ts'])]);
    const res = projectEvents({
      forgeDir,
      repoRoot: forgeDir,
      resolveTaskNodeId: makeResolver(),
    });
    assert.deepEqual(res.fileNodes, []);
    assert.deepEqual(res.touchesEdges, []);
    assert.ok(res.warnings.some((w) => /P9-T99/.test(w) && /dangling-edge guard/.test(w)));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('projector tolerates a malformed task dir name (B3 never-throw)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-baddir-'));
  try {
    // A path-traversal-shaped dir name fails validateIdSegment. The resolver is
    // called first (returns null → dangling-skip) so it never reaches the throw,
    // but either branch must warn + skip, never throw.
    const badDir = join(forgeDir, 'orchestrator', 'tasks', '..evil');
    mkdirSync(badDir, { recursive: true });
    // Also seed one good task so we know the walk continued past the bad entry.
    seedEvents(forgeDir, 'P1-T01', 'a1', [filesModifiedLine(['src/a/ok.ts'])]);
    let res!: ReturnType<typeof projectEvents>;
    assert.doesNotThrow(() => {
      res = projectEvents({
        forgeDir,
        repoRoot: forgeDir,
        resolveTaskNodeId: makeResolver(),
      });
    });
    assert.deepEqual(res.fileNodes.map((n) => n.id), ['file:src/a/ok.ts']);
    assert.ok(res.warnings.length >= 1);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('projector tolerates attemptsDir() validation throw on a resolved-but-invalid dir name (B3)', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-baddir2-'));
  try {
    // Force the path PAST the dangling-guard: a resolver that maps the malformed
    // dir name to a real node id, so the walk reaches attemptsDir(forgeDir, name)
    // — which calls validateIdSegment and THROWS. The B3 guard must catch + warn.
    const badName = '..evil';
    mkdirSync(join(forgeDir, 'orchestrator', 'tasks', badName), { recursive: true });
    seedEvents(forgeDir, 'P1-T01', 'a1', [filesModifiedLine(['src/a/ok.ts'])]);
    let res!: ReturnType<typeof projectEvents>;
    assert.doesNotThrow(() => {
      res = projectEvents({
        forgeDir,
        repoRoot: forgeDir,
        // Resolve EVERYTHING to a node id (incl. the bad dir) so the bad dir
        // reaches attemptsDir()'s validation throw rather than the null skip.
        resolveTaskNodeId: (raw) => `task:${raw}`,
      });
    });
    // The good task still projected; the bad dir warned + skipped, no throw.
    assert.deepEqual(res.fileNodes.map((n) => n.id), ['file:src/a/ok.ts']);
    assert.ok(res.warnings.some((w) => /evil/.test(w)), 'expected a warning about the invalid dir name');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('projector returns empty + no throw when there is no orchestrator dir', () => {
  const forgeDir = mkdtempSync(join(tmpdir(), 'loom-proj-empty-'));
  try {
    let res!: ReturnType<typeof projectEvents>;
    assert.doesNotThrow(() => {
      res = projectEvents({
        forgeDir,
        repoRoot: forgeDir,
        resolveTaskNodeId: makeResolver(),
      });
    });
    assert.deepEqual(res.fileNodes, []);
    assert.deepEqual(res.touchesEdges, []);
    // Absent orchestrator/tasks is the common case → no warning.
    assert.deepEqual(res.warnings, []);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// FORGE-226 (security): a symlinked PARENT dir (orchestrator/tasks → external)
// must NOT let the projector ingest event logs from outside .forge. Reproduces
// the Codex round-2 finding; safeReaddir's realpath containment closes it.
test('projector refuses a symlinked orchestrator/tasks dir pointing outside .forge', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-proj-sym-'));
  try {
    const forgeDir = join(root, '.forge');
    mkdirSync(join(forgeDir, 'orchestrator'), { recursive: true });
    // External tree with a real attempt + events.jsonl that would project a leak.
    const ext = join(root, 'outside');
    const extAttempt = join(ext, 'P1-T01', 'attempts', 'a1');
    mkdirSync(extAttempt, { recursive: true });
    writeFileSync(join(extAttempt, 'events.jsonl'), filesModifiedLine(['src/leak.ts']) + '\n');
    // orchestrator/tasks → external dir.
    symlinkSync(ext, join(forgeDir, 'orchestrator', 'tasks'));

    const res = projectEvents({ forgeDir, repoRoot: root, resolveTaskNodeId: makeResolver() });

    // No external content projected.
    assert.deepEqual(res.fileNodes, []);
    assert.deepEqual(res.touchesEdges, []);
    // And it is surfaced, not silent.
    assert.ok(
      res.warnings.some((w) => /symlink/.test(w) && /orchestrator\/tasks/.test(w)),
      `expected a symlink warning, got: ${JSON.stringify(res.warnings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Belt-and-suspenders: even if the walk reached an external attempt dir,
// readAttemptEvents' own parent-containment refuses to read its events.jsonl.
test('projector does not ingest events through a symlinked attempts/<id> dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-proj-sym2-'));
  try {
    const forgeDir = join(root, '.forge');
    const taskDir = join(forgeDir, 'orchestrator', 'tasks', 'P1-T01');
    mkdirSync(taskDir, { recursive: true });
    const ext = join(root, 'outside-attempts');
    mkdirSync(join(ext, 'a1'), { recursive: true });
    writeFileSync(join(ext, 'a1', 'events.jsonl'), filesModifiedLine(['src/leak.ts']) + '\n');
    symlinkSync(ext, join(taskDir, 'attempts'));

    const res = projectEvents({ forgeDir, repoRoot: root, resolveTaskNodeId: makeResolver() });
    assert.deepEqual(res.fileNodes, []);
    assert.deepEqual(res.touchesEdges, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
