import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eject } from '../../../../src/cli/eject/eject.ts';
import { buildPrefixBlock } from '../../../../src/cli/upgrade/agent-root-files.ts';
import type { ForgeManifest } from '../../../../src/schemas/index.ts';

const REPO = 'https://github.com/firatcand/forge';
const MARKER = buildPrefixBlock('claude', { repoUrl: REPO });

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-eject-unit-'));
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  writeFileSync(join(cwd, '.forge/.version'), '0.3.0\n');
  return cwd;
}

function writeManifest(cwd: string, m: ForgeManifest): void {
  writeFileSync(join(cwd, '.forge/manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
}

function baseManifest(over: Partial<ForgeManifest> = {}): ForgeManifest {
  return {
    version: 1,
    forgeVersion: '0.3.0',
    enabledHosts: ['claude'],
    rootFiles: [],
    ignoreFiles: [],
    farmEntries: [],
    staticPaths: ['.forge/CONTEXT.md', '.forge/.version', '.forge/settings.yaml', '.forge/manifest.json'],
    ...over,
  };
}

test('eject: forge-created root file is deleted', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n# Stack\n`);
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: true }] }));

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.ok(!existsSync(join(cwd, 'CLAUDE.md')), 'forge-created file deleted');
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge removed');
});

test('eject: forge-stamped user file keeps user content byte-exact', () => {
  const cwd = project();
  const userBody = '# My Project\n\nMy own notes.\n';
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n${userBody}`);
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: false }] }));

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'user file kept');
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), userBody, 'marker stripped, user body byte-exact');
});

test('eject: reverses an appended flat-ignore line byte-exact', () => {
  const cwd = project();
  writeFileSync(join(cwd, '.eslintignore'), 'coverage\n.forge/worktrees/\n');
  writeManifest(
    cwd,
    baseManifest({
      ignoreFiles: [
        { path: '.eslintignore', kind: 'line', created: false, priorEndedWithNewline: true, line: '.forge/worktrees/' },
      ],
    }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.equal(readFileSync(join(cwd, '.eslintignore'), 'utf8'), 'coverage\n', 'line removed byte-exact');
});

test('eject: dry-run plans without writing', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n`);
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: true }] }));

  const res = eject({ cwd }); // no confirm
  assert.equal(res.mode, 'dry-run');
  assert.ok(res.planned.length >= 2, 'plan lists items');
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'nothing written on dry-run');
  assert.ok(existsSync(join(cwd, '.forge')), '.forge intact on dry-run');
});

test('eject: refuses on a non-terminal task state', () => {
  const cwd = project();
  const taskDir = join(cwd, '.forge/orchestrator/tasks/FORGE-1');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: 'FORGE-1',
      state: 'running',
      state_version: 1,
      attempt_count: 1,
      current_attempt_id: 'a1',
      updated_at: '2026-05-30T00:00:00.000Z',
      updated_by: { run_id: 'r1', claim_id: 'c1', generation: 0 },
    }),
  );
  writeManifest(cwd, baseManifest());

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 1);
  assert.equal(res.mode, 'refused');
  assert.match(res.stderr, /active|running/i);
  assert.ok(existsSync(join(cwd, '.forge')), '.forge untouched on refusal');
});

test('eject: terminal task state does not block', () => {
  const cwd = project();
  const taskDir = join(cwd, '.forge/orchestrator/tasks/FORGE-2');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: 'FORGE-2',
      state: 'shipped',
      state_version: 5,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: '2026-05-30T00:00:00.000Z',
      updated_by: { run_id: 'r1', claim_id: 'c1', generation: 0 },
    }),
  );
  writeManifest(cwd, baseManifest());

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, `expected success, got: ${res.stderr}`);
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge removed (terminal state is inert)');
});

test('eject: backup + restore round-trips', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n`);
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
  writeManifest(
    cwd,
    baseManifest({
      rootFiles: [{ path: 'CLAUDE.md', forgeCreated: true }],
      ignoreFiles: [{ path: '.gitignore', kind: 'block', created: false, priorEndedWithNewline: true }],
    }),
  );

  const ej = eject({ cwd, confirm: true });
  assert.equal(ej.exitCode, 0);
  assert.ok(ej.backupDir && existsSync(ej.backupDir), 'backup dir created');
  assert.ok(!existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md removed by eject');
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge removed by eject');

  const re = eject({ cwd, restore: ej.backupDir! });
  assert.equal(re.exitCode, 0, `restore failed: ${re.stderr}`);
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md restored');
  assert.ok(existsSync(join(cwd, '.forge')), '.forge restored');
});

test('eject: a real .forge/.env secret survives backup + restore', () => {
  const cwd = project();
  const secret = 'LINEAR_API_KEY=lin_api_real_secret\n';
  writeFileSync(join(cwd, '.forge/.env'), secret);
  writeManifest(cwd, baseManifest());

  const ej = eject({ cwd, confirm: true });
  assert.equal(ej.exitCode, 0);
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge (incl. .env) removed by eject');

  const re = eject({ cwd, restore: ej.backupDir! });
  assert.equal(re.exitCode, 0, `restore failed: ${re.stderr}`);
  assert.equal(
    readFileSync(join(cwd, '.forge/.env'), 'utf8'),
    secret,
    'the credential file is restored byte-exact',
  );
});

test('eject --restore: refuses a directory without the backup marker', () => {
  const cwd = project();
  const notABackup = mkdtempSync(join(tmpdir(), 'not-a-backup-'));
  const res = eject({ cwd, restore: notABackup });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /not a forge eject backup/i);
});

test('eject: legacy mode (no manifest) strips marker but never deletes root file', () => {
  const cwd = project();
  // No manifest.json. settings.yaml drives enabledHosts in legacy derivation.
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: t',
      'tracker:',
      '  type: github',
      '  config:',
      '    repo: o/r',
      'secrets:',
      '  manager: env_file',
      '  env_file_path: ./.env.local',
      'agents:',
      '  primary_host_cli: claude',
      '  review_host_cli: codex',
      '  enabled_root_files:',
      '    - claude',
      'design:',
      '  mode: project_owned',
      '',
    ].join('\n'),
  );
  const userBody = '# Mine\n';
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n${userBody}`);

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.ok(res.warnings.some((w) => /legacy/i.test(w)), 'warns about legacy mode');
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), userBody, 'marker stripped, user body kept');
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge still removed in legacy mode');
});

test('eject: noop when no .forge directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-eject-empty-'));
  const res = eject({ cwd, confirm: true });
  assert.equal(res.mode, 'noop');
  assert.equal(res.exitCode, 0);
});

test('eject: never deletes a user-owned file even if reversal empties it (Codex impl #1)', () => {
  const cwd = project();
  // User owns an empty .gitignore; forge appended its block (created=false).
  writeFileSync(join(cwd, '.gitignore'), '');
  const block = '\n# >>> forge-managed (do not edit between markers) >>>\n/.forge/*\n# <<< forge-managed <<<\n';
  writeFileSync(join(cwd, '.gitignore'), block.trimStart());
  writeManifest(
    cwd,
    baseManifest({
      ignoreFiles: [{ path: '.gitignore', kind: 'block', created: false, priorEndedWithNewline: false }],
    }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.ok(existsSync(join(cwd, '.gitignore')), 'user .gitignore preserved (not deleted) even when emptied');
});

test('eject: refuses a manifest path that escapes the project (Codex impl #2)', () => {
  const cwd = project();
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: '../evil.txt', forgeCreated: true }] }));
  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 1);
  assert.equal(res.mode, 'refused');
  assert.match(res.stderr, /outside the project/i);
  assert.ok(existsSync(join(cwd, '.forge')), '.forge untouched on containment refusal');
});

test('eject: refuses on an unreadable/malformed state.json (Codex impl #3)', () => {
  const cwd = project();
  const taskDir = join(cwd, '.forge/orchestrator/tasks/FORGE-9');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'state.json'), '{ not valid json');
  writeManifest(cwd, baseManifest());

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /unreadable|unrecognized|active/i);
  assert.ok(existsSync(join(cwd, '.forge')), '.forge untouched — fail safe on unknown state');
});

test('eject: backup snapshot dir is created at repo root', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), `${MARKER}\n`);
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: true }] }));
  eject({ cwd, confirm: true });
  const backups = readdirSync(cwd).filter((e) => e.startsWith('.forge.eject-backup-'));
  assert.equal(backups.length, 1);
});

// ============================================================================
// FORGE-208 — symlinked forge-managed files are skipped, never destroyed
// ============================================================================

test('eject (FORGE-208 #9): symlinked CLAUDE.md is skipped with a warning — link intact, target untouched', async () => {
  const { lstatSync, readlinkSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  const targetBody = `${MARKER}\n# My Project\n\nreal content\n`;
  writeFileSync(join(cwd, 'real-claude.md'), targetBody);
  symlinkSync('real-claude.md', join(cwd, 'CLAUDE.md'));
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: false }] }));

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject completes despite the symlinked root file');
  assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), true, 'link intact');
  assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'real-claude.md');
  assert.equal(readFileSync(join(cwd, 'real-claude.md'), 'utf8'), targetBody, 'target untouched (marker NOT stripped through the link)');
  assert.ok(
    res.warnings.some((w) => /skipped: CLAUDE\.md is a symbolic link/.test(w)),
    `expected skip warning, got: ${res.warnings.join(' | ')}`,
  );
  assert.ok(!existsSync(join(cwd, '.forge')), '.forge still removed');
});

test('eject (FORGE-208): symlinked ignore file is skipped with a warning — link intact, target untouched', async () => {
  const { lstatSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  const targetBody = 'coverage\n.forge/worktrees/\n';
  writeFileSync(join(cwd, 'real-eslintignore'), targetBody);
  symlinkSync('real-eslintignore', join(cwd, '.eslintignore'));
  writeManifest(
    cwd,
    baseManifest({
      ignoreFiles: [
        { path: '.eslintignore', kind: 'line', created: false, priorEndedWithNewline: true, line: '.forge/worktrees/' },
      ],
    }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0);
  assert.equal(lstatSync(join(cwd, '.eslintignore')).isSymbolicLink(), true, 'link intact');
  assert.equal(readFileSync(join(cwd, 'real-eslintignore'), 'utf8'), targetBody, 'target untouched');
  assert.ok(
    res.warnings.some((w) => /skipped: \.eslintignore is a symbolic link/.test(w)),
    `expected skip warning, got: ${res.warnings.join(' | ')}`,
  );
});

test('eject: forge-created root file replaced by a symlink is NOT deleted (FORGE-208)', async () => {
  const { lstatSync, readlinkSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  // User replaced the forge-created CLAUDE.md with a symlink to AGENTS.md after
  // init (host-parity convention). eject must not delete the link.
  writeFileSync(join(cwd, 'AGENTS.md'), '# real agents file\n');
  symlinkSync('AGENTS.md', join(cwd, 'CLAUDE.md'));
  writeManifest(cwd, baseManifest({ rootFiles: [{ path: 'CLAUDE.md', forgeCreated: true }] }));

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject still succeeds');
  assert.equal(
    lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(),
    true,
    'symlink left intact — not deleted',
  );
  assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'AGENTS.md', 'link target unchanged');
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), '# real agents file\n', 'real file untouched');
  assert.ok(
    res.warnings.some((w) => w.includes('CLAUDE.md') && w.includes('symlink')),
    `expected a symlink-skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

test('eject: forge-created ignore file replaced by a symlink is NOT deleted (FORGE-208)', async () => {
  const { lstatSync, readlinkSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  writeFileSync(join(cwd, 'shared.ignore'), 'coverage\n');
  symlinkSync('shared.ignore', join(cwd, '.eslintignore'));
  writeManifest(
    cwd,
    baseManifest({
      ignoreFiles: [
        { path: '.eslintignore', kind: 'block', created: true, priorEndedWithNewline: true },
      ],
    }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject still succeeds');
  assert.equal(
    lstatSync(join(cwd, '.eslintignore')).isSymbolicLink(),
    true,
    'symlink left intact — not deleted',
  );
  assert.equal(readlinkSync(join(cwd, '.eslintignore')), 'shared.ignore', 'link target unchanged');
  assert.ok(
    res.warnings.some((w) => w.includes('.eslintignore') && w.includes('symlink')),
    `expected a symlink-skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

// ============================================================================
// FORGE-160 (round 2) — nested manifest rootFile under a symlinked PARENT dir.
// cursor's `.cursor/rules/forge-context.mdc` has a leaf that resolves to the
// symlink TARGET's regular file, so the leaf check passes and unlinkSync /
// writeAtomic reach THROUGH the symlinked `.cursor` parent into another tree.
// The parent guard must fire for BOTH forgeCreated kinds: skip + warn, leaving
// the link AND the target file intact.
// ============================================================================

test('eject (FORGE-160 parent): forgeCreated:true nested .mdc under symlinked `.cursor` is NOT deleted through the link', async () => {
  const { lstatSync, readlinkSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  // Out-of-tree target tree holding the real .mdc the link points into.
  const escape = mkdtempSync(join(tmpdir(), 'forge-eject-escape-'));
  mkdirSync(join(escape, 'rules'), { recursive: true });
  const targetMdc = join(escape, 'rules', 'forge-context.mdc');
  writeFileSync(targetMdc, '---\nforge: owned\n---\n');
  symlinkSync(escape, join(cwd, '.cursor'));
  writeManifest(
    cwd,
    baseManifest({ rootFiles: [{ path: '.cursor/rules/forge-context.mdc', forgeCreated: true }] }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject completes despite the symlinked parent');
  assert.equal(lstatSync(join(cwd, '.cursor')).isSymbolicLink(), true, '.cursor link intact');
  assert.equal(readlinkSync(join(cwd, '.cursor')), escape);
  assert.equal(existsSync(targetMdc), true, 'target .mdc NOT deleted through the symlinked parent');
  assert.ok(
    res.warnings.some(
      (w) => w.includes('.cursor/rules/forge-context.mdc') && w.includes('parent') && w.includes('symlink'),
    ),
    `expected a parent-symlink skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

test('eject (FORGE-160 parent): forgeCreated:false nested .mdc under symlinked `.cursor` is NOT stripped through the link', async () => {
  const { lstatSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  const escape = mkdtempSync(join(tmpdir(), 'forge-eject-escape-'));
  mkdirSync(join(escape, 'rules'), { recursive: true });
  const targetMdc = join(escape, 'rules', 'forge-context.mdc');
  const targetBody = `${MARKER}\n# user content in the target\n`;
  writeFileSync(targetMdc, targetBody);
  symlinkSync(escape, join(cwd, '.cursor'));
  writeManifest(
    cwd,
    baseManifest({ rootFiles: [{ path: '.cursor/rules/forge-context.mdc', forgeCreated: false }] }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject completes despite the symlinked parent');
  assert.equal(lstatSync(join(cwd, '.cursor')).isSymbolicLink(), true, '.cursor link intact');
  assert.equal(
    readFileSync(targetMdc, 'utf8'),
    targetBody,
    'target .mdc untouched (marker NOT stripped through the link)',
  );
  assert.ok(
    res.warnings.some(
      (w) => w.includes('.cursor/rules/forge-context.mdc') && w.includes('parent') && w.includes('symlink'),
    ),
    `expected a parent-symlink skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

// ============================================================================
// FORGE-160 (farm cleanup) — manifest-recorded farm entries under a symlinked
// PARENT dir. A recorded entry like `.agents/skills/forge` (cursor) or
// `.claude/skills/forge` (claude) whose PARENT `.agents` / `.claude` is a
// symlink would let rmSync delete OUTSIDE the working tree. The parent guard
// must fire per recorded entry: skip + warn, leaving the link AND the target
// intact. Proven for cursor AND claude so the guard is uniform.
// ============================================================================

test('eject (FORGE-160 farm): recorded entry under symlinked `.agents` (cursor) is NOT deleted through the link', async () => {
  const { lstatSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  // Out-of-tree dir `.agents` points into, holding the real farm entry.
  const escape = mkdtempSync(join(tmpdir(), 'forge-eject-escape-agents-'));
  mkdirSync(join(escape, 'skills', 'forge'), { recursive: true });
  const targetSkill = join(escape, 'skills', 'forge', 'SKILL.md');
  writeFileSync(targetSkill, '# forge skill in the link target — must survive\n');
  symlinkSync(escape, join(cwd, '.agents'));
  writeManifest(
    cwd,
    baseManifest({ farmEntries: [{ path: '.agents/skills/forge', mode: 'symlink' }] }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject completes despite the symlinked farm parent');
  assert.equal(lstatSync(join(cwd, '.agents')).isSymbolicLink(), true, '.agents link intact');
  assert.equal(existsSync(targetSkill), true, 'target farm entry NOT deleted through the link');
  assert.ok(
    res.warnings.some((w) => w.includes('.agents/skills/forge') && w.includes('symlink')),
    `expected a farm parent-symlink skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

test('eject (FORGE-160 farm): recorded entry under symlinked `.claude` proves the farm guard is uniform', async () => {
  const { lstatSync, symlinkSync } = await import('node:fs');
  const cwd = project();
  const escape = mkdtempSync(join(tmpdir(), 'forge-eject-escape-claude-'));
  mkdirSync(join(escape, 'skills', 'forge'), { recursive: true });
  const targetSkill = join(escape, 'skills', 'forge', 'SKILL.md');
  writeFileSync(targetSkill, '# forge skill in the link target — must survive\n');
  symlinkSync(escape, join(cwd, '.claude'));
  writeManifest(
    cwd,
    baseManifest({ farmEntries: [{ path: '.claude/skills/forge', mode: 'symlink' }] }),
  );

  const res = eject({ cwd, confirm: true, noBackup: true });
  assert.equal(res.exitCode, 0, 'eject completes despite the symlinked farm parent');
  assert.equal(lstatSync(join(cwd, '.claude')).isSymbolicLink(), true, '.claude link intact');
  assert.equal(existsSync(targetSkill), true, 'target farm entry NOT deleted through the link');
  assert.ok(
    res.warnings.some((w) => w.includes('.claude/skills/forge') && w.includes('symlink')),
    `expected a farm parent-symlink skip warning, got: ${JSON.stringify(res.warnings)}`,
  );
});

test('eject: removes the GLOBAL ~/.claude tripwire-hook entry (injected fake home)', () => {
  const cwd = project();
  writeManifest(cwd, baseManifest());

  // A fake home with the tripwire-hook installed alongside a user hook.
  const home = mkdtempSync(join(tmpdir(), 'forge-eject-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] },
          { matcher: 'WebFetch|WebSearch|mcp__.*', hooks: [{ type: 'command', command: 'forge tripwire-hook', timeout: 10 }] },
        ],
      },
    }),
    'utf8',
  );

  const res = eject({ cwd, confirm: true, noBackup: true, hostConfigHomeDir: home });
  assert.equal(res.exitCode, 0);

  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
    hooks: { PostToolUse: Array<{ matcher: string }> };
  };
  assert.equal(settings.hooks.PostToolUse.length, 1, 'only the user hook remains');
  assert.equal(settings.hooks.PostToolUse[0]!.matcher, 'Bash');
});
