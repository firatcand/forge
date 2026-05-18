import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { tsxBin, forgeBinEntry as entry } from '../../helpers/spawn-tsx.ts';

const VALID_ANSWERS = {
  project: { name: 'perf-app' },
  goal: 'measure perf',
  tracker: { type: 'github', config: { repo: 'a/b' } },
  secrets: { manager: 'env_file', env_file_path: './.env.local' },
  agents: {
    max_concurrent: 5,
    retry_attempts: 3,
    primary_host_cli: 'claude',
    review_host_cli: 'codex',
  },
  design: { mode: 'project_owned' },
};

test('perf: forge init completes well under 30 seconds with validation skipped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-init-perf-'));
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'perf-consumer' }));
  const start = Date.now();
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
  const elapsed = Date.now() - start;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(elapsed < 30_000, `forge init took ${elapsed}ms (≥ 30000ms)`);
});
