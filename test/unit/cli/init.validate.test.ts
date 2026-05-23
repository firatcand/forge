import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';
import { validateTooling } from '../../../src/cli/init/validate.ts';
import type { InitAnswers } from '../../../src/cli/init/prompts.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-validate-'));
}

function baseAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    project: { name: 'app' },
    goal: 'g',
    tracker: { type: 'linear', config: { team_id: 'T' } },
    github_connected: false,
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude'],
    },
    design: { mode: 'project_owned' },
    ...overrides,
  };
}

function mockExec(plan: Record<string, { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }>): ExecaLike {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = plan[key] ?? plan[cmd] ?? { exitCode: 127, stdout: '', stderr: 'not found' };
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
    };
  };
}

test('validateTooling: git pass + claude pass + linear MCP pass + codex pass + env file exists', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1\n' },
    'claude --version': { exitCode: 0, stdout: '1.0.0' },
    'codex --version': { exitCode: 0, stdout: '0.1.0' },
    'claude mcp list': { exitCode: 0, stdout: 'linear  https://...\n' },
  });
  const report = await validateTooling(baseAnswers(), {
    cwd,
    exec,
    autoSkipFailures: true,
    getEnv: (n) => (n === 'LINEAR_API_KEY' ? 'lin_api_test' : undefined),
  });
  assert.equal(report.gitFatal, false);
  assert.equal(report.unverified.length, 0);
  const statuses = Object.fromEntries(report.results.map((r) => [r.key, r.status]));
  assert.equal(statuses['git'], 'pass');
  assert.equal(statuses['primary_host'], 'pass');
  assert.equal(statuses['review_host'], 'pass');
  assert.equal(statuses['linear_mcp'], 'pass');
  assert.equal(statuses['linear_api_key'], 'pass');
  assert.equal(statuses['secret_mgr_env_file'], 'pass');
});

test('validateTooling: linear tracker without LINEAR_API_KEY env → linear_api_key probe fails', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1\n' },
    'claude --version': { exitCode: 0, stdout: '1.0.0' },
    'codex --version': { exitCode: 0, stdout: '0.1.0' },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const report = await validateTooling(baseAnswers(), {
    cwd,
    exec,
    autoSkipFailures: true,
    getEnv: () => undefined,
  });
  const apiKey = report.results.find((r) => r.key === 'linear_api_key');
  assert.ok(apiKey, 'linear_api_key probe should exist');
  assert.equal(apiKey!.status, 'fail');
  assert.match(apiKey!.message ?? '', /LINEAR_API_KEY/);
  assert.ok(report.unverified.includes('linear_api_key'));
});

test('validateTooling: github tracker does NOT run linear_api_key probe', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1\n' },
    'claude --version': { exitCode: 0, stdout: '1.0.0' },
    'codex --version': { exitCode: 0, stdout: '0.1.0' },
    'gh auth status': { exitCode: 0 },
  });
  const report = await validateTooling(
    baseAnswers({ tracker: { type: 'github', config: { repo: 'x/y' } } }),
    { cwd, exec, autoSkipFailures: true, getEnv: () => undefined },
  );
  assert.equal(
    report.results.find((r) => r.key === 'linear_api_key'),
    undefined,
    'linear_api_key probe should not run for github tracker',
  );
});

test('validateTooling: git fail sets gitFatal=true', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  const exec = mockExec({
    'git --version': { exitCode: 127, stderr: 'git: not found' },
    'claude --version': { exitCode: 0, stdout: '1.0.0' },
    'codex --version': { exitCode: 0, stdout: '0.1.0' },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const report = await validateTooling(baseAnswers(), { cwd, exec, autoSkipFailures: true });
  assert.equal(report.gitFatal, true);
});

test('validateTooling: git old version (2.10) fails', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.10.0' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const report = await validateTooling(baseAnswers(), { cwd, exec, autoSkipFailures: true });
  assert.equal(report.gitFatal, true);
});

test('validateTooling: missing env file is a (non-fatal) probe failure', async () => {
  const cwd = tmp();
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const report = await validateTooling(baseAnswers(), { cwd, exec, autoSkipFailures: true });
  assert.equal(report.gitFatal, false);
  assert.ok(report.unverified.includes('secret_mgr_env_file'));
});

test('validateTooling: github tracker probes gh auth status', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'gh auth status': { exitCode: 0, stdout: 'Logged in' },
  });
  const answers = baseAnswers({ tracker: { type: 'github', config: { repo: 'firatcand/forge' } } });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const gh = report.results.find((r) => r.key === 'gh');
  assert.ok(gh);
  assert.equal(gh.status, 'pass');
});

test('validateTooling: notion tracker probes notion in mcp list', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  // Notion probe now verifies the configured mcp_command's executable is on
  // PATH (forge spawns its own MCP server) — it does NOT probe
  // `claude mcp list`.
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'npx --version': { exitCode: 0, stdout: '10.8.2' },
  });
  const answers = baseAnswers({
    tracker: {
      type: 'notion',
      config: {
        database_id: 'db',
        mcp_command: ['npx', '-y', '@notionhq/notion-mcp-server'],
        mcp_env: {},
      },
    },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'notion_mcp_command');
  assert.equal(probe?.status, 'pass');
});

test('validateTooling: MCP probe skipped when primary host is not claude', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'codex --version': { exitCode: 0 },
    'gemini --version': { exitCode: 0 },
  });
  const answers = baseAnswers({
    agents: {
      max_concurrent: 1,
      retry_attempts: 0,
      primary_host_cli: 'codex',
      review_host_cli: 'gemini',
      enabled_root_files: ['codex'],
    },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'linear_mcp');
  assert.equal(probe?.status, 'skip');
});

test('validateTooling: 1password secret manager probes op --version', async () => {
  const cwd = tmp();
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
    'op --version': { exitCode: 0, stdout: '2.10.0' },
  });
  const answers = baseAnswers({ secrets: { manager: '1password', vault: 'Personal' } });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  assert.equal(report.results.find((r) => r.key === 'secret_mgr_op')?.status, 'pass');
});

test('validateTooling: doppler / aws / infisical probes wired', async () => {
  const cwd = tmp();
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
    'doppler --version': { exitCode: 0 },
    'aws --version': { exitCode: 0 },
    'infisical --version': { exitCode: 0 },
  });
  for (const s of [
    { manager: 'doppler' as const, project: 'p', config: 'dev' },
    { manager: 'aws_secrets' as const, region: 'us-east-1' },
    { manager: 'infisical' as const, workspace_id: 'w', env: 'dev' },
  ]) {
    const answers = baseAnswers({ secrets: s });
    const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
    const probe = report.results.find((r) => r.key.startsWith('secret_mgr_'));
    assert.ok(probe);
    assert.equal(probe.status, 'pass');
  }
});

test('validateTooling: timeout treated as failure', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec: ExecaLike = async (cmd) => {
    if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.40.1', stderr: '' };
    return { exitCode: null, stdout: '', stderr: '', timedOut: true };
  };
  const report = await validateTooling(baseAnswers(), { cwd, exec, timeoutMs: 10, autoSkipFailures: true });
  assert.equal(report.gitFatal, false);
  // primary_host should be in unverified
  assert.ok(report.unverified.includes('primary_host'));
});

test('validateTooling: review_host probe omitted when review_host_cli is null', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const answers = baseAnswers({
    agents: {
      max_concurrent: 1,
      retry_attempts: 0,
      primary_host_cli: 'claude',
      review_host_cli: null,
      enabled_root_files: ['claude'],
    },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  assert.equal(report.results.find((r) => r.key === 'review_host'), undefined);
});

test('validateTooling: onProbeFailure(false) for non-git probe throws', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 127, stderr: 'not found' },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  await assert.rejects(
    validateTooling(baseAnswers(), { cwd, exec, onProbeFailure: async () => false }),
    /probe primary_host failed and user declined to skip/,
  );
});

test('validateTooling: onProbeFailure(true) appends to unverified', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 127 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
  });
  const report = await validateTooling(baseAnswers(), { cwd, exec, onProbeFailure: async () => true });
  assert.ok(report.unverified.includes('primary_host'));
});

// FORGE-108: agent-level gh auth probe gated by github_connected flag.
test('FORGE-108 — validateTooling fires gh_auth_agent probe when github_connected=true (Linear tracker)', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
    'gh auth status': { exitCode: 0 },
  });
  const answers = baseAnswers({ github_connected: true });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true, getEnv: () => 'fake-key' });
  const ghAuthAgent = report.results.find((r) => r.key === 'gh_auth_agent');
  assert.ok(ghAuthAgent, 'gh_auth_agent probe must run when github_connected=true');
  assert.equal(ghAuthAgent.status, 'pass');
});

test('FORGE-108 — validateTooling omits gh_auth_agent probe when github_connected=false', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
    'gh auth status': { exitCode: 0 }, // wired but should NOT fire
  });
  const answers = baseAnswers({ github_connected: false });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true, getEnv: () => 'fake-key' });
  assert.equal(
    report.results.find((r) => r.key === 'gh_auth_agent'),
    undefined,
    'gh_auth_agent probe must NOT run when github_connected=false',
  );
});

test('FORGE-108 — validateTooling routes gh_auth_agent failure into unverified[] under autoSkip', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'claude mcp list': { exitCode: 0, stdout: 'linear' },
    'gh auth status': { exitCode: 1, stderr: 'not logged in' },
  });
  const answers = baseAnswers({ github_connected: true });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true, getEnv: () => 'fake-key' });
  assert.ok(
    report.unverified.includes('gh_auth_agent'),
    'gh_auth_agent failure must land in unverified[] under autoSkip',
  );
});

// suppress unused-var lints by referencing mkdirSync
void mkdirSync;
