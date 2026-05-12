import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { parse as yamlParse } from 'yaml';
import { SettingsSchema } from '../../../src/schemas/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const entry = resolve(repoRoot, 'src/bin/forge.ts');
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-init-e2e-'));
}

const VALID_ANSWERS = {
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

test('e2e: forge init with FORGE_INIT_NONINTERACTIVE + answers writes all expected files', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer-app' }));
  // env file should exist so probe doesn't add unverified
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');

  const result = await execa(tsxBin, [entry, 'init'], {
    cwd,
    reject: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FORGE_INIT_NONINTERACTIVE: '1',
      FORGE_INIT_ANSWERS_JSON: JSON.stringify(VALID_ANSWERS),
      FORGE_INIT_SKIP_VALIDATION: '1',
    },
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  for (const f of [
    'spec/BRIEF.md',
    'spec/PRD.md',
    'spec/SPEC.md',
    'spec/DESIGN.md',
    'CRITICAL.md',
    'CLAUDE.md',
    'plans/tasks/.gitkeep',
    '.forge/settings.yaml',
    '.gitignore',
  ]) {
    assert.ok(existsSync(join(cwd, f)), `missing expected file: ${f}`);
  }

  const raw = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');
  const parsed = SettingsSchema.safeParse(yamlParse(raw));
  assert.equal(parsed.success, true, `settings.yaml parse failed: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
});

test('e2e: forge init <name> positional name skips prompt 1', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer-app' }));

  // Override the positional path via name in answers JSON (positional is honoured by bin; in non-interactive
  // mode answers come from JSON, and the positional is informational. This e2e checks the dispatch survives.)
  const result = await execa(tsxBin, [entry, 'init', 'positional-name'], {
    cwd,
    reject: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FORGE_INIT_NONINTERACTIVE: '1',
      FORGE_INIT_ANSWERS_JSON: JSON.stringify(VALID_ANSWERS),
      FORGE_INIT_SKIP_VALIDATION: '1',
    },
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('e2e: refusal inside @firatcand/forge package exits 2', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@firatcand/forge' }));
  const result = await execa(tsxBin, [entry, 'init'], {
    cwd,
    reject: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FORGE_INIT_NONINTERACTIVE: '1',
      FORGE_INIT_ANSWERS_JSON: JSON.stringify(VALID_ANSWERS),
      FORGE_INIT_SKIP_VALIDATION: '1',
    },
  });
  assert.equal(result.exitCode, 2);
});
