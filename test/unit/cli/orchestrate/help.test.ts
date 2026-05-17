import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERBS, HELP_ORDER, type VerbHandler } from '../../../../src/cli/orchestrate/index.ts';

// Spec §Verb classification table (rewritten 2026-05-17, simplified) — this
// list is intentionally embedded as test data so a SPEC edit forces a code
// review here. If you intentionally re-band a verb, update this table and the
// SPEC together.
//
// claim/dispatch/heartbeat/question/event/complete/cancel are not yet in the
// registry — Steps 4+5 add them. Until then, this test asserts what is
// currently registered AND the classification stays correct.
const EXPECTED_BANDS: ReadonlyArray<readonly [string, 'read' | 'mutate']> = [
  ['phases', 'read'],
  ['status', 'read'],
  ['questions', 'read'],
  ['doctor', 'read'],
  ['attach', 'read'],
  ['spec-diff', 'read'],
  ['answer', 'mutate'],
  ['gc', 'mutate'],
];

test('every expected verb is registered with the correct band', () => {
  for (const [name, band] of EXPECTED_BANDS) {
    const entry = VERBS.get(name);
    assert.ok(entry, `verb '${name}' should be registered`);
    assert.ok(!(entry instanceof Map), `verb '${name}' should be a leaf, not nested`);
    const handler = entry as VerbHandler;
    assert.equal(handler.band, band, `verb '${name}' should be ${band}`);
  }
});

test('the run sub-tree contains both start (mutate) and list (read)', () => {
  const run = VERBS.get('run');
  assert.ok(run instanceof Map, "'run' should be a nested verb");
  const sub = run as Map<string, VerbHandler>;
  assert.ok(sub.get('start'), 'run start should exist');
  assert.ok(sub.get('list'), 'run list should exist');
  assert.equal(sub.get('start')?.band, 'mutate');
  assert.equal(sub.get('list')?.band, 'read');
});

test('HELP_ORDER contains every registered top-level verb', () => {
  for (const name of VERBS.keys()) {
    assert.ok(HELP_ORDER.includes(name), `HELP_ORDER missing '${name}'`);
  }
});

test('no verb name collides with --help or other reserved tokens', () => {
  for (const name of VERBS.keys()) {
    assert.ok(!name.startsWith('--'), `verb name should not start with --: ${name}`);
    assert.ok(name !== '-h', 'verb name should not be -h');
  }
});
