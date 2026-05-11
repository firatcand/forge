import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadSettings,
  loadSettingsIfChanged,
  __resetSettingsCacheForTests,
} from '../../../src/core/settings.ts';
import { SettingsError } from '../../../src/core/errors.ts';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'fixtures', 'settings');
const COMPLETE = join(FIXTURES, 'complete.yaml');
const MINIMAL = join(FIXTURES, 'minimal.yaml');
const COLLISION = join(FIXTURES, 'invalid-host-cli-collision.yaml');
const WRONG_SHAPE = join(FIXTURES, 'wrong-shape.yaml');
const NOT_YAML = join(FIXTURES, 'not-valid-yaml.txt');

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-FD9-'));
}

function bumpMtime(filePath: string, deltaSeconds: number): void {
  const st = statSync(filePath);
  const next = new Date(st.mtimeMs + deltaSeconds * 1000);
  utimesSync(filePath, next, next);
}

const VALID_YAML = [
  'version: 1',
  'project:',
  '  name: forge-tmp',
  'tracker:',
  '  type: github',
  '  config:',
  '    repo: firatcand/forge',
  'secrets:',
  '  manager: env_file',
  '',
].join('\n');

const VALID_YAML_V2 = [
  'version: 1',
  'project:',
  '  name: forge-tmp-v2',
  'tracker:',
  '  type: github',
  '  config:',
  '    repo: firatcand/forge',
  'secrets:',
  '  manager: env_file',
  '',
].join('\n');

const BROKEN_YAML = ':: not yaml :\n  -- :: nope\n';

// AC1 — loadSettings returns parsed Settings for a valid file

test('AC1 — loadSettings parses complete.yaml into Settings', () => {
  __resetSettingsCacheForTests();
  const s = loadSettings(COMPLETE);
  assert.equal(s.version, 1);
  assert.equal(s.project.name, 'forge-example');
  assert.equal(s.tracker.type, 'linear');
  if (s.tracker.type === 'linear') {
    assert.equal(s.tracker.config.team_id, 'TEAM-123');
  }
  assert.equal(s.agents.primary_host_cli, 'claude');
  assert.equal(s.agents.review_host_cli, 'codex');
  assert.equal(s.design.mode, 'reference_external');
  assert.equal(s.design.reference, 'https://figma.com/file/abc');
});

test('AC1 — loadSettings expands defaults on minimal.yaml', () => {
  __resetSettingsCacheForTests();
  const s = loadSettings(MINIMAL);
  assert.equal(s.agents.max_concurrent, 10);
  assert.equal(s.agents.retry_attempts, 10);
  assert.equal(s.agents.poll_interval_ms, 30_000);
  assert.equal(s.agents.primary_host_cli, 'claude');
  assert.equal(s.agents.review_host_cli, 'codex');
  assert.equal(s.design.mode, 'project_owned');
  assert.equal(s.design.reference, undefined);
});

// AC2 — validation errors throw SettingsError with code+issues

test('AC2 — invalid schema throws SettingsError with code=VALIDATION_ERROR and ZodIssue[]', () => {
  __resetSettingsCacheForTests();
  try {
    loadSettings(COLLISION);
    assert.fail('expected loadSettings to throw');
  } catch (err) {
    assert.ok(err instanceof SettingsError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    const issues = err.details.issues as Array<{ message: string; path: ReadonlyArray<unknown> }>;
    assert.ok(Array.isArray(issues));
    assert.ok(issues.length > 0);
    const collision = issues.find((i) => i.message.includes('review_host_cli must differ from primary_host_cli'));
    assert.ok(collision, 'expected host-CLI collision issue');
    for (const issue of issues) {
      assert.equal(typeof issue.message, 'string');
      assert.ok(Array.isArray(issue.path));
    }
  }
});

test('AC2 — wrong shape (missing project) throws VALIDATION_ERROR', () => {
  __resetSettingsCacheForTests();
  try {
    loadSettings(WRONG_SHAPE);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof SettingsError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    const issues = err.details.issues as Array<{ path: ReadonlyArray<unknown> }>;
    assert.ok(issues.some((i) => i.path[0] === 'project'));
  }
});

test('AC2 — missing file throws FILE_NOT_FOUND', () => {
  __resetSettingsCacheForTests();
  const missing = join(FIXTURES, 'does-not-exist.yaml');
  try {
    loadSettings(missing);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof SettingsError);
    assert.equal(err.code, 'FILE_NOT_FOUND');
    assert.equal(err.details.path, resolve(missing));
  }
});

test('AC2 — invalid YAML throws YAML_PARSE_ERROR with cause string', () => {
  __resetSettingsCacheForTests();
  try {
    loadSettings(NOT_YAML);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof SettingsError);
    assert.equal(err.code, 'YAML_PARSE_ERROR');
    assert.equal(typeof err.details.cause, 'string');
    assert.equal(err.details.path, resolve(NOT_YAML));
  }
});

// AC3 — loadSettingsIfChanged behavior

test('AC3 — first call returns Settings, second call returns null', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    const first = loadSettingsIfChanged(f);
    assert.ok(first);
    assert.equal(first.project.name, 'forge-tmp');
    const second = loadSettingsIfChanged(f);
    assert.equal(second, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('AC3 — after file modified (mtime bumped) returns fresh Settings', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    const first = loadSettingsIfChanged(f);
    assert.ok(first);
    assert.equal(first.project.name, 'forge-tmp');
    writeFileSync(f, VALID_YAML_V2, 'utf8');
    bumpMtime(f, 5);
    const second = loadSettingsIfChanged(f);
    assert.ok(second);
    assert.equal(second.project.name, 'forge-tmp-v2');
    const third = loadSettingsIfChanged(f);
    assert.equal(third, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('AC3 — loadSettingsIfChanged on missing file throws FILE_NOT_FOUND', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'never-existed.yaml');
  try {
    try {
      loadSettingsIfChanged(f);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof SettingsError);
      assert.equal(err.code, 'FILE_NOT_FOUND');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('AC3 regression — parse failure on reload leaves cache untouched; next valid edit returns fresh data', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    const first = loadSettingsIfChanged(f);
    assert.ok(first);
    assert.equal(first.project.name, 'forge-tmp');

    writeFileSync(f, BROKEN_YAML, 'utf8');
    bumpMtime(f, 5);
    let threw = false;
    try {
      loadSettingsIfChanged(f);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof SettingsError);
      assert.equal(err.code, 'YAML_PARSE_ERROR');
    }
    assert.equal(threw, true);

    writeFileSync(f, VALID_YAML_V2, 'utf8');
    bumpMtime(f, 10);
    const third = loadSettingsIfChanged(f);
    assert.ok(third);
    assert.equal(third.project.name, 'forge-tmp-v2');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('AC3 regression — schema failure on reload leaves cache untouched', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    const first = loadSettingsIfChanged(f);
    assert.ok(first);

    writeFileSync(f, 'version: 1\n', 'utf8');
    bumpMtime(f, 5);
    let threw = false;
    try {
      loadSettingsIfChanged(f);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof SettingsError);
      assert.equal(err.code, 'VALIDATION_ERROR');
    }
    assert.equal(threw, true);

    writeFileSync(f, VALID_YAML_V2, 'utf8');
    bumpMtime(f, 10);
    const third = loadSettingsIfChanged(f);
    assert.ok(third);
    assert.equal(third.project.name, 'forge-tmp-v2');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

// AC4 — schema violation surfaces raw ZodIssue[] structure

test('AC4 — VALIDATION_ERROR issues are raw ZodIssue objects (path + code + message preserved)', () => {
  __resetSettingsCacheForTests();
  try {
    loadSettings(COLLISION);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof SettingsError);
    const issues = err.details.issues as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(issues));
    for (const issue of issues) {
      assert.equal(typeof issue.message, 'string');
      assert.equal(typeof issue.code, 'string');
      assert.ok(Array.isArray(issue.path));
    }
  }
});

// Regression — loadSettings does NOT poison or read the cache

test('regression — loadSettings does not populate the cache (next loadSettingsIfChanged still returns Settings)', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    const direct = loadSettings(f);
    assert.equal(direct.project.name, 'forge-tmp');
    const first = loadSettingsIfChanged(f);
    assert.ok(first, 'cache must be cold after loadSettings');
    assert.equal(first.project.name, 'forge-tmp');
    const second = loadSettingsIfChanged(f);
    assert.equal(second, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('regression — two distinct paths tracked independently in the cache', () => {
  __resetSettingsCacheForTests();
  const tmpA = makeTmpDir();
  const tmpB = makeTmpDir();
  const a = join(tmpA, 'a.yaml');
  const b = join(tmpB, 'b.yaml');
  writeFileSync(a, VALID_YAML, 'utf8');
  writeFileSync(b, VALID_YAML_V2, 'utf8');
  try {
    const a1 = loadSettingsIfChanged(a);
    const b1 = loadSettingsIfChanged(b);
    assert.ok(a1);
    assert.ok(b1);
    assert.equal(a1.project.name, 'forge-tmp');
    assert.equal(b1.project.name, 'forge-tmp-v2');
    assert.equal(loadSettingsIfChanged(a), null);
    assert.equal(loadSettingsIfChanged(b), null);
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});

test('regression — __resetSettingsCacheForTests clears state', () => {
  __resetSettingsCacheForTests();
  const tmp = makeTmpDir();
  const f = join(tmp, 'settings.yaml');
  writeFileSync(f, VALID_YAML, 'utf8');
  try {
    assert.ok(loadSettingsIfChanged(f));
    assert.equal(loadSettingsIfChanged(f), null);
    __resetSettingsCacheForTests();
    assert.ok(loadSettingsIfChanged(f));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    __resetSettingsCacheForTests();
  }
});
