import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { parse as yamlParse } from 'yaml';
import { SettingsSchema } from '../../../src/schemas/index.ts';
import { tsxBin, forgeBinEntry as entry } from '../../helpers/spawn-tsx.ts';

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
    // FORGE-152: enabled_root_files is required by InitAnswersSchema's
    // .min(1) refinement. Default to the same single-agent setup pre-FORGE-152
    // tests used (only CLAUDE.md is written).
    enabled_root_files: ['claude'],
  },
  design: { mode: 'project_owned' },
};

// FORGE-152: multi-agent answers — writes CLAUDE.md, AGENTS.md, GEMINI.md.
const MULTI_AGENT_ANSWERS = {
  ...VALID_ANSWERS,
  agents: {
    ...VALID_ANSWERS.agents,
    enabled_root_files: ['claude', 'codex', 'gemini'],
  },
};

// FORGE-152: codex-only answers — primary is codex, only AGENTS.md is written.
const CODEX_ONLY_ANSWERS = {
  ...VALID_ANSWERS,
  agents: {
    max_concurrent: 10,
    retry_attempts: 10,
    primary_host_cli: 'codex',
    review_host_cli: null,
    enabled_root_files: ['codex'],
  },
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
    '.forge/CONTEXT.md',
    '.forge/.version',
    '.gitignore',
  ]) {
    assert.ok(existsSync(join(cwd, f)), `missing expected file: ${f}`);
  }

  // FORGE-152: with primary='claude' and only ['claude'] enabled, AGENTS/GEMINI must NOT exist.
  assert.ok(!existsSync(join(cwd, 'AGENTS.md')), 'AGENTS.md should NOT exist for single-agent claude config');
  assert.ok(!existsSync(join(cwd, 'GEMINI.md')), 'GEMINI.md should NOT exist for single-agent claude config');

  const raw = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');
  const parsed = SettingsSchema.safeParse(yamlParse(raw));
  assert.equal(parsed.success, true, `settings.yaml parse failed: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);

  // FORGE-152: .gitignore has the new marker block (not the old # forge marker).
  const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
  assert.match(gi, /# >>> forge-managed/);
  assert.match(gi, /\/\.forge\/\*/);
  assert.match(gi, /!\/\.forge\/settings\.yaml/);

  // FORGE-152: CONTEXT.md contains the methodology + rendered CLI surface.
  const ctx = readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8');
  assert.match(ctx, /# Forge methodology/);
  assert.match(ctx, /forge orchestrate/, 'CLI verbs section should be rendered');
  assert.match(ctx, /- `\/pickup-task`/, 'slash command section should be rendered');

  // FORGE-152: .version is a semver.
  const version = readFileSync(join(cwd, '.forge/.version'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+/, `.forge/.version should be semver, got: ${JSON.stringify(version)}`);
});

test('e2e (FORGE-152): forge init writes all three root files when enabled_root_files=[claude,codex,gemini]', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer-multi' }));
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');

  // Multi-agent requires gemini opt-in only when gemini is primary OR review;
  // here primary=claude/review=codex, so the gemini-experimental gate doesn't
  // fire — gemini in enabled_root_files alone is allowed.
  const result = await execa(tsxBin, [entry, 'init'], {
    cwd,
    reject: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FORGE_INIT_NONINTERACTIVE: '1',
      FORGE_INIT_ANSWERS_JSON: JSON.stringify(MULTI_AGENT_ANSWERS),
      FORGE_INIT_SKIP_VALIDATION: '1',
    },
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    const p = join(cwd, name);
    assert.ok(existsSync(p), `${name} should exist`);
    const contents = readFileSync(p, 'utf8');
    assert.match(contents, /<!-- >>> forge-managed/, `${name} should have marker block`);
  }
});

test('e2e (FORGE-152): forge init with primary=codex writes only AGENTS.md (no CLAUDE.md)', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer-codex' }));
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');

  const result = await execa(tsxBin, [entry, 'init'], {
    cwd,
    reject: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FORGE_INIT_NONINTERACTIVE: '1',
      FORGE_INIT_ANSWERS_JSON: JSON.stringify(CODEX_ONLY_ANSWERS),
      FORGE_INIT_SKIP_VALIDATION: '1',
    },
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  assert.ok(existsSync(join(cwd, 'AGENTS.md')), 'AGENTS.md should exist');
  assert.ok(!existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md should NOT exist');
  assert.ok(!existsSync(join(cwd, 'GEMINI.md')), 'GEMINI.md should NOT exist');

  // .forge/CONTEXT.md always materialized regardless of which agent.
  assert.ok(existsSync(join(cwd, '.forge/CONTEXT.md')));
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
