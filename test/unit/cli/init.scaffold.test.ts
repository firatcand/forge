import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import {
  scaffoldProject,
  appendGitignoreBlock,
  toMinimalYamlObject,
} from '../../../src/cli/init/scaffold.ts';
import { SettingsSchema } from '../../../src/schemas/index.ts';
import type { InitAnswers } from '../../../src/cli/init/prompts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const templatesDir = resolve(repoRoot, 'templates');
const goldenPath = resolve(repoRoot, 'test/fixtures/init/golden-settings.yaml');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-scaffold-'));
}

function fixtureAnswers(): InitAnswers {
  return {
    project: { name: 'sample-app', description: 'a sample app' },
    goal: 'ship a sample app with forge',
    tracker: { type: 'linear', config: { team_id: 'TEAM-1' } },
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
    },
    design: { mode: 'project_owned' },
  };
}

test('scaffoldProject writes all expected artefacts', () => {
  const cwd = tmp();
  const result = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  for (const f of [
    'spec/BRIEF.md',
    'spec/PRD.md',
    'spec/SPEC.md',
    'spec/DESIGN.md',
    'CRITICAL.md',
    'CLAUDE.md',
    'plans/tasks/.gitkeep',
    '.forge/settings.yaml',
  ]) {
    assert.ok(existsSync(resolve(cwd, f)), `expected ${f}`);
  }
  assert.ok(result.written.includes('.gitignore'));
});

test('scaffolded settings.yaml round-trips through SettingsSchema', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const raw = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8');
  const parsed = SettingsSchema.safeParse(yamlParse(raw));
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.project.name, 'sample-app');
    assert.equal(parsed.data.tracker.type, 'linear');
  }
});

test('scaffolded settings.yaml matches golden fixture (byte-for-byte minus trailing whitespace)', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const actual = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8').trim();
  const expected = readFileSync(goldenPath, 'utf8').trim();
  assert.equal(actual, expected, `\nEXPECTED:\n${expected}\n\nACTUAL:\n${actual}\n`);
});

test('scaffold injects goal into spec/BRIEF.md ## Product section', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const brief = readFileSync(resolve(cwd, 'spec/BRIEF.md'), 'utf8');
  assert.match(brief, /## Product\nship a sample app with forge/);
  // The original REQUIRED comment should be replaced (not duplicated).
  assert.equal(/<!-- REQUIRED: One or two sentences. What does this product DO\? -->/.test(brief), false);
});

test('scaffold renders {{PROJECT_NAME}} in CLAUDE.md and templates', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const claude = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /# sample-app/);
  const prd = readFileSync(resolve(cwd, 'spec/PRD.md'), 'utf8');
  assert.match(prd, /sample-app — PRD/);
});

test('scaffold renders {{ISO_DATE}}', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const brief = readFileSync(resolve(cwd, 'spec/BRIEF.md'), 'utf8');
  assert.match(brief, /Forged: 2026-05-12/);
});

test('.gitignore append is idempotent', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const after1 = readFileSync(resolve(cwd, '.gitignore'), 'utf8');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12', overwrite: { 'CLAUDE.md': true, 'CRITICAL.md': true, 'spec/BRIEF.md': true, 'spec/PRD.md': true, 'spec/SPEC.md': true, 'spec/DESIGN.md': true, 'plans/tasks/.gitkeep': true } });
  const after2 = readFileSync(resolve(cwd, '.gitignore'), 'utf8');
  assert.equal(after1, after2);
});

test('appendGitignoreBlock leaves user content intact', () => {
  const existing = 'node_modules\ndist\n';
  const { content, appended } = appendGitignoreBlock(existing);
  assert.equal(appended, true);
  assert.ok(content.startsWith('node_modules\ndist\n'));
  assert.ok(content.includes('.forge/worktrees/'));
});

test('appendGitignoreBlock no-ops when "# forge" marker already present', () => {
  const existing = 'node_modules\n# forge\n.forge/worktrees/\n';
  const { content, appended } = appendGitignoreBlock(existing);
  assert.equal(appended, false);
  assert.equal(content, existing);
});

test('scaffold skips overwriting existing files by default', () => {
  const cwd = tmp();
  // Pre-create a different CLAUDE.md
  writeFileSync(resolve(cwd, 'CLAUDE.md'), '# existing user content\n');
  const r = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  assert.ok(r.skipped.includes('CLAUDE.md'));
  const after = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.equal(after, '# existing user content\n');
});

test('scaffold overwrites when explicitly opted in via overwrite map', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'CLAUDE.md'), 'old');
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    overwrite: { 'CLAUDE.md': true },
  });
  assert.ok(r.written.includes('CLAUDE.md'));
  const after = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(after, /# sample-app/);
});

test('scaffold always overwrites .forge/settings.yaml (mustOverwrite)', () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'invalid: stale\n');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const out = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8');
  assert.ok(out.includes('version: 1'));
});

test('scaffold cleans orphaned .forge/.init-staging dir from prior crash', () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge/.init-staging/half'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/.init-staging/half/leftover.txt'), 'old');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  // Staging should be cleaned at the end.
  assert.equal(existsSync(resolve(cwd, '.forge/.init-staging')), false);
});

test('scaffold writes init-warnings.md when unverified is non-empty', () => {
  const cwd = tmp();
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    unverified: ['primary_host', 'linear_mcp'],
  });
  assert.ok(r.warningsPath);
  const body = readFileSync(resolve(cwd, '.forge/init-warnings.md'), 'utf8');
  assert.match(body, /primary_host/);
  assert.match(body, /linear_mcp/);
});

test('scaffold omits init-warnings.md when unverified is empty', () => {
  const cwd = tmp();
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    unverified: [],
  });
  assert.equal(r.warningsPath, undefined);
  assert.equal(existsSync(resolve(cwd, '.forge/init-warnings.md')), false);
});

test('toMinimalYamlObject omits description when absent', () => {
  const obj = toMinimalYamlObject({
    ...fixtureAnswers(),
    project: { name: 'plain' },
  });
  const project = obj.project as Record<string, unknown>;
  assert.equal(project.description, undefined);
});
