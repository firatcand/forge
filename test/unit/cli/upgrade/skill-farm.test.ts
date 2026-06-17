import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
  applySkillFarm,
  pruneHostFarm,
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

test('applySkillFarm: directories under skills/ that lack SKILL.md are excluded (Codex P3)', () => {
  // Forge ships `skills/_shared/` as an internal @import helper, not a skill.
  // Without the SKILL.md filter, _shared leaks into every adopter farm and
  // surfaces as an invalid skill in every host's discovery.
  withTmpDir((tmp) => {
    const pkg = resolve(tmp, 'pkg');
    mkdirSync(resolve(pkg, 'skills/real-skill'), { recursive: true });
    writeFileSync(resolve(pkg, 'skills/real-skill/SKILL.md'), '# real-skill\n');
    // Bundled helper — directory exists but no SKILL.md.
    mkdirSync(resolve(pkg, 'skills/_shared'));
    writeFileSync(resolve(pkg, 'skills/_shared/helper.md'), '# helper\n');
    mkdirSync(resolve(pkg, 'agents'));

    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    // Only the real skill should be in the farm — _shared is filtered.
    assert.equal(result.created.length, 1, `expected 1 farm entry, got ${result.created.length}`);
    assert.ok(
      result.created[0]!.endsWith('.claude/skills/real-skill'),
      `expected real-skill; got ${result.created[0]}`,
    );
    assert.equal(
      existsSync(resolve(cwd, '.claude/skills/_shared')),
      false,
      '_shared must NOT be materialized into the farm',
    );
  });
});

test('pruneHostFarm: removes forge-owned symlinks for bundled entries', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'plan-task'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    // Use applySkillFarm to create the farm state we'd actually prune —
    // real forge-owned symlinks with the canonical relative target.
    applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['codex'],
      mode: 'symlink',
    });
    // Adopter's project-level Codex config the prune must leave alone.
    writeFileSync(resolve(cwd, '.codex/config.toml'), 'model = "o3"\n');

    const { removed } = pruneHostFarm({ cwd, host: 'codex', packageRoot: pkg });

    assert.deepEqual(
      [...removed].sort(),
      ['.codex/agents/code-reviewer.md', '.codex/skills/forge', '.codex/skills/plan-task'],
    );
    assert.equal(existsSync(resolve(cwd, '.codex/skills/forge')), false);
    assert.equal(existsSync(resolve(cwd, '.codex/skills/plan-task')), false);
    assert.equal(existsSync(resolve(cwd, '.codex/agents/code-reviewer.md')), false);
    assert.ok(existsSync(resolve(cwd, '.codex/config.toml')), 'unrelated .codex/ content preserved');
  });
});

test('pruneHostFarm: user-owned skills/agents with DIFFERENT names survive the prune (Codex P1)', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    // Forge-owned symlinks (forge, code-reviewer).
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });

    // User-authored content under non-bundled names.
    mkdirSync(resolve(cwd, '.claude/skills/my-custom-skill'), { recursive: true });
    writeFileSync(
      resolve(cwd, '.claude/skills/my-custom-skill/SKILL.md'),
      '# user-authored skill — must survive\n',
    );
    writeFileSync(
      resolve(cwd, '.claude/agents/my-custom-agent.md'),
      '# user-authored agent — must survive\n',
    );

    pruneHostFarm({ cwd, host: 'claude', packageRoot: pkg });

    assert.equal(existsSync(resolve(cwd, '.claude/skills/forge')), false);
    assert.equal(existsSync(resolve(cwd, '.claude/agents/code-reviewer.md')), false);
    assert.ok(existsSync(resolve(cwd, '.claude/skills/my-custom-skill')));
    assert.ok(existsSync(resolve(cwd, '.claude/agents/my-custom-agent.md')));
  });
});

test('pruneHostFarm: user-EJECTED skill at bundled name (real dir replacing symlink) survives (Codex P2 round 3)', () => {
  // The trickier edge case: user ejected forge's `forge` skill by replacing
  // the symlink with their own real directory using the SAME name. Without
  // provenance verification, the prune deletes their work just because the
  // basename matches a bundled entry. The isForgeOwnedSymlink check is the
  // load-bearing guard here.
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'plan-task'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    // Start with the full farm…
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });
    // …then EJECT `.claude/skills/forge` (rm symlink, replace with real dir).
    rmSync(resolve(cwd, '.claude/skills/forge'));
    mkdirSync(resolve(cwd, '.claude/skills/forge'));
    writeFileSync(
      resolve(cwd, '.claude/skills/forge/SKILL.md'),
      '# user override of forge — must survive --remove-agent\n',
    );
    // Also eject by re-symlinking elsewhere — also a "not forge-owned" case.
    const decoy = resolve(tmp, 'decoy');
    mkdirSync(decoy);
    writeFileSync(resolve(decoy, 'SKILL.md'), '# decoy\n');
    rmSync(resolve(cwd, '.claude/skills/plan-task'));
    symlinkSync(decoy, resolve(cwd, '.claude/skills/plan-task'), 'dir');

    const { removed } = pruneHostFarm({ cwd, host: 'claude', packageRoot: pkg });

    // Both ejected entries survive — neither is a forge-owned symlink.
    assert.equal(removed.length, 0, `expected 0 removed (both ejected); got ${JSON.stringify(removed)}`);
    assert.ok(
      existsSync(resolve(cwd, '.claude/skills/forge')),
      'user-ejected skill at bundled name must survive',
    );
    assert.match(
      readFileSync(resolve(cwd, '.claude/skills/forge/SKILL.md'), 'utf8'),
      /user override/,
      'ejected content is intact',
    );
    assert.ok(
      existsSync(resolve(cwd, '.claude/skills/plan-task')),
      'user-re-symlinked skill at bundled name must survive',
    );
  });
});

test('pruneHostFarm: copy-mode entries are NOT pruned (Windows limitation)', () => {
  // Copies aren't distinguishable from user content post-hoc without a
  // manifest. For data safety, the prune skips them; the v0.3.0 CHANGELOG
  // documents this as a known limitation Windows adopters can work around
  // by manually rm'ing .X/skills/.
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'copy' });

    const { removed } = pruneHostFarm({ cwd, host: 'claude', packageRoot: pkg });

    assert.equal(removed.length, 0);
    assert.ok(existsSync(resolve(cwd, '.claude/skills/forge')), 'copy survives prune by design');
  });
});

test('pruneHostFarm: dryRun reports what would be removed without touching disk', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['gemini'], mode: 'symlink' });

    const { removed } = pruneHostFarm({ cwd, host: 'gemini', packageRoot: pkg, dryRun: true });

    assert.deepEqual([...removed], ['.gemini/skills/forge']);
    assert.ok(existsSync(resolve(cwd, '.gemini/skills/forge')), 'dryRun must not touch disk');
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

// ── FORGE-160: cursor host (.agents/skills + .cursor/agents) ──

test('FORGE-160 — applySkillFarm: cursor farms into .agents/skills + .cursor/agents', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'plan-task'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['cursor'],
      mode: 'symlink',
    });

    // 2 skills + 1 agent created.
    assert.equal(result.created.length, 3, `created=${JSON.stringify(result.created)}`);
    assert.ok(existsSync(resolve(cwd, '.agents/skills/forge')), '.agents/skills/forge exists');
    assert.ok(existsSync(resolve(cwd, '.agents/skills/plan-task')));
    assert.ok(existsSync(resolve(cwd, '.cursor/agents/code-reviewer.md')), '.cursor/agents/code-reviewer.md exists');
    assert.ok(lstatSync(resolve(cwd, '.agents/skills/forge')).isSymbolicLink());
    assert.match(readFileSync(resolve(cwd, '.agents/skills/forge/SKILL.md'), 'utf8'), /Fake skill body/);
  });
});

test('FORGE-160 — pruneHostFarm: cursor-alone prunes its .agents/skills entries', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['cursor'], mode: 'symlink' });

    // cursor is the only host → no shared root → prune everything forge-owned.
    const { removed } = pruneHostFarm({ cwd, host: 'cursor', packageRoot: pkg, enabledHosts: [] });
    assert.deepEqual([...removed].sort(), ['.agents/skills/forge', '.cursor/agents/code-reviewer.md']);
    assert.equal(existsSync(resolve(cwd, '.agents/skills/forge')), false);
    assert.equal(existsSync(resolve(cwd, '.cursor/agents/code-reviewer.md')), false);
  });
});

test('FORGE-160 — pruneHostFarm shared-root safety: removing claude while cursor stays enabled isolates the prune', () => {
  // No two PRODUCTION hosts share a skills/agents root today (cursor uses
  // .agents/skills + .cursor/agents; the others use .X/skills + .X/agents), so
  // the shared-root SKIP branch is future-proofing for a hypothetical second
  // host on .agents/skills. This test proves the guard does NOT over-skip: with
  // a survivor (cursor) that shares NO root with the pruned host (claude),
  // claude's entries are fully removed and cursor's are untouched.
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude', 'cursor'], mode: 'symlink' });

    const { removed } = pruneHostFarm({ cwd, host: 'claude', packageRoot: pkg, enabledHosts: ['cursor'] });
    assert.deepEqual([...removed].sort(), ['.claude/agents/code-reviewer.md', '.claude/skills/forge']);
    assert.equal(existsSync(resolve(cwd, '.claude/skills/forge')), false);
    assert.ok(existsSync(resolve(cwd, '.agents/skills/forge')), "cursor's shared-style farm untouched");
    assert.ok(existsSync(resolve(cwd, '.cursor/agents/code-reviewer.md')));
  });
});

// ── FORGE-160: symlink guard — farm dir component is a symlink ──
// A symlinked `.agents` / `.agents/skills` / `.cursor/agents` (cursor) — and
// equally a symlinked `.claude` (claude, proving the guard is uniform, not
// cursor-special) — would let forge create/rename/delete OUTSIDE the working
// tree. apply must SKIP with a notice; prune must SKIP with a notice; nothing
// is ever written/deleted through the link, and the out-of-tree target is
// left intact.

test('FORGE-160 symlink guard — applySkillFarm: symlinked .agents (cursor skills root parent) skips with notice', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    // Out-of-tree dir the adopter symlinked `.agents` to (e.g. dotfiles repo).
    const outside = resolve(tmp, 'dotfiles-agents');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(cwd, '.agents'), 'dir');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['cursor'],
      mode: 'symlink',
    });

    // Skills farm (.agents/skills) skipped; agents farm (.cursor/agents) still applied.
    assert.ok(
      result.notices.some((n) => n.includes('.agents') && n.includes('skill farm')),
      `expected a skills-farm skip notice; got ${JSON.stringify(result.notices)}`,
    );
    assert.equal(
      result.created.filter((p) => p.includes(`${sep}skills${sep}`)).length,
      0,
      'no skill entries created',
    );
    // Nothing written through the link.
    assert.equal(existsSync(resolve(outside, 'skills')), false, 'out-of-tree target untouched');
    assert.equal(existsSync(resolve(outside, 'forge')), false);
    // The .cursor/agents farm (no symlinked component) is materialized normally.
    assert.ok(existsSync(resolve(cwd, '.cursor/agents/code-reviewer.md')), 'agent farm still applied');
  });
});

test('FORGE-160 symlink guard — applySkillFarm: symlinked .cursor/agents skips agent farm with notice', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    // Symlink the LEAF component `.cursor/agents` (parent `.cursor` is a real dir).
    mkdirSync(resolve(cwd, '.cursor'), { recursive: true });
    const outside = resolve(tmp, 'dotfiles-cursor-agents');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(cwd, '.cursor/agents'), 'dir');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['cursor'],
      mode: 'symlink',
    });

    assert.ok(
      result.notices.some((n) => n.includes('.cursor/agents') && n.includes('agent farm')),
      `expected an agent-farm skip notice; got ${JSON.stringify(result.notices)}`,
    );
    assert.equal(existsSync(resolve(outside, 'code-reviewer.md')), false, 'nothing written through link');
    // Skills farm (.agents/skills, no symlink) is materialized normally.
    assert.ok(existsSync(resolve(cwd, '.agents/skills/forge')), 'skill farm still applied');
  });
});

test('FORGE-160 symlink guard — applySkillFarm: symlinked .claude proves the guard is uniform (not cursor-special)', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    const outside = resolve(tmp, 'dotfiles-claude');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(cwd, '.claude'), 'dir');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
    });

    // BOTH skills and agents roots live under the symlinked `.claude` → both skipped.
    assert.equal(result.created.length, 0, `nothing created; got ${JSON.stringify(result.created)}`);
    assert.ok(
      result.notices.some((n) => n.includes('skill farm')) &&
        result.notices.some((n) => n.includes('agent farm')),
      `expected both skill + agent farm skip notices; got ${JSON.stringify(result.notices)}`,
    );
    assert.equal(existsSync(resolve(outside, 'skills')), false, 'nothing written through .claude link');
    assert.equal(existsSync(resolve(outside, 'agents')), false);
  });
});

test('FORGE-160 symlink guard — applySkillFarm: dry-run parity — symlinked root skips with notice, no writes', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    const outside = resolve(tmp, 'dotfiles-agents');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(cwd, '.agents'), 'dir');

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['cursor'],
      mode: 'symlink',
      dryRun: true,
    });

    assert.ok(
      result.notices.some((n) => n.includes('.agents') && n.includes('skill farm')),
      `dry-run must surface the same skip notice; got ${JSON.stringify(result.notices)}`,
    );
    assert.equal(existsSync(resolve(outside, 'skills')), false, 'dry-run wrote nothing through link');
  });
});

test('FORGE-160 symlink guard — pruneHostFarm: symlinked .agents skips skill-farm prune, target intact', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    // Out-of-tree dir with a sentinel file that must survive.
    const outside = resolve(tmp, 'dotfiles-agents');
    mkdirSync(resolve(outside, 'skills'), { recursive: true });
    writeFileSync(resolve(outside, 'skills', 'sentinel.txt'), 'do not delete\n');
    symlinkSync(outside, resolve(cwd, '.agents'), 'dir');

    const { removed, notices } = pruneHostFarm({
      cwd,
      host: 'cursor',
      packageRoot: pkg,
      enabledHosts: [],
    });

    // Skills root (.agents/skills) prune skipped; .cursor/agents prune unaffected.
    assert.ok(
      notices.some((n) => n.includes('.agents') && n.includes('skill farm')),
      `expected a skills-prune skip notice; got ${JSON.stringify(notices)}`,
    );
    assert.equal(
      removed.filter((p) => p.includes('skills')).length,
      0,
      'no skill entries removed through the link',
    );
    assert.ok(
      existsSync(resolve(outside, 'skills', 'sentinel.txt')),
      'out-of-tree target intact — never deleted through the link',
    );
  });
});

test('FORGE-160 symlink guard — pruneHostFarm: symlinked .claude proves the prune guard is uniform', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    const outside = resolve(tmp, 'dotfiles-claude');
    mkdirSync(resolve(outside, 'skills', 'forge'), { recursive: true });
    writeFileSync(resolve(outside, 'skills', 'forge', 'SKILL.md'), 'survive\n');
    symlinkSync(outside, resolve(cwd, '.claude'), 'dir');

    const { removed, notices } = pruneHostFarm({ cwd, host: 'claude', packageRoot: pkg });

    assert.equal(removed.length, 0, `nothing removed through .claude link; got ${JSON.stringify(removed)}`);
    assert.ok(
      notices.some((n) => n.includes('skill farm')) && notices.some((n) => n.includes('agent farm')),
      `expected both skill + agent prune skip notices; got ${JSON.stringify(notices)}`,
    );
    assert.ok(
      existsSync(resolve(outside, 'skills', 'forge', 'SKILL.md')),
      'out-of-tree target intact',
    );
  });
});

// ── prune-stale: a re-run after a skill/agent leaves the bundle ────────────────

test('applySkillFarm: prunes a forge-owned symlink whose skill left the bundle', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'models'], ['code-reviewer']);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });

    // First materialize with `models` present.
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });
    assert.ok(existsSync(expectedSkill(cwd, 'claude', 'models')), 'models linked initially');

    // Ship a new release: `models` is removed from the bundle.
    rmSync(resolve(pkg, 'skills', 'models'), { recursive: true, force: true });

    const result = applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });

    assert.ok(
      result.pruned.includes('.claude/skills/models'),
      `expected models pruned; got ${JSON.stringify(result.pruned)}`,
    );
    // The dangling symlink is gone; the surviving bundle skill stays.
    assert.ok(!existsSync(resolve(cwd, '.claude', 'skills', 'models')), 'models symlink removed');
    assert.ok(lstatSync(expectedSkill(cwd, 'claude', 'forge')).isSymbolicLink(), 'forge survives');
  });
});

test('applySkillFarm: prune leaves user content and .bak backups alone', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge'], []);
    const cwd = resolve(tmp, 'proj');
    const skillsDir = resolve(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // A user's own skill (real dir, non-bundle name) and a leftover backup.
    mkdirSync(resolve(skillsDir, 'my-skill'), { recursive: true });
    writeFileSync(resolve(skillsDir, 'my-skill', 'SKILL.md'), '# mine\n', 'utf8');
    writeFileSync(resolve(skillsDir, 'forge.bak'), 'old\n', 'utf8');

    const result = applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });

    assert.deepEqual(result.pruned, [], 'nothing forge-owned to prune');
    assert.ok(existsSync(resolve(skillsDir, 'my-skill', 'SKILL.md')), 'user skill untouched');
    assert.ok(existsSync(resolve(skillsDir, 'forge.bak')), '.bak backup untouched');
  });
});

test('applySkillFarm: dryRun reports the stale prune without deleting it', () => {
  withTmpDir((tmp) => {
    const pkg = makeFakePackage(resolve(tmp, 'pkg'), ['forge', 'models'], []);
    const cwd = resolve(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    applySkillFarm({ cwd, packageRoot: pkg, enabledAgents: ['claude'], mode: 'symlink' });
    rmSync(resolve(pkg, 'skills', 'models'), { recursive: true, force: true });

    const result = applySkillFarm({
      cwd,
      packageRoot: pkg,
      enabledAgents: ['claude'],
      mode: 'symlink',
      dryRun: true,
    });

    assert.ok(result.pruned.includes('.claude/skills/models'), 'dryRun still reports the prune');
    assert.ok(lstatSync(resolve(cwd, '.claude', 'skills', 'models')).isSymbolicLink(), 'symlink NOT deleted under dryRun');
  });
});
