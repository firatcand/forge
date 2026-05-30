import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  replaceManagedSection,
  parseSectionRef,
  slugifyHeading,
  markerStart,
  markerEnd,
} from '../../../src/orchestrator/markdown-section.ts';
import { ApplyError } from '../../../src/core/errors.ts';

const DOC = `# Title

intro

## CLI surface

old surface text
more old

## Next section

untouched
`;

test('parseSectionRef handles #anchor and §Heading forms', () => {
  assert.deepEqual(parseSectionRef('spec/SPEC.md#cli-surface'), { file: 'spec/SPEC.md', anchor: 'cli-surface' });
  assert.deepEqual(parseSectionRef('spec/SPEC.md §CLI surface'), { file: 'spec/SPEC.md', anchor: 'cli-surface' });
});

test('slugifyHeading matches GitHub-style anchors', () => {
  assert.equal(slugifyHeading('CLI surface'), 'cli-surface');
  assert.equal(slugifyHeading('§21 Amendments!'), '21-amendments');
});

test('first touch wraps the heading section in markers and replaces content', () => {
  const out = replaceManagedSection(DOC, 'cli-surface', '## CLI surface\n\nbrand new');
  assert.ok(out.includes(markerStart('cli-surface')));
  assert.ok(out.includes(markerEnd('cli-surface')));
  assert.ok(out.includes('brand new'));
  assert.ok(!out.includes('old surface text'));
  // Adjacent section untouched
  assert.ok(out.includes('## Next section'));
  assert.ok(out.includes('untouched'));
  // Heading before the managed section is preserved
  assert.ok(out.includes('# Title'));
  assert.ok(out.includes('intro'));
});

test('second apply replaces between existing markers (idempotent shape)', () => {
  const once = replaceManagedSection(DOC, 'cli-surface', '## CLI surface\n\nv1');
  const twice = replaceManagedSection(once, 'cli-surface', '## CLI surface\n\nv2');
  // Exactly one marker pair — no nesting/duplication
  assert.equal(twice.split(markerStart('cli-surface')).length - 1, 1);
  assert.equal(twice.split(markerEnd('cli-surface')).length - 1, 1);
  assert.ok(twice.includes('v2'));
  assert.ok(!twice.includes('v1'));
});

test('re-applying identical content is a true no-op (crash-then-resume safety)', () => {
  const once = replaceManagedSection(DOC, 'cli-surface', '## CLI surface\n\nstable');
  const again = replaceManagedSection(once, 'cli-surface', '## CLI surface\n\nstable');
  assert.equal(again, once);
});

test('heading not found throws SECTION_NOT_FOUND', () => {
  assert.throws(
    () => replaceManagedSection(DOC, 'does-not-exist', 'x'),
    (e) => e instanceof ApplyError && e.code === 'SECTION_NOT_FOUND',
  );
});

test('section span stops at the next equal-or-higher-level heading', () => {
  const doc = `## A

a body

### A sub

sub body

## B

b body
`;
  const out = replaceManagedSection(doc, 'a', '## A\n\nnew a');
  // The ### A sub belongs to A's span and is replaced away; B is preserved.
  assert.ok(out.includes('new a'));
  assert.ok(!out.includes('sub body'));
  assert.ok(out.includes('## B'));
  assert.ok(out.includes('b body'));
});

test('half-present markers are treated as corrupt', () => {
  const corrupt = `${markerStart('cli-surface')}\n## CLI surface\nx\n`;
  assert.throws(
    () => replaceManagedSection(corrupt, 'cli-surface', 'y'),
    (e) => e instanceof ApplyError && e.code === 'SECTION_NOT_FOUND',
  );
});
