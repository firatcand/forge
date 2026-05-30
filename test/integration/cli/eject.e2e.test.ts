import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { tsxBin, forgeBinEntry as entry } from '../../helpers/spawn-tsx.ts';

const ANSWERS = {
  project: { name: 'sample-app', description: 'a sample app' },
  goal: 'ship a sample app with forge',
  tracker: { type: 'linear', config: { team_id: 'TEAM-1' } },
  secrets: { manager: 'env_file', env_file_path: './.env.local' },
  agents: {
    max_concurrent: 10,
    retry_attempts: 10,
    primary_host_cli: 'claude',
    review_host_cli: 'codex',
    enabled_root_files: ['claude'],
  },
  design: { mode: 'project_owned' },
};

const initEnv = {
  ...process.env,
  NODE_OPTIONS: '',
  FORGE_INIT_NONINTERACTIVE: '1',
  FORGE_INIT_ANSWERS_JSON: JSON.stringify(ANSWERS),
  FORGE_INIT_SKIP_VALIDATION: '1',
};

// Pre-existing user files forge will APPEND to (not create). Byte-exact reversal
// of these is the core of the "as if forge was never installed" contract.
const USER_GITIGNORE = 'node_modules\ndist\n';
const USER_ESLINTIGNORE = 'coverage\n';

async function git(cwd: string, ...a: string[]): Promise<void> {
  await execa('git', a, { cwd, reject: true });
}

/** Real git repo + user files + forge init, all committed clean. Returns cwd. */
async function installedProject(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-eject-e2e-'));
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.email', 'test@example.com');
  await git(cwd, 'config', 'user.name', 'test');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer-app' }));
  writeFileSync(join(cwd, '.env.local'), 'X=1\n');
  writeFileSync(join(cwd, '.gitignore'), USER_GITIGNORE);
  writeFileSync(join(cwd, '.eslintignore'), USER_ESLINTIGNORE);
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', 'pre-forge');

  const init = await execa(tsxBin, [entry, 'init'], { cwd, reject: false, env: initEnv });
  assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);

  // Commit forge's install so the eject dirty-git guard sees a clean tree.
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', 'forge init');
  return cwd;
}

test('e2e: forge eject --confirm reverses install byte-exactly + leaves user deliverables', async () => {
  const cwd = await installedProject();

  // Sanity: forge artifacts present after init.
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md created by init');
  assert.ok(existsSync(join(cwd, '.forge')), '.forge created by init');
  assert.ok(existsSync(join(cwd, '.claude/skills')), 'farm created by init');
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), />>> forge-managed/);

  const res = await execa(tsxBin, [entry, 'eject', '--confirm'], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(res.exitCode, 0, `eject failed: ${res.stderr}\n${res.stdout}`);

  // forge-created files removed.
  assert.ok(!existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md deleted (forge-created)');
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge removed');
  assert.ok(!existsSync(join(cwd, '.claude')), 'empty .claude farm removed');

  // user files restored byte-exactly.
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), USER_GITIGNORE, '.gitignore byte-exact');
  assert.equal(readFileSync(join(cwd, '.eslintignore'), 'utf8'), USER_ESLINTIGNORE, '.eslintignore byte-exact');

  // user deliverables left alone (ticket: spec/, plans/, CRITICAL.md untouched).
  assert.ok(existsSync(join(cwd, 'spec/SPEC.md')), 'spec/ left intact');
  assert.ok(existsSync(join(cwd, 'CRITICAL.md')), 'CRITICAL.md left intact');

  // a backup snapshot was taken.
  const backups = readdirSync(cwd).filter((e) => e.startsWith('.forge.eject-backup-'));
  assert.equal(backups.length, 1, 'one backup snapshot dir');
});

test('e2e: dry-run (no --confirm) writes nothing', async () => {
  const cwd = await installedProject();
  const res = await execa(tsxBin, [entry, 'eject'], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /dry-run/i);
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md still present after dry-run');
  assert.ok(existsSync(join(cwd, '.forge')), '.forge still present after dry-run');
  assert.equal(readdirSync(cwd).filter((e) => e.startsWith('.forge.eject-backup-')).length, 0, 'no backup on dry-run');
});

test('e2e: --restore brings the install back', async () => {
  const cwd = await installedProject();
  const ejectRes = await execa(tsxBin, [entry, 'eject', '--confirm'], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(ejectRes.exitCode, 0);
  const backup = readdirSync(cwd).find((e) => e.startsWith('.forge.eject-backup-'));
  assert.ok(backup, 'backup dir exists');

  const restore = await execa(tsxBin, [entry, 'eject', '--restore', backup!], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(restore.exitCode, 0, `restore failed: ${restore.stderr}`);

  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md restored');
  assert.ok(existsSync(join(cwd, '.forge')), '.forge restored');
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), />>> forge-managed/, 'gitignore block restored');
});

test('e2e: refuses when a forge-managed file is dirty in git', async () => {
  const cwd = await installedProject();
  // Modify the marker block region of CLAUDE.md and DO NOT commit.
  writeFileSync(join(cwd, 'CLAUDE.md'), `${readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')}\nlocal edit\n`);

  const res = await execa(tsxBin, [entry, 'eject', '--confirm'], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(res.exitCode, 1, 'refuses with exit 1');
  assert.match(res.stdout + res.stderr, /uncommitted changes|dirty/i);
  assert.ok(existsSync(join(cwd, '.forge')), '.forge untouched on refusal');
});

test('e2e: refuses when an active worktree exists', async () => {
  const cwd = await installedProject();
  // Simulate an in-flight task worktree.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cwd, '.forge/worktrees/FORGE-999'), { recursive: true });

  const res = await execa(tsxBin, [entry, 'eject', '--confirm'], { cwd, reject: false, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(res.exitCode, 1, 'refuses with exit 1');
  assert.match(res.stdout + res.stderr, /worktree/i);
  assert.ok(existsSync(join(cwd, '.forge')), '.forge untouched on refusal');
});
