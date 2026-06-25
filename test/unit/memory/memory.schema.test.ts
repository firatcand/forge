import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryNodeSchema,
  MemoryEdgeSchema,
  RecallHitSchema,
  NODE_KINDS,
  EDGE_KINDS,
} from '../../../src/schemas/memory.ts';

test('MemoryNodeSchema accepts a valid task node with attrs', () => {
  const r = MemoryNodeSchema.safeParse({
    id: 'task:P2.5-T01',
    kind: 'task',
    title: 'Some task',
    body: 'description body',
    attrs: { tracker_issue_id: 'FORGE-200', write_globs: ['src/**'] },
  });
  assert.equal(r.success, true);
});

test('MemoryNodeSchema accepts a learning node without attrs and empty body', () => {
  const r = MemoryNodeSchema.safeParse({
    id: 'learning:docs/learnings/x.md',
    kind: 'learning',
    title: 'A learning',
    body: '',
  });
  assert.equal(r.success, true);
});

test('MemoryNodeSchema rejects an unknown kind', () => {
  const r = MemoryNodeSchema.safeParse({ id: 'x', kind: 'not-a-real-kind', title: 't', body: 'b' });
  assert.equal(r.success, false);
});

test('MemoryNodeSchema rejects unexpected keys (.strict)', () => {
  const r = MemoryNodeSchema.safeParse({
    id: 'task:a',
    kind: 'task',
    title: 't',
    body: 'b',
    surprise: 1,
  });
  assert.equal(r.success, false);
});

test('MemoryNodeSchema rejects an over-long title', () => {
  const r = MemoryNodeSchema.safeParse({
    id: 'task:a',
    kind: 'task',
    title: 'x'.repeat(513),
    body: 'b',
  });
  assert.equal(r.success, false);
});

test('MemoryNodeSchema rejects an over-long id and empty id', () => {
  assert.equal(
    MemoryNodeSchema.safeParse({ id: 'x'.repeat(257), kind: 'task', title: 't', body: 'b' }).success,
    false,
  );
  assert.equal(
    MemoryNodeSchema.safeParse({ id: '', kind: 'task', title: 't', body: 'b' }).success,
    false,
  );
});

test('MemoryEdgeSchema accepts valid edges and rejects unknown kind', () => {
  assert.equal(
    MemoryEdgeSchema.safeParse({ src: 'task:a', dst: 'task:b', kind: 'depends_on' }).success,
    true,
  );
  assert.equal(
    MemoryEdgeSchema.safeParse({ src: 'l:1', dst: 'task:a', kind: 'learned_from' }).success,
    true,
  );
  // FORGE-218: `touches` is now a valid edge kind (was rejected in I1).
  assert.equal(
    MemoryEdgeSchema.safeParse({ src: 'task:a', dst: 'file:src/x.ts', kind: 'touches' }).success,
    true,
  );
  // A still-unknown kind is rejected.
  assert.equal(
    MemoryEdgeSchema.safeParse({ src: 'a', dst: 'b', kind: 'decision' }).success,
    false,
  );
});

test('MemoryNodeSchema accepts a file node with empty body (FORGE-218)', () => {
  const r = MemoryNodeSchema.safeParse({
    id: 'file:src/a/x.ts',
    kind: 'file',
    title: 'src/a/x.ts',
    body: '',
  });
  assert.equal(r.success, true);
});

test('RecallHitSchema accepts both sources and rejects an unknown source', () => {
  assert.equal(
    RecallHitSchema.safeParse({
      id: 'learning:x',
      kind: 'learning',
      title: 't',
      score: 1000,
      why: 'linked',
      source: 'structural',
    }).success,
    true,
  );
  assert.equal(
    RecallHitSchema.safeParse({
      id: 'task:x',
      kind: 'task',
      title: 't',
      score: 1,
      why: 'fts',
      source: 'guess',
    }).success,
    false,
  );
});

test('node/edge kind constants include the I2a + I2b-1 + I3 additions (FORGE-218/219/226)', () => {
  // I1 shipped task/learning + depends_on/learned_from; I2a adds file + touches;
  // I2b-1 (FORGE-219) adds symbol + defines; I3 (FORGE-226) adds decision +
  // decided_in/affects.
  assert.deepEqual([...NODE_KINDS], ['task', 'learning', 'file', 'symbol', 'decision']);
  assert.deepEqual([...EDGE_KINDS], [
    'depends_on',
    'learned_from',
    'touches',
    'defines',
    'decided_in',
    'affects',
  ]);
});

test('MemoryNodeSchema accepts a symbol node + defines edge (FORGE-219)', () => {
  assert.ok(
    MemoryNodeSchema.safeParse({
      id: 'symbol:' + 'a'.repeat(64),
      kind: 'symbol',
      title: 'hello',
      body: '',
      attrs: { file: 'src/a.py', name: 'hello', kind: 'function', start_line: '1', end_line: '2' },
    }).success,
  );
  assert.ok(
    MemoryEdgeSchema.safeParse({ src: 'file:src/a.py', dst: 'symbol:x', kind: 'defines' }).success,
  );
});
