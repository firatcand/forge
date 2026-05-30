import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveAdrPath,
  parseAdr,
  assertAccepted,
  extractRationale,
  deleteAdr,
  DECISIONS_DIR,
} from '../../../src/orchestrator/adr.ts';
import { ApplyError } from '../../../src/core/errors.ts';

function repoWithAdr(name: string, contents: string): { repoRoot: string; path: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-adr-'));
  const dir = join(repoRoot, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return { repoRoot, path };
}

const ACCEPTED_ADR = `---
slug: switch-tracker-transport
date: 2026-05-30
status: accepted
affected_spec_sections:
  - "spec/SPEC.md §CLI surface"
affected_phases_tasks:
  - P2.5-T04
---

# Switch tracker transport

## Context
The MCP transport is heavy.

## Decision
Use the ntn CLI.
`;

test('resolveAdrPath finds the file by -<slug>.md suffix', () => {
  const { repoRoot, path } = repoWithAdr('2026-05-30-switch-tracker-transport.md', ACCEPTED_ADR);
  assert.equal(resolveAdrPath(repoRoot, 'switch-tracker-transport'), path);
});

test('resolveAdrPath throws ADR_NOT_FOUND when nothing matches', () => {
  const { repoRoot } = repoWithAdr('2026-05-30-other.md', ACCEPTED_ADR);
  assert.throws(() => resolveAdrPath(repoRoot, 'nope'), (e) => e instanceof ApplyError && e.code === 'ADR_NOT_FOUND');
});

test('resolveAdrPath throws ADR_AMBIGUOUS on multiple matches', () => {
  const { repoRoot } = repoWithAdr('2026-05-30-dup.md', ACCEPTED_ADR);
  writeFileSync(join(repoRoot, DECISIONS_DIR, '2026-05-29-dup.md'), ACCEPTED_ADR, 'utf8');
  assert.throws(() => resolveAdrPath(repoRoot, 'dup'), (e) => e instanceof ApplyError && e.code === 'ADR_AMBIGUOUS');
});

test('parseAdr extracts frontmatter + body', () => {
  const { path } = repoWithAdr('2026-05-30-switch-tracker-transport.md', ACCEPTED_ADR);
  const adr = parseAdr(path);
  assert.equal(adr.frontmatter.slug, 'switch-tracker-transport');
  assert.equal(adr.frontmatter.status, 'accepted');
  assert.deepEqual(adr.frontmatter.affected_phases_tasks, ['P2.5-T04']);
  assert.match(adr.body, /## Decision/);
  // defaulted empty arrays
  assert.deepEqual(adr.frontmatter.affected_prd_sections, []);
});

test('parseAdr throws ADR_PARSE_ERROR when frontmatter fence is missing', () => {
  const { path } = repoWithAdr('2026-05-30-nofm.md', '# No frontmatter\n\nbody\n');
  assert.throws(() => parseAdr(path), (e) => e instanceof ApplyError && e.code === 'ADR_PARSE_ERROR');
});

test('assertAccepted rejects a proposed ADR', () => {
  const proposed = ACCEPTED_ADR.replace('status: accepted', 'status: proposed');
  const { path } = repoWithAdr('2026-05-30-prop.md', proposed);
  assert.throws(() => assertAccepted(parseAdr(path)), (e) => e instanceof ApplyError && e.code === 'ADR_NOT_ACCEPTED');
});

test('assertAccepted passes an accepted ADR', () => {
  const { path } = repoWithAdr('2026-05-30-ok.md', ACCEPTED_ADR);
  assert.doesNotThrow(() => assertAccepted(parseAdr(path)));
});

test('extractRationale returns the ADR body', () => {
  const { path } = repoWithAdr('2026-05-30-r.md', ACCEPTED_ADR);
  const rationale = extractRationale(parseAdr(path));
  assert.match(rationale, /## Context/);
  assert.match(rationale, /## Decision/);
});

test('deleteAdr removes the file and is idempotent (ENOENT is success)', () => {
  const { path } = repoWithAdr('2026-05-30-del.md', ACCEPTED_ADR);
  deleteAdr(path);
  assert.equal(existsSync(path), false);
  assert.doesNotThrow(() => deleteAdr(path)); // second call: no-op
});
