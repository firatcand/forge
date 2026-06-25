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

function mockExec(plan: Record<string, { exitCode: number | undefined; stdout?: string; stderr?: string; timedOut?: boolean; code?: string }>): ExecaLike {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = plan[key] ?? plan[cmd] ?? { exitCode: 127, stdout: '', stderr: 'not found' };
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
      // Spawn-failure shape passthrough: execa@9 with reject:false resolves
      // ENOENT with exitCode undefined + code 'ENOENT' (runProbe handles it).
      ...(r.code !== undefined ? { code: r.code } : {}),
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

test('validateTooling: host-CLI + git `--version` probes run with a sanitized env (FORGE-224, no secret leak via PATH-hijacked bin)', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  const SECRET = 'GITHUB_TOKEN';
  const hadSecret = process.env[SECRET];
  process.env[SECRET] = 'ghp_secret';
  try {
    const seen: Record<string, Record<string, unknown>> = {};
    const exec: ExecaLike = async (cmd, args, opts) => {
      seen[`${cmd} ${args.join(' ')}`] = opts as Record<string, unknown>;
      return { exitCode: 0, stdout: cmd === 'git' ? 'git version 2.40.1\n' : '1.0.0', stderr: '' };
    };
    await validateTooling(baseAnswers(), {
      cwd,
      exec,
      autoSkipFailures: true,
      getEnv: (n) => (n === 'LINEAR_API_KEY' ? 'lin_api_test' : undefined),
    });
    for (const key of ['claude --version', 'codex --version', 'git --version']) {
      const opts = seen[key];
      assert.ok(opts, `${key} was probed`);
      assert.equal(opts.extendEnv, false, `${key} runs with extendEnv:false`);
      const env = opts.env as Record<string, string>;
      assert.equal(env[SECRET], undefined, `${key} does NOT forward ${SECRET}`);
      assert.equal(env.PATH, process.env.PATH, `${key} still forwards PATH`);
    }
  } finally {
    if (hadSecret === undefined) delete process.env[SECRET];
    else process.env[SECRET] = hadSecret;
  }
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

test('validateTooling: notion tracker probes ntn install + auth (FORGE-117)', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  // `ntn api v1/users/me` proves installation AND keychain auth in one call —
  // a bare --version would pass for an unauthenticated install.
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'ntn api v1/users/me': { exitCode: 0, stdout: '{"object":"user","id":"u1"}' },
  });
  const answers = baseAnswers({
    tracker: { type: 'notion', config: { database_id: 'db' } },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'ntn');
  assert.equal(probe?.status, 'pass');
});

test('validateTooling: missing ntn binary (execa resolved-ENOENT shape) gets install guidance, not auth guidance', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  // Production shape: execa@9 with reject:false RESOLVES ENOENT with
  // exitCode undefined + code 'ENOENT' — it does not throw.
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    'ntn api v1/users/me': { exitCode: undefined, code: 'ENOENT', stdout: '', stderr: '' },
  });
  const answers = baseAnswers({
    tracker: { type: 'notion', config: { database_id: 'db' } },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'ntn');
  assert.equal(probe?.status, 'fail');
  assert.match(probe?.message ?? '', /not found on PATH/);
  assert.match(probe?.message ?? '', /ENOENT/);
  assert.ok(!(probe?.message ?? '').includes('not authenticated'));
});

test('validateTooling: installed-but-unauthenticated ntn fails with `ntn login` guidance', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    // Binary present, auth probe rejected (no keychain credentials).
    'ntn api v1/users/me': {
      exitCode: 1,
      stderr: '{"object":"error","status":401,"code":"unauthorized"}',
    },
  });
  const answers = baseAnswers({
    tracker: { type: 'notion', config: { database_id: 'db' } },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'ntn');
  assert.equal(probe?.status, 'fail');
  assert.match(probe?.message ?? '', /not authenticated/);
  assert.match(probe?.message ?? '', /ntn login/);
});

test('validateTooling: missing ntn CLI fails with install + `ntn login` guidance', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  const exec = mockExec({
    'git --version': { exitCode: 0, stdout: 'git version 2.40.1' },
    'claude --version': { exitCode: 0 },
    'codex --version': { exitCode: 0 },
    // no 'ntn api v1/users/me' entry → mockExec returns exitCode 127
  });
  const answers = baseAnswers({
    tracker: { type: 'notion', config: { database_id: 'db' } },
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  const probe = report.results.find((r) => r.key === 'ntn');
  assert.equal(probe?.status, 'fail');
  assert.match(probe?.message ?? '', /ntn login/);
  assert.equal(probe?.installLink, 'https://developers.notion.com/cli');
  assert.ok(report.unverified.includes('ntn'));
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

test('FORGE-108 — validateTooling does NOT double-probe gh when tracker=github + github_connected=true', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, '.env.local'), '');
  let ghAuthCalls = 0;
  const exec: ExecaLike = async (cmd, args) => {
    const cmdLine = `${cmd} ${args.join(' ')}`;
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
      ghAuthCalls++;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmdLine === 'git --version') {
      return { exitCode: 0, stdout: 'git version 2.40.1', stderr: '', timedOut: false };
    }
    if (cmdLine === 'claude --version') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (cmdLine === 'codex --version') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    return { exitCode: 127, stdout: '', stderr: 'not found', timedOut: false };
  };
  const answers = baseAnswers({
    tracker: { type: 'github', config: { repo: 'firatcand/forge' } },
    github_connected: true,
  });
  const report = await validateTooling(answers, { cwd, exec, autoSkipFailures: true });
  // Existing probeTracker(github) emits key 'gh'. The new probeGhAuthAgent
  // emits 'gh_auth_agent'. The guard `tracker.type !== 'github'` MUST suppress
  // the latter when github is already covered.
  const ghProbe = report.results.find((r) => r.key === 'gh');
  const ghAuthAgentProbe = report.results.find((r) => r.key === 'gh_auth_agent');
  assert.ok(ghProbe, 'tracker-conditional `gh` probe should run for tracker=github');
  assert.equal(
    ghAuthAgentProbe,
    undefined,
    'gh_auth_agent probe must NOT also run when tracker=github (would double-probe identical args)',
  );
  assert.equal(ghAuthCalls, 1, 'gh auth status should run exactly once, not twice');
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
