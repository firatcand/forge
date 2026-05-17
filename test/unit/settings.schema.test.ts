import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SettingsSchema, type Settings } from '../../src/schemas/settings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', 'fixtures', 'settings');

function loadFixture(name: string): unknown {
  const raw = readFileSync(resolve(fixturesDir, name), 'utf8');
  return parseYaml(raw);
}

test('AC1 — parses complete settings.yaml fixture', () => {
  const data = loadFixture('complete.yaml');
  const result = SettingsSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.version, 1);
  assert.equal(result.data.project.name, 'forge-example');
  assert.equal(result.data.tracker.type, 'linear');
  assert.equal(result.data.secrets.manager, 'doppler');
  assert.equal(result.data.agents.primary_host_cli, 'claude');
  assert.equal(result.data.agents.review_host_cli, 'codex');
  assert.equal(result.data.design.mode, 'reference_external');
});

test('AC2 — rejects review_host_cli == primary_host_cli', () => {
  const data = loadFixture('invalid-host-cli-collision.yaml');
  const result = SettingsSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const collisionIssue = result.error.issues.find((i) =>
    i.message.includes('review_host_cli must differ from primary_host_cli'),
  );
  assert.ok(
    collisionIssue,
    `Expected refinement message, got: ${JSON.stringify(result.error.issues)}`,
  );
});

test('AC2 — accepts review_host_cli === null even when names would collide', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'forge-null-review' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: null },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.agents.review_host_cli, null);
});

test('AC2 — accepts review_host_cli !== primary_host_cli (claude/codex)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'forge-distinct' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: 'codex' },
  });
  assert.equal(result.success, true);
});

test('AC3 — applies defaults when agents+design absent', () => {
  const data = loadFixture('minimal.yaml');
  const result = SettingsSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.agents.max_concurrent, 10);
  assert.equal(result.data.agents.retry_attempts, 10);
  assert.equal(result.data.agents.retry_backoff_ms_max, 300_000);
  assert.equal(result.data.agents.poll_interval_ms, 30_000);
  assert.equal(result.data.agents.worktree_root, './.forge/worktrees');
  assert.equal(result.data.agents.on_persistent_failure, 'notify');
  assert.equal(result.data.agents.primary_host_cli, 'claude');
  assert.equal(result.data.agents.review_host_cli, 'codex');
  assert.deepEqual(result.data.agents.preflight_globs, [
    'src/index.ts',
    'src/schemas/**',
    'src/bin/**',
    'src/cli/**',
    'src/trackers/base.ts',
    'src/cli/migrate.ts',
    'spec/**',
    'CRITICAL.md',
    'CLAUDE.md',
    'AGENTS.md',
    'package.json',
    'phases.yaml',
  ]);
  assert.equal(result.data.design.mode, 'project_owned');
});

test('AC3.1 — preflight_globs can be overridden', () => {
  const data = loadFixture('minimal.yaml');
  type WithAgents = { agents?: { preflight_globs?: string[] } };
  (data as WithAgents).agents = { preflight_globs: ['only/this/**'] };
  const result = SettingsSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.agents.preflight_globs, ['only/this/**']);
});

test('AC3 — does NOT default version', () => {
  const result = SettingsSchema.safeParse({
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'version',
  );
  assert.ok(issue, `Expected issue at ['version'], got: ${JSON.stringify(result.error.issues)}`);
});

test('AC3 — does NOT default project', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'project',
  );
  assert.ok(issue, `Expected issue at ['project']`);
});

test('AC3 — does NOT default tracker', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'tracker',
  );
  assert.ok(issue, `Expected issue at ['tracker']`);
});

test('AC3 — does NOT default secrets', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'secrets',
  );
  assert.ok(issue, `Expected issue at ['secrets']`);
});

test('AC3 regression — rejects partial tracker (missing type)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: {},
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
});

test('AC3 regression — rejects partial secrets (missing manager)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: {},
  });
  assert.equal(result.success, false);
});

test('AC3 — agents partial fills remaining defaults and runs refinement', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { max_concurrent: 4 },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.agents.max_concurrent, 4);
  assert.equal(result.data.agents.retry_attempts, 10);
  assert.equal(result.data.agents.primary_host_cli, 'claude');
  assert.equal(result.data.agents.review_host_cli, 'codex');

  const collision = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { max_concurrent: 4, primary_host_cli: 'codex', review_host_cli: 'codex' },
  });
  assert.equal(collision.success, false);
});

test('AC4 — env_file variant: defaults env_file_path to ./.env.local', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.secrets.manager, 'env_file');
  if (result.data.secrets.manager !== 'env_file') return;
  assert.equal(result.data.secrets.env_file_path, './.env.local');
});

test('AC4 — env_file variant: override env_file_path respected', () => {
  const data = loadFixture('secrets-env_file.yaml');
  const result = SettingsSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  if (result.data.secrets.manager !== 'env_file') {
    assert.fail('expected env_file variant');
    return;
  }
  assert.equal(result.data.secrets.env_file_path, './.env.production');
});

test('AC4 — 1password variant: vault required', () => {
  const ok = SettingsSchema.safeParse(loadFixture('secrets-1password.yaml'));
  assert.equal(ok.success, true);
  if (ok.success && ok.data.secrets.manager === '1password') {
    assert.equal(ok.data.secrets.vault, 'forge-prod');
  }

  const missing = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: '1password' },
  });
  assert.equal(missing.success, false);
});

test('AC4 — aws_secrets variant: region required, prefix optional', () => {
  const ok = SettingsSchema.safeParse(loadFixture('secrets-aws_secrets.yaml'));
  assert.equal(ok.success, true);
  if (ok.success && ok.data.secrets.manager === 'aws_secrets') {
    assert.equal(ok.data.secrets.region, 'us-east-1');
    assert.equal(ok.data.secrets.prefix, 'forge/');
  }

  const withoutPrefix = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'aws_secrets', region: 'us-west-2' },
  });
  assert.equal(withoutPrefix.success, true);

  const missingRegion = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'aws_secrets' },
  });
  assert.equal(missingRegion.success, false);
});

test('AC4 — doppler variant: project and config required', () => {
  const ok = SettingsSchema.safeParse(loadFixture('secrets-doppler.yaml'));
  assert.equal(ok.success, true);
  if (ok.success && ok.data.secrets.manager === 'doppler') {
    assert.equal(ok.data.secrets.project, 'forge');
    assert.equal(ok.data.secrets.config, 'prod');
  }

  const missingProject = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'doppler', config: 'prod' },
  });
  assert.equal(missingProject.success, false);

  const missingConfig = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'doppler', project: 'forge' },
  });
  assert.equal(missingConfig.success, false);
});

test('AC4 — infisical variant: workspace_id and env required', () => {
  const ok = SettingsSchema.safeParse(loadFixture('secrets-infisical.yaml'));
  assert.equal(ok.success, true);
  if (ok.success && ok.data.secrets.manager === 'infisical') {
    assert.equal(ok.data.secrets.workspace_id, 'ws_abc123');
    assert.equal(ok.data.secrets.env, 'prod');
  }

  const missingWorkspace = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'infisical', env: 'prod' },
  });
  assert.equal(missingWorkspace.success, false);

  const missingEnv = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'infisical', workspace_id: 'ws' },
  });
  assert.equal(missingEnv.success, false);
});

test('regression — invalid primary_host_cli enum value rejected', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'gpt4' },
  });
  assert.equal(result.success, false);
});

test('regression — github tracker missing config.repo rejected', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'github', config: {} },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
});

test('regression — version: 2 rejected (literal mismatch)', () => {
  const result = SettingsSchema.safeParse({
    version: 2,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
});

test('regression — version: "1" string rejected (literal is numeric 1)', () => {
  const result = SettingsSchema.safeParse({
    version: '1',
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, false);
});

test('type-level — Settings.agents.max_concurrent is non-optional number', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  const settings: Settings = result.data;
  const mc: number = settings.agents.max_concurrent;
  assert.equal(typeof mc, 'number');

  // Compile-time lock: if z.infer ever widens defaulted fields to
  // `T | undefined`, this `satisfies` fails to compile and breaks the
  // build before the regression can ship.
  result.data satisfies {
    agents: {
      max_concurrent: number;
      retry_attempts: number;
      retry_backoff_ms_max: number;
      poll_interval_ms: number;
      worktree_root: string;
      on_persistent_failure: 'notify' | 'block_task' | 'move_to_next';
      primary_host_cli: 'claude' | 'codex' | 'cursor' | 'gemini';
      review_host_cli: 'claude' | 'codex' | 'cursor' | 'gemini' | null;
    };
    design: {
      mode: 'project_owned' | 'reference_external';
    };
  };
});
