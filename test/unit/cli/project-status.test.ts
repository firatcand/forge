import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { runProjectStatus } from '../../../src/cli/project-status.ts';
import { readBundledMethodologyVersion } from '../../../src/cli/upgrade/version-check.ts';
import { locatePackageRoot } from '../../../src/cli/upgrade/skill-farm.ts';
import { buildCursorRuleFile } from '../../../src/cli/upgrade/agent-root-files.ts';

function capture(): { stdout: PassThrough; out: () => string } {
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { stdout, out: () => chunks.join('') };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-status-'));
}

const MARKER_OPEN = '<!-- >>> forge-managed (do not edit between markers) >>> -->';
const MARKER_CLOSE = '<!-- <<< forge-managed <<< -->';

/** Minimal valid settings.yaml content. */
function writeSettings(cwd: string, body?: string): void {
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  writeFileSync(
    join(cwd, '.forge', 'settings.yaml'),
    body ??
      [
        'version: 1',
        'project:',
        '  name: testproj',
        'tracker:',
        '  type: linear',
        '  config:',
        '    team_id: t-123',
        'secrets:',
        '  manager: env_file',
        '  env_file_path: ./.env.local',
        'agents:',
        '  enabled_root_files:',
        '    - claude',
      ].join('\n'),
  );
}

function runJson(cwd: string): { exitCode: number; data: Record<string, unknown> } {
  const { stdout, out } = capture();
  const result = runProjectStatus({ cwd, rest: ['--json'], stdout });
  const parsed = JSON.parse(out());
  assert.equal(parsed.ok, true);
  return { exitCode: result.exitCode, data: parsed.data };
}

// AC: forge status prints a human-readable summary covering all sections.
test('human output renders all sections', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    const { stdout, out } = capture();
    const result = runProjectStatus({ cwd, rest: [], stdout });
    assert.equal(result.exitCode, 0);
    const text = out();
    assert.match(text, /Project: testproj \(forge-managed\)/);
    assert.match(text, /Forge version \(bundled \/ on-disk\)/);
    assert.match(text, /Enabled hosts: claude/);
    assert.match(text, /Agent root files:/);
    assert.match(text, /Specs:/);
    assert.match(text, /Plans:/);
    assert.match(text, /Tracker: linear \(configured\)/);
    assert.match(text, /Secrets: env_file \(configured\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: forge status --json prints a machine-parseable { ok, data } envelope.
test('--json emits a valid { ok, data } envelope', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    const { data, exitCode } = runJson(cwd);
    assert.equal(exitCode, 0);
    assert.equal((data.project as Record<string, unknown>).managedByForge, true);
    assert.equal((data.project as Record<string, unknown>).name, 'testproj');
    assert.equal((data.tracker as Record<string, unknown>).type, 'linear');
    assert.equal((data.secrets as Record<string, unknown>).manager, 'env_file');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: detects forge methodology version drift (bundled vs on-disk).
test('detects version drift and reports in-sync when matched', () => {
  const bundled = readBundledMethodologyVersion();

  const drifted = freshDir();
  try {
    writeSettings(drifted);
    writeFileSync(join(drifted, '.forge', '.version'), '0.0.1\n');
    const { data } = runJson(drifted);
    const v = data.forgeVersion as Record<string, unknown>;
    assert.equal(v.bundled, bundled);
    assert.equal(v.onDisk, '0.0.1');
    assert.equal(v.drift, 'older');
  } finally {
    rmSync(drifted, { recursive: true, force: true });
  }

  const synced = freshDir();
  try {
    writeSettings(synced);
    writeFileSync(join(synced, '.forge', '.version'), `${bundled}\n`);
    const { data } = runJson(synced);
    const v = data.forgeVersion as Record<string, unknown>;
    assert.equal(v.onDisk, bundled);
    assert.equal(v.drift, null);
  } finally {
    rmSync(synced, { recursive: true, force: true });
  }
});

// AC: counts forge-owned vs user-owned vs broken farm entries via provenance.
test('classifies farm entries by provenance', () => {
  // Canonicalize cwd the same way classifyHostFarm does (macOS /tmp →
  // /private/tmp), so the symlink's relative target matches what production
  // computes — otherwise the `..` depth differs by one and provenance misses.
  const cwd = realpathSync(freshDir());
  try {
    writeSettings(cwd);
    const packageRoot = realpathSync(locatePackageRoot());
    const skillsRoot = join(packageRoot, 'skills');
    // Pick a real bundled skill name to forge-symlink correctly.
    const bundledSkill = readdirSync(skillsRoot).find((n: string) => {
      try {
        return statSync(join(skillsRoot, n, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    });
    assert.ok(bundledSkill, 'expected at least one bundled skill');

    const farmDir = join(cwd, '.claude', 'skills');
    mkdirSync(farmDir, { recursive: true });

    // (a) forge-owned: symlink to the bundled source with the exact relative target.
    const forgeDest = join(farmDir, bundledSkill);
    symlinkSync(relative(farmDir, join(skillsRoot, bundledSkill)), forgeDest, 'dir');

    // (b) user-owned: a real directory the user added.
    mkdirSync(join(farmDir, 'my-own-skill'), { recursive: true });

    // (c) broken: symlink to a nonexistent target.
    symlinkSync(join(cwd, 'does-not-exist'), join(farmDir, 'dangling'), 'dir');

    const { data } = runJson(cwd);
    const farms = data.farms as Record<string, Record<string, number>>;
    const counts = farms['.claude/skills/'];
    assert.equal(counts.forgeOwned, 1);
    assert.equal(counts.userOwned, 1);
    assert.equal(counts.broken, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: detects forge marker + measures user-body bytes on agent root files.
test('reads agent root file markers and user-body bytes', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    const userBody = 'My project notes.\n';
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      `${MARKER_OPEN}\nforge stuff\n${MARKER_CLOSE}\n\n${userBody}`,
    );
    const { data } = runJson(cwd);
    const files = data.agentRootFiles as Record<string, Record<string, unknown>>;
    assert.equal(files['CLAUDE.md'].exists, true);
    assert.equal(files['CLAUDE.md'].hasForgeMarker, true);
    assert.equal(files['CLAUDE.md'].userBodyBytes, Buffer.byteLength(userBody, 'utf8'));
    assert.equal(files['GEMINI.md'].exists, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// FORGE-160 (GPT-5.5 review): cursor .mdc is `frontmatter + marker block`, both
// forge-owned. A pristine artifact must report 0 user bytes — the generic
// bodyWithoutPrefixBlock would miscount the frontmatter as user content.
test('FORGE-160: pristine cursor .mdc reports 0 user bytes (frontmatter not counted)', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    const mdc = buildCursorRuleFile(
      { repoUrl: 'https://github.com/firatcand/forge' },
      '# Forge methodology\n\nsome inlined context\n',
    );
    mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(cwd, '.cursor/rules/forge-context.mdc'), mdc);

    const { data } = runJson(cwd);
    const files = data.agentRootFiles as Record<string, Record<string, unknown>>;
    const info = files['.cursor/rules/forge-context.mdc'];
    assert.equal(info.exists, true);
    assert.equal(info.hasForgeMarker, true);
    assert.equal(info.userBodyBytes, 0, 'pristine cursor .mdc must report 0 user bytes');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('FORGE-160: cursor .mdc with one appended user line counts only that line', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    const base = buildCursorRuleFile(
      { repoUrl: 'https://github.com/firatcand/forge' },
      '# Forge methodology\n\nsome inlined context\n',
    );
    const userLine = 'my own note\n';
    mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(cwd, '.cursor/rules/forge-context.mdc'), `${base}\n${userLine}`);

    const { data } = runJson(cwd);
    const files = data.agentRootFiles as Record<string, Record<string, unknown>>;
    const info = files['.cursor/rules/forge-context.mdc'];
    assert.equal(info.userBodyBytes, Buffer.byteLength(userLine, 'utf8'), 'only the appended user line is counted');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: detects incomplete specs via placeholder section count.
test('counts spec placeholder sections', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    mkdirSync(join(cwd, 'spec'), { recursive: true });
    writeFileSync(
      join(cwd, 'spec', 'SPEC.md'),
      '# Spec\n<!-- REQUIRED: a -->\n<!-- REQUIRED: b -->\n<!-- TODO: c -->\n',
    );
    writeFileSync(join(cwd, 'spec', 'PRD.md'), '# PRD\nAll filled in.\n');
    const { data } = runJson(cwd);
    const specs = data.specs as Record<string, Record<string, unknown>>;
    assert.equal(specs['SPEC.md'].placeholderSectionCount, 3);
    assert.equal(specs['SPEC.md'].complete, false);
    assert.equal(specs['PRD.md'].placeholderSectionCount, 0);
    assert.equal(specs['PRD.md'].complete, true);
    assert.equal(specs['BRIEF.md'].exists, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: counts phases / tasks from phases.yaml.
test('counts phases and tasks from phases.yaml', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    mkdirSync(join(cwd, 'plans'), { recursive: true });
    writeFileSync(
      join(cwd, 'plans', 'phases.yaml'),
      [
        'phases:',
        '  - id: p1',
        '    tasks:',
        '      - id: t1',
        '      - id: t2',
        '  - id: p2',
        '    tasks:',
        '      - id: t3',
      ].join('\n'),
    );
    const { data } = runJson(cwd);
    const plans = data.plans as Record<string, Record<string, number | boolean>>;
    assert.equal(plans['phases.yaml'].exists, true);
    assert.equal(plans['phases.yaml'].phaseCount, 2);
    assert.equal(plans['phases.yaml'].taskCount, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: non-forge project returns managedByForge:false cleanly, exit 0.
test('non-forge project reports managedByForge:false and exits 0', () => {
  const cwd = freshDir();
  try {
    const { data, exitCode } = runJson(cwd);
    assert.equal(exitCode, 0);
    assert.equal((data.project as Record<string, unknown>).managedByForge, false);
    assert.equal(data.forgeVersion, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Edge: malformed settings.yaml degrades, never throws, exit 0.
test('malformed settings.yaml degrades cleanly', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd, 'version: 1\nthis: [is: not valid: yaml');
    const { data, exitCode } = runJson(cwd);
    assert.equal(exitCode, 0);
    assert.equal((data.project as Record<string, unknown>).managedByForge, true);
    assert.ok(typeof data.settingsError === 'string' && data.settingsError.length > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// AC: read-only — running status mutates nothing in the project tree.
test('is read-only: no files created or modified', () => {
  const cwd = freshDir();
  try {
    writeSettings(cwd);
    mkdirSync(join(cwd, 'spec'), { recursive: true });
    writeFileSync(join(cwd, 'spec', 'SPEC.md'), '<!-- REQUIRED: x -->\n');
    const before = snapshot(cwd);
    runProjectStatus({ cwd, rest: ['--json'], stdout: capture().stdout });
    runProjectStatus({ cwd, rest: [], stdout: capture().stdout });
    const after = snapshot(cwd);
    assert.deepEqual(after, before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Recursively snapshot path → mtimeMs for every entry under root.
function snapshot(root: string): Record<string, number> {
  const acc: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      acc[full] = st.mtimeMs;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return acc;
}
