import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexSuggest, __TEST_ONLY } from '../../../src/cli/codex-suggest.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-codex-suggest-'));
}

function capture(): {
  stdout: { write: (s: string) => boolean; buf: string };
  stderr: { write: (s: string) => boolean; buf: string };
} {
  const stdout = {
    buf: '',
    write(s: string): boolean {
      this.buf += s;
      return true;
    },
  };
  const stderr = {
    buf: '',
    write(s: string): boolean {
      this.buf += s;
      return true;
    },
  };
  return { stdout, stderr };
}

function writeSettings(cwd: string, codex: { auto_codex_enabled?: boolean; auto_codex_token_cap?: number } | null): void {
  const dir = join(cwd, '.forge');
  mkdirSync(dir, { recursive: true });
  const codexYaml =
    codex === null
      ? ''
      : `\ncodex:\n  auto_codex_enabled: ${codex.auto_codex_enabled ?? true}\n  auto_codex_token_cap: ${codex.auto_codex_token_cap ?? 50000}\n`;
  const yaml = `version: 1
project:
  name: test-codex-suggest
tracker:
  type: linear
  config:
    team_id: T
secrets:
  manager: env_file
${codexYaml}`;
  writeFileSync(join(dir, 'settings.yaml'), yaml, 'utf8');
}

test('FORGE-105 — FORGE_AUTO_CODEX=0 silences output', () => {
  const cwd = tmp();
  writeSettings(cwd, { auto_codex_enabled: true });
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: '0' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
  assert.equal(stderr.buf, '');
});

test('FORGE-105 — FORGE_AUTO_CODEX=false silences output', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: 'false' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-105 — FORGE_AUTO_CODEX=no silences output', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: 'no' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-105 — no settings.yaml uses defaults and prints suggestion', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.match(stdout.buf, /\/codex review-plan/);
  assert.match(stdout.buf, /FORGE_AUTO_CODEX=0 to disable/);
});

test('FORGE-105 — settings auto_codex_enabled: true prints suggestion', () => {
  const cwd = tmp();
  writeSettings(cwd, { auto_codex_enabled: true });
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.match(stdout.buf, /\/codex review-plan/);
});

test('FORGE-105 — settings auto_codex_enabled: false silences output', () => {
  const cwd = tmp();
  writeSettings(cwd, { auto_codex_enabled: false });
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-105 — event plan-task maps to /codex review-plan', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/codex review-plan/);
});

test('FORGE-105 — event ship maps to /codex review-impl', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({ cwd, argv: ['ship'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/codex review-impl/);
});

test('FORGE-105 — event update-spec maps to /codex review-decision (reserved)', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({ cwd, argv: ['update-spec'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/codex review-decision/);
});

test('FORGE-105 — unknown event exits 1 and writes stderr', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['bogus'],
    env: {},
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(stdout.buf, '');
  assert.match(stderr.buf, /unknown event 'bogus'/);
});

test('FORGE-105 — missing event arg exits 1 with usage', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: [],
    env: {},
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(stdout.buf, '');
  assert.match(stderr.buf, /missing event arg/);
  assert.match(stderr.buf, /usage: forge codex-suggest/);
});

test('FORGE-105 — malformed settings.yaml falls back to defaults with stderr warning', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  writeFileSync(join(cwd, '.forge', 'settings.yaml'), 'this: is: not: valid yaml:::\n', 'utf8');
  const { stdout, stderr } = capture();
  const result = runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr,
  });
  // Never crashes the parent skill — exit 0, fall back to defaults.
  assert.equal(result.exitCode, 0);
  assert.match(stdout.buf, /\/codex review-plan/);
  assert.match(stderr.buf, /could not be parsed/);
});

test('FORGE-105 — EVENT_TO_VERB locked vocabulary surface', () => {
  // Compile-time + runtime guarantee that the event vocabulary matches SPEC.
  // If this set changes, SPEC §Auto-codex skill-level hooks must change too.
  assert.deepEqual(__TEST_ONLY.KNOWN_EVENTS, ['plan-task', 'ship', 'update-spec']);
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['plan-task'], 'review-plan');
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['ship'], 'review-impl');
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['update-spec'], 'review-decision');
});

test('FORGE-105 — FORGE_AUTO_CODEX=1 leaves default behavior (suggestion fires)', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: '1' },
    stdout,
    stderr: capture().stderr,
  });
  assert.match(stdout.buf, /\/codex review-plan/);
});

// Codex F1 (confidence 8): GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR env vars
// can redirect `git rev-parse --git-common-dir` to an attacker-chosen repo.
// codex-suggest sanitizes the env before invoking git so resolution stays
// anchored on cwd. This test plants a poisoned GIT_DIR pointing at a tmp
// directory whose `.forge/settings.yaml` would disable codex-suggest; if
// the sanitization works, the suggestion still fires (cwd has no settings
// and falls through to defaults).
test('FORGE-105 — GIT_DIR/GIT_WORK_TREE env cannot redirect settings discovery', () => {
  // Set up an attacker-controlled "settings" dir with auto_codex_enabled: false
  const attackerRoot = tmp();
  writeSettings(attackerRoot, { auto_codex_enabled: false });
  // The victim cwd is a fresh tmp dir with no .forge/settings.yaml
  const victimCwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({
    cwd: victimCwd,
    argv: ['plan-task'],
    env: {
      // Poisoned env that an unsanitized git invocation would honor.
      GIT_DIR: `${attackerRoot}/.git`,
      GIT_WORK_TREE: attackerRoot,
      GIT_COMMON_DIR: `${attackerRoot}/.git`,
    },
    stdout,
    stderr: capture().stderr,
  });
  // Sanitization works → git resolves to cwd's parent tree (or null) → no
  // attacker settings consumed → defaults expand → suggestion fires.
  assert.match(stdout.buf, /\/codex review-plan/);
});
