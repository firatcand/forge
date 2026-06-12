import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSecondOpinionSuggest,
  __TEST_ONLY,
} from '../../../src/cli/second-opinion-suggest.ts';
// FORGE-150: codex-suggest.ts is a back-compat re-export; assert it still
// resolves the renamed implementation.
import { runCodexSuggest } from '../../../src/cli/codex-suggest.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-second-opinion-suggest-'));
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

// Write settings with a chosen block shape. `block` = 'second_opinion' writes
// the primary block; 'codex' writes only the legacy block; 'both' writes both.
function writeSettings(
  cwd: string,
  opts: { secondOpinion?: boolean; codex?: boolean } = {},
): void {
  const dir = join(cwd, '.forge');
  mkdirSync(dir, { recursive: true });
  let blocks = '';
  if (opts.secondOpinion !== undefined) {
    blocks += `\nsecond_opinion:\n  auto_enabled: ${opts.secondOpinion}\n`;
  }
  if (opts.codex !== undefined) {
    blocks += `\ncodex:\n  auto_codex_enabled: ${opts.codex}\n`;
  }
  const yaml = `version: 1
project:
  name: test-second-opinion-suggest
tracker:
  type: linear
  config:
    team_id: T
secrets:
  manager: env_file
${blocks}`;
  writeFileSync(join(dir, 'settings.yaml'), yaml, 'utf8');
}

// ── env disable resolution ───────────────────────────────────────────────────

test('FORGE-150 — FORGE_AUTO_SECOND_OPINION=0 silences output', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_SECOND_OPINION: '0' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
  assert.equal(stderr.buf, '');
});

test('FORGE-150 — FORGE_AUTO_SECOND_OPINION=false silences output', () => {
  const cwd = tmp();
  const { stdout } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_SECOND_OPINION: 'false' },
    stdout,
    stderr: capture().stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-150 — legacy FORGE_AUTO_CODEX=0 still honored, with deprecation note', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: '0' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, ''); // disabled
  // Deprecation note fires exactly once.
  assert.match(stderr.buf, /FORGE_AUTO_CODEX is deprecated/);
  assert.equal((stderr.buf.match(/FORGE_AUTO_CODEX is deprecated/g) ?? []).length, 1);
});

test('FORGE-150 — legacy deprecation note suppressed by FORGE_QUIET=1', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_CODEX: '0', FORGE_QUIET: '1' },
    stdout,
    stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, ''); // still disabled
  assert.equal(stderr.buf, ''); // note suppressed
});

test('FORGE-150 — primary var wins over legacy (primary=1 ignores legacy=0)', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: { FORGE_AUTO_SECOND_OPINION: '1', FORGE_AUTO_CODEX: '0' },
    stdout,
    stderr,
  });
  // Primary present → legacy ignored entirely → suggestion fires, no note.
  assert.match(stdout.buf, /\/second-opinion review-plan/);
  assert.equal(stderr.buf, '');
});

// ── settings precedence ──────────────────────────────────────────────────────

test('FORGE-150 — no settings.yaml uses defaults and prints suggestion', () => {
  const cwd = tmp();
  const { stdout } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr: capture().stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.match(stdout.buf, /\/second-opinion review-plan/);
  assert.match(stdout.buf, /FORGE_AUTO_SECOND_OPINION=0 to disable/);
});

test('FORGE-150 — second_opinion.auto_enabled: false silences output', () => {
  const cwd = tmp();
  writeSettings(cwd, { secondOpinion: false });
  const { stdout } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr: capture().stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-150 — legacy-only codex.auto_codex_enabled: false honored (un-migrated repo)', () => {
  const cwd = tmp();
  writeSettings(cwd, { codex: false });
  const { stdout } = capture();
  const result = runSecondOpinionSuggest({
    cwd,
    argv: ['plan-task'],
    env: {},
    stdout,
    stderr: capture().stderr,
  });
  // second_opinion materializes via default (true), but the present legacy
  // block disables → silent.
  assert.equal(result.exitCode, 0);
  assert.equal(stdout.buf, '');
});

test('FORGE-150 — legacy false is not silently lost when codex block present', () => {
  const cwd = tmp();
  writeSettings(cwd, { codex: false });
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['ship'], env: {}, stdout, stderr: capture().stderr });
  assert.equal(stdout.buf, '');
});

test('FORGE-150 — explicit second_opinion.false wins even with legacy codex.true', () => {
  const cwd = tmp();
  writeSettings(cwd, { secondOpinion: false, codex: true });
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.equal(stdout.buf, '');
});

// GPT-5.5 review F1: the OTHER conflict direction. Explicit primary `true` must
// win over a legacy `false` — the bug was the resolver couldn't tell explicit-
// true from defaulted-true, so legacy `false` wrongly overrode it.
test('FORGE-150 — explicit second_opinion.true wins even with legacy codex.false', () => {
  const cwd = tmp();
  writeSettings(cwd, { secondOpinion: true, codex: false });
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/second-opinion review-plan/);
});

test('FORGE-150 — second_opinion.true with no legacy block prints suggestion', () => {
  const cwd = tmp();
  writeSettings(cwd, { secondOpinion: true });
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/second-opinion review-plan/);
});

// ── event vocabulary + suggestion snapshot ───────────────────────────────────

test('FORGE-150 — suggestion text snapshot (new hint)', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.equal(
    stdout.buf,
    '💡 Suggested next: /second-opinion review-plan (run with FORGE_AUTO_SECOND_OPINION=0 to disable)\n',
  );
});

test('FORGE-150 — event ship maps to /second-opinion review-impl', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['ship'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/second-opinion review-impl/);
});

test('FORGE-150 — event update-spec maps to /second-opinion review-decision (reserved)', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runSecondOpinionSuggest({ cwd, argv: ['update-spec'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/second-opinion review-decision/);
});

test('FORGE-150 — unknown event exits 1 and writes stderr', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({ cwd, argv: ['bogus'], env: {}, stdout, stderr });
  assert.equal(result.exitCode, 1);
  assert.equal(stdout.buf, '');
  assert.match(stderr.buf, /unknown event 'bogus'/);
});

test('FORGE-150 — missing event arg exits 1 with usage', () => {
  const cwd = tmp();
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({ cwd, argv: [], env: {}, stdout, stderr });
  assert.equal(result.exitCode, 1);
  assert.equal(stdout.buf, '');
  assert.match(stderr.buf, /missing event arg/);
  assert.match(stderr.buf, /usage: forge second-opinion suggest/);
});

test('FORGE-150 — malformed settings.yaml falls back to defaults with stderr warning', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  writeFileSync(join(cwd, '.forge', 'settings.yaml'), 'this: is: not: valid yaml:::\n', 'utf8');
  const { stdout, stderr } = capture();
  const result = runSecondOpinionSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr });
  assert.equal(result.exitCode, 0);
  assert.match(stdout.buf, /\/second-opinion review-plan/);
  assert.match(stderr.buf, /could not be parsed/);
});

test('FORGE-150 — EVENT_TO_VERB locked vocabulary surface', () => {
  assert.deepEqual(__TEST_ONLY.KNOWN_EVENTS, ['plan-task', 'ship', 'update-spec']);
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['plan-task'], 'review-plan');
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['ship'], 'review-impl');
  assert.equal(__TEST_ONLY.EVENT_TO_VERB['update-spec'], 'review-decision');
});

test('FORGE-150 — codex-suggest.ts re-export still resolves the implementation', () => {
  const cwd = tmp();
  const { stdout } = capture();
  runCodexSuggest({ cwd, argv: ['plan-task'], env: {}, stdout, stderr: capture().stderr });
  assert.match(stdout.buf, /\/second-opinion review-plan/);
});

// Codex F1 (confidence 8): GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR env vars
// can redirect `git rev-parse --git-common-dir`. The verb sanitizes the env
// before invoking git so resolution stays anchored on cwd.
test('FORGE-150 — GIT_DIR/GIT_WORK_TREE env cannot redirect settings discovery', () => {
  const attackerRoot = tmp();
  writeSettings(attackerRoot, { secondOpinion: false });
  const victimCwd = tmp();
  const { stdout } = capture();
  runSecondOpinionSuggest({
    cwd: victimCwd,
    argv: ['plan-task'],
    env: {
      GIT_DIR: `${attackerRoot}/.git`,
      GIT_WORK_TREE: attackerRoot,
      GIT_COMMON_DIR: `${attackerRoot}/.git`,
    },
    stdout,
    stderr: capture().stderr,
  });
  assert.match(stdout.buf, /\/second-opinion review-plan/);
});
