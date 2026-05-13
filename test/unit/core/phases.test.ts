import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { YAMLParseError } from 'yaml';

import { loadPhases, PhasesError } from '../../../src/core/index.ts';
import type { Phases } from '../../../src/core/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', '..', 'fixtures', 'phases');

function fixture(name: string): string {
  return resolve(fixturesDir, name);
}

function expectPhasesError(fn: () => unknown): PhasesError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PhasesError, `expected PhasesError, got ${(err as Error)?.constructor?.name}`);
    return err as PhasesError;
  }
  assert.fail('expected loadPhases to throw');
}

test('AC1: valid live snapshot returns parsed Phases', () => {
  const result: Phases = loadPhases(fixture('live-snapshot.yaml'));
  assert.equal(result.project, 'forge');
  assert.ok(result.phases.length >= 1);
  assert.equal(result.phases[0]!.id, 'phase-1');
});

test('AC1: valid minimal fixture returns Phases shape', () => {
  const result = loadPhases(fixture('valid-minimal.yaml'));
  assert.equal(result.project, 'minimal');
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0]!.tasks[0]!.id, 'P1-T01');
});

test('AC2: two-task cycle throws SCHEMA_INVALID with cycle issue', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-cycle.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(Array.isArray(issues));
  assert.ok(issues.some((i) => /cycle detected/.test(i.message)));
});

test('AC2: three-task cycle throws SCHEMA_INVALID with full path', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-cycle-three.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(issues.some((i) => /P1-T0\d -> P1-T0\d -> P1-T0\d -> P1-T0\d/.test(i.message)));
});

test('AC2: self-loop throws SCHEMA_INVALID with self-cycle message', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-self-loop.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(issues.some((i) => /P1-T01 -> P1-T01/.test(i.message)));
});

test('AC3: missing required owner_type throws SCHEMA_INVALID', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-missing-owner-type.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(issues.some((i) => i.path.includes('owner_type')));
});

test('AC3: duplicate phase id throws SCHEMA_INVALID with phases-index path', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-duplicate-phase-id.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(
    issues.some(
      (i) => /duplicate phase id/.test(i.message) && i.path.includes('phases') && i.path.includes(1),
    ),
  );
});

test('AC3: unknown depends_on target throws SCHEMA_INVALID', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-unknown-dep.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  const issues = err.details.issues as z.ZodIssue[];
  assert.ok(issues.some((i) => /depends_on references unknown task id/.test(i.message)));
});

test('missing file throws FILE_NOT_FOUND with absolute path', () => {
  const err = expectPhasesError(() => loadPhases(fixture('does-not-exist.yaml')));
  assert.equal(err.code, 'FILE_NOT_FOUND');
  assert.equal(typeof err.details.path, 'string');
  assert.ok(path.isAbsolute(err.details.path as string));
});

test('invalid YAML throws PARSE_ERROR with YAMLParseError cause', () => {
  const err = expectPhasesError(() => loadPhases(fixture('not-yaml.txt')));
  assert.equal(err.code, 'PARSE_ERROR');
  assert.ok(err.cause instanceof YAMLParseError);
  assert.ok(path.isAbsolute(err.details.path as string));
});

test('SCHEMA_INVALID preserves ZodError as cause', () => {
  const err = expectPhasesError(() => loadPhases(fixture('invalid-cycle.yaml')));
  assert.equal(err.code, 'SCHEMA_INVALID');
  assert.ok(err.cause instanceof z.ZodError);
});

test('no silent fallback: loader never returns on failure', () => {
  let returned: unknown = 'sentinel';
  try {
    returned = loadPhases(fixture('invalid-cycle.yaml'));
  } catch {
    returned = 'threw';
  }
  assert.equal(returned, 'threw');
});
