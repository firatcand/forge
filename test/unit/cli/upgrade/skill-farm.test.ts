import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
  applySkillFarm,
  type FarmMode,
} from '../../../../src/cli/upgrade/skill-farm.ts';

// Build a fake forge package layout under `root`:
//   <root>/skills/<name>/SKILL.md      — bundled skill (directory)
//   <root>/agents/<name>.md             — bundled agent (file)
// Returns the package root path.
function makeFakePackage(
  root: string,
  skills: readonly string[],
  agents: readonly string[],
): string {
  mkdirSync(resolve(root, 'skills'), { recursive: true });
  mkdirSync(resolve(root, 'agents'), { recursive: true });
  for (const name of skills) {
    const dir = resolve(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), `# ${name}\nFake skill body.\n`, 'utf8');
  }
  for (const name of agents) {
    writeFileSync(resolve(root, 'agents', `${name}.md`), `# ${name}\nFake agent body.\n`, 'utf8');
  }
  return root;
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), 'forge-skill-farm-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Helpers — derive the per-host expected paths inside `cwd`.
function expectedSkill(cwd: string, host: 'claude' | 'codex' | 'gemini', name: string): string {
  const subdir = host === 'claude' ? '.claude' : host === 'codex' ? '.codex' : '.gemini';
  return resolve(cwd, subdir, 'skills', name);
}
function expectedAgent(cwd: string, host: 'claude' | 'codex' | 'gemini', name: string): string {
  const subdir = host === 'claude' ? '.claude' : host === 'codex' ? '.codex' : '.gemini';
  return resolve(cwd, subdir, 'agents', `${name}.md`);
}

test('applySkillFarm: symlink mode — creates per-host pointers for each enabled agent', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'pickup-task'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude', 'codex'],
      mode: 'symlink',
    });

    assert.equal(result.mode, 'symlink');
    // 2 skills × 2 hosts + 1 agent × 2 hosts = 6 created.
    assert.equal(result.created.length, 6, `created=${JSON.stringify(result.created)}`);
    assert.equal(result.refreshed.length, 0);
    assert.equal(result.skipped.length, 0);

    // Spot-check Claude skill symlink resolves to the bundled skill dir.
    const claudeForgePath = expectedSkill(cwd, 'claude', 'forge');
    assert.ok(existsSync(claudeForgePath), '.claude/skills/forge exists');
    assert.ok(lstatSync(claudeForgePath).isSymbolicLink(), 'is a symlink');
    // Symlink target is relative to its parent dir — verify it resolves.
    const resolved = readFileSync(resolve(claudeForgePath, 'SKILL.md'), 'utf8');
    assert.match(resolved, /Fake skill body/);

    // Spot-check Codex agent symlink resolves to the bundled agent file.
    const codexCodeReviewer = expectedAgent(cwd, 'codex', 'code-reviewer');
    assert.ok(existsSync(codexCodeReviewer), '.codex/agents/code-reviewer.md exists');
    assert.ok(lstatSync(codexCodeReviewer).isSymbolicLink());
    assert.match(readFileSync(codexCodeReviewer, 'utf8'), /Fake agent body/);

    // Gemini was NOT enabled — its dir should not exist.
    assert.equal(existsSync(resolve(cwd, '.gemini')), false, '.gemini/ should not be created');
  });
});

test('applySkillFarm: idempotent — second call with same inputs returns all skipped', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const first = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });
    assert.equal(first.created.length, 1);

    const second = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });
    assert.equal(second.created.length, 0);
    assert.equal(second.refreshed.length, 0);
    assert.equal(second.skipped.length, 1, 'second run skips the matching link');
  });
});

test('applySkillFarm: replace-if-mismatched — existing symlink with wrong target is backed up and rewritten', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(resolve(cwd, '.claude/skills'), { recursive: true });

    // Pre-create a symlink pointing somewhere else.
    const decoyTarget = resolve(tmp, 'decoy');
    mkdirSync(decoyTarget);
    writeFileSync(resolve(decoyTarget, 'SKILL.md'), '# decoy\n');
    symlinkSync(decoyTarget, resolve(cwd, '.claude/skills/forge'), 'dir');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    assert.equal(result.refreshed.length, 1, 'mismatched link is refreshed');
    assert.equal(result.created.length, 0);
    // Backup created.
    assert.ok(existsSync(resolve(cwd, '.claude/skills/forge.bak')), '.bak created');
    // New link points to bundled skill.
    const newLink = resolve(cwd, '.claude/skills/forge');
    assert.match(readFileSync(resolve(newLink, 'SKILL.md'), 'utf8'), /Fake skill body/);
  });
});

test('applySkillFarm: replace-if-mismatched — pre-existing .bak is overwritten without crash', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(resolve(cwd, '.claude/skills'), { recursive: true });

    // Stale .bak from a previous refresh.
    writeFileSync(resolve(cwd, '.claude/skills/forge.bak'), 'old-bak\n');
    // And a current real-file entry that needs replacing.
    writeFileSync(resolve(cwd, '.claude/skills/forge'), 'real-file-not-symlink\n');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    assert.equal(result.refreshed.length, 1);
    // New .bak holds the most recent pre-refresh state (the real file), not the stale one.
    assert.equal(
      readFileSync(resolve(cwd, '.claude/skills/forge.bak'), 'utf8'),
      'real-file-not-symlink\n',
    );
  });
});

test('applySkillFarm: copy mode — materializes via recursive copy (Windows fallback)', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(
      resolve(tmp, 'pkg'),
      ['skill-with-nested'],
      ['agent-one'],
    );
    // Add a nested file inside the skill dir to verify recursive copy.
    mkdirSync(resolve(pkg, 'skills/skill-with-nested/nested'));
    writeFileSync(
      resolve(pkg, 'skills/skill-with-nested/nested/data.txt'),
      'nested-data\n',
    );
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'copy',
    });

    assert.equal(result.mode, 'copy');
    assert.equal(result.created.length, 2, 'one skill + one agent created');

    // Copies are real files/dirs, not symlinks.
    const skillPath = expectedSkill(cwd, 'claude', 'skill-with-nested');
    assert.ok(existsSync(skillPath));
    assert.equal(lstatSync(skillPath).isSymbolicLink(), false, 'copy mode: NOT a symlink');
    assert.match(readFileSync(resolve(skillPath, 'SKILL.md'), 'utf8'), /Fake skill body/);
    // Recursive copy preserved the nested file.
    assert.equal(
      readFileSync(resolve(skillPath, 'nested/data.txt'), 'utf8'),
      'nested-data\n',
    );

    const agentPath = expectedAgent(cwd, 'claude', 'agent-one');
    assert.ok(existsSync(agentPath));
    assert.equal(lstatSync(agentPath).isSymbolicLink(), false);
  });
});

test('applySkillFarm: dryRun — reports plan without writing to disk', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
      dryRun: true,
    });

    // Plan reports creations.
    assert.equal(result.created.length, 2);
    // But nothing actually exists on disk.
    assert.equal(existsSync(resolve(cwd, '.claude')), false, 'dryRun: no .claude/ created');
  });
});

test('applySkillFarm: empty packageRoot (no skills/agents subdirs) — no-op without crashing', () => {
  withTmpDir((tmp) => {
    const pkg = resolve(tmp, 'pkg');
    mkdirSync(pkg);
    // No skills/ or agents/ subdir — adopters' tarball may have been pruned.
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    assert.equal(result.created.length, 0);
    assert.equal(result.refreshed.length, 0);
    assert.equal(result.skipped.length, 0);
  });
});

test('applySkillFarm: gemini host enabled — creates .gemini/skills/ and .gemini/agents/', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['gemini'],
      mode: 'symlink',
    });

    assert.equal(result.created.length, 2);
    assert.ok(existsSync(expectedSkill(cwd, 'gemini', 'forge')));
    assert.ok(existsSync(expectedAgent(cwd, 'gemini', 'code-reviewer')));
    // The other hosts must NOT be created.
    assert.equal(existsSync(resolve(cwd, '.claude')), false);
    assert.equal(existsSync(resolve(cwd, '.codex')), false);
  });
});

test('applySkillFarm: created paths use the project cwd, not the package root', () => {
  // Codex review guard: a bug where applyOne resolved against packageRoot
  // would surface here as paths that don't start with the project's `cwd`.
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj-deep', 'sub');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    // applySkillFarm canonicalizes cwd via realpath (macOS /tmp → /private/tmp).
    // Compare against the canonical form to match.
    const canonicalCwd = realpathSync(cwd);
    for (const p of result.created) {
      assert.ok(
        p.startsWith(`${canonicalCwd}${sep}`),
        `created path should start with canonical cwd ${canonicalCwd}; got: ${p}`,
      );
    }
  });
});
