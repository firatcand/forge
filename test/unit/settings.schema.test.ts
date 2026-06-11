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
  // /review I5: zod issue path locates the offending field (review_host_cli).
  assert.ok(
    collisionIssue.path.includes('review_host_cli'),
    `expected issue.path to include 'review_host_cli'; got: ${JSON.stringify(collisionIssue.path)}`,
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
    'spec/**',
    'CRITICAL.md',
    'CLAUDE.md',
    'AGENTS.md',
    // FORGE-152: GEMINI.md is a new agent root file, written when
    // agents.enabled_root_files includes 'gemini'.
    'GEMINI.md',
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

// FORGE-88: enum tightening — cursor no longer accepted anywhere; claude
// no longer accepted as a review_host_cli; gemini gated on env var.

test('FORGE-88 — primary_host_cli=cursor rejected (no longer supported)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'cursor' },
  });
  assert.equal(result.success, false);
});

test('FORGE-88 — review_host_cli=cursor rejected (no longer supported)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: 'cursor' },
  });
  assert.equal(result.success, false);
});

test('FORGE-88 — review_host_cli=claude rejected (different-lineage rule)', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'codex', review_host_cli: 'claude' },
  });
  assert.equal(result.success, false);
});

test('FORGE-88 — primary_host_cli=gemini rejected without FORGE_GEMINI_EXPERIMENTAL=1', () => {
  const prior = process.env.FORGE_GEMINI_EXPERIMENTAL;
  delete process.env.FORGE_GEMINI_EXPERIMENTAL;
  try {
    const result = SettingsSchema.safeParse({
      version: 1,
      project: { name: 'x' },
      tracker: { type: 'linear', config: { team_id: 'T' } },
      secrets: { manager: 'env_file' },
      agents: { primary_host_cli: 'gemini', review_host_cli: 'codex' },
    });
    assert.equal(result.success, false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.message.includes('FORGE_GEMINI_EXPERIMENTAL=1'),
    );
    assert.ok(issue, `expected gemini gate message; got: ${JSON.stringify(result.error.issues)}`);
    // /review I5: zod issue path locates the offending field for tooling.
    assert.ok(
      issue.path.includes('primary_host_cli'),
      `expected issue.path to include 'primary_host_cli'; got: ${JSON.stringify(issue.path)}`,
    );
  } finally {
    if (prior !== undefined) process.env.FORGE_GEMINI_EXPERIMENTAL = prior;
  }
});

test('FORGE-88 — primary_host_cli=gemini accepted with FORGE_GEMINI_EXPERIMENTAL=1', () => {
  const prior = process.env.FORGE_GEMINI_EXPERIMENTAL;
  process.env.FORGE_GEMINI_EXPERIMENTAL = '1';
  try {
    const result = SettingsSchema.safeParse({
      version: 1,
      project: { name: 'x' },
      tracker: { type: 'linear', config: { team_id: 'T' } },
      secrets: { manager: 'env_file' },
      agents: { primary_host_cli: 'gemini', review_host_cli: 'codex' },
    });
    assert.equal(result.success, true);
  } finally {
    if (prior === undefined) delete process.env.FORGE_GEMINI_EXPERIMENTAL;
    else process.env.FORGE_GEMINI_EXPERIMENTAL = prior;
  }
});

test('FORGE-88 — review_host_cli=gemini also gated on FORGE_GEMINI_EXPERIMENTAL=1', () => {
  const prior = process.env.FORGE_GEMINI_EXPERIMENTAL;
  delete process.env.FORGE_GEMINI_EXPERIMENTAL;
  try {
    const result = SettingsSchema.safeParse({
      version: 1,
      project: { name: 'x' },
      tracker: { type: 'linear', config: { team_id: 'T' } },
      secrets: { manager: 'env_file' },
      agents: { primary_host_cli: 'codex', review_host_cli: 'gemini' },
    });
    assert.equal(result.success, false);
  } finally {
    if (prior !== undefined) process.env.FORGE_GEMINI_EXPERIMENTAL = prior;
  }
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
      primary_host_cli: 'claude' | 'codex' | 'gemini';
      review_host_cli: 'codex' | 'gemini' | null;
    };
    design: {
      mode: 'project_owned' | 'reference_external';
    };
    codex: {
      auto_codex_enabled: boolean;
    };
    decisions: {
      decision_dir: string;
      stale_draft_threshold_days: number;
    };
    doctor: {
      spec_code_check_enabled: boolean;
    };
    // FORGE-168: optional — `{ commands: string[] } | undefined`, never widened.
    verify?: { commands: string[] };
  };
});

// FORGE-105: codex / decisions / doctor blocks (added 2026-05-18)

test('FORGE-105 — codex block: defaults expand when block omitted', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.codex.auto_codex_enabled, true);
});

test('FORGE-105 — codex block: explicit values preserved', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    codex: { auto_codex_enabled: false },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.codex.auto_codex_enabled, false);
});

test('FORGE-105 — codex block: non-boolean enabled rejected', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    codex: { auto_codex_enabled: 'yes' },
  });
  assert.equal(result.success, false);
});

test('codex block: legacy auto_codex_token_cap key tolerated (FORGE-124)', () => {
  // Decision A: the field was dropped from the schema. Legacy settings.yaml
  // files that still carry it must parse cleanly (zod strips unknown keys by
  // default — no .strict() on CodexSchema) and the key must NOT appear in
  // the parsed output.
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    codex: { auto_codex_enabled: true, auto_codex_token_cap: 50_000 },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.codex.auto_codex_enabled, true);
  assert.ok(!('auto_codex_token_cap' in result.data.codex), 'legacy key must be absent from parsed output');
});

test('FORGE-105 — decisions block: defaults expand when omitted', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.decisions.decision_dir, './spec/decisions');
  assert.equal(result.data.decisions.stale_draft_threshold_days, 7);
});

test('FORGE-105 — decisions block: zero or negative threshold rejected', () => {
  const zero = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    decisions: { stale_draft_threshold_days: 0 },
  });
  assert.equal(zero.success, false);
});

test('FORGE-105 — doctor block: default enabled', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.doctor.spec_code_check_enabled, true);
});

test('FORGE-105 — doctor block: override respected', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    doctor: { spec_code_check_enabled: false },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.doctor.spec_code_check_enabled, false);
});

// FORGE-152 (Phase A — A1): agents.enabled_root_files — which agent root
// files (CLAUDE.md / AGENTS.md / GEMINI.md) the project writes. Defaults to
// [primary_host_cli] when absent, so existing settings.yaml files continue to
// parse without migration.
test('FORGE-152 — enabled_root_files defaults to [primary_host_cli] when absent', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: 'codex' },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.agents.enabled_root_files, ['claude']);
});

test('FORGE-152 — enabled_root_files accepts multi-agent selection', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: {
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude', 'codex'],
    },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.agents.enabled_root_files, ['claude', 'codex']);
});

test('FORGE-152 — enabled_root_files rejects unknown agent', () => {
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: {
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude', 'cursor'],
    },
  });
  assert.equal(result.success, false);
});

test('FORGE-152 — enabled_root_files: explicit [] promotes to [primary_host_cli]', () => {
  // Empty array (absent or explicit []) is functionally identical: "no agent
  // root files." That config is degenerate — settings.yaml has no agent
  // surface to attach to. Always promote empty to [primary_host_cli].
  const result = SettingsSchema.safeParse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: {
      primary_host_cli: 'codex',
      review_host_cli: null,
      enabled_root_files: [],
    },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.agents.enabled_root_files, ['codex']);
});

// FORGE-168: settings.verify — optional adopter-declared verification commands.
// unset ⇒ skip (verify is undefined); present ⇒ must declare ≥1 non-empty cmd.

const verifyBase = {
  version: 1 as const,
  project: { name: 'x' },
  tracker: { type: 'linear' as const, config: { team_id: 'T' } },
  secrets: { manager: 'env_file' as const },
};

test('FORGE-168 — verify omitted: parses, verify is undefined (skip signal)', () => {
  const result = SettingsSchema.safeParse({ ...verifyBase });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.verify, undefined);
});

test('FORGE-168 — verify present with commands: parses and preserves order', () => {
  const result = SettingsSchema.safeParse({
    ...verifyBase,
    verify: { commands: ['npm test', 'npm run lint'] },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.verify, { commands: ['npm test', 'npm run lint'] });
});

test('FORGE-168 — verify present but commands empty: rejected (misconfig, not silent skip)', () => {
  const result = SettingsSchema.safeParse({
    ...verifyBase,
    verify: { commands: [] },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find((i) => i.path.includes('commands'));
  assert.ok(issue, `expected issue at verify.commands; got ${JSON.stringify(result.error.issues)}`);
});

test('FORGE-168 — verify command empty string: rejected', () => {
  const result = SettingsSchema.safeParse({
    ...verifyBase,
    verify: { commands: ['npm test', ''] },
  });
  assert.equal(result.success, false);
});
