import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOOM_VERBS } from '../../../src/cli/registry.ts';
import { LOOM_VERB_NAMES } from '../../../src/cli/loom/index.ts';

test('LOOM_VERBS: every entry has a lowercase name and a meaningful summary', () => {
  for (const v of LOOM_VERBS) {
    assert.equal(v.name, v.name.toLowerCase(), `verb name must be lowercase: ${v.name}`);
    assert.ok(v.summary.length > 15, `loom verb ${v.name} summary too thin (${v.summary.length} chars)`);
  }
});

test('LOOM_VERBS: names are unique', () => {
  const names = LOOM_VERBS.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'loom verb names must be unique');
});

test('conformance: every dispatchLoom verb has a LOOM_VERBS entry', () => {
  const listed = new Set(LOOM_VERBS.map((v) => v.name));
  for (const name of LOOM_VERB_NAMES) {
    assert.ok(listed.has(name), `LOOM_VERBS missing dispatch verb "${name}"`);
  }
});

test('conformance: every LOOM_VERBS entry is a real dispatch verb', () => {
  const dispatched = new Set<string>(LOOM_VERB_NAMES);
  for (const v of LOOM_VERBS) {
    assert.ok(dispatched.has(v.name), `LOOM_VERBS lists "${v.name}" but dispatchLoom has no such verb`);
  }
});
