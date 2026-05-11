import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { execa } from 'execa';

import {
  sanitizeIssueId,
  validateUnderRoot,
  create,
  cleanup,
  WorkspaceError,
} from '../../src/core/index.ts';

function tmpdir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`));
}

function rmrf(p: string): void {
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
  }
}

async function initRepo(repoDir: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', repoDir], { reject: true });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, reject: true });
  writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  await execa('git', ['add', '.'], { cwd: repoDir, reject: true });
  await execa('git', ['commit', '-m', 'init'], { cwd: repoDir, reject: true });
}

test('sanitizeIssueId — accepts FORGE-42', () => {
  assert.equal(sanitizeIssueId('FORGE-42'), 'FORGE-42');
});

test('sanitizeIssueId — accepts lowercase prefix lin-99', () => {
  assert.equal(sanitizeIssueId('lin-99'), 'lin-99');
});

test('sanitizeIssueId — accepts mixed allowed chars a.b-c_d', () => {
  assert.equal(sanitizeIssueId('a.b-c_d'), 'a.b-c_d');
});

test('sanitizeIssueId — accepts single char a', () => {
  assert.equal(sanitizeIssueId('a'), 'a');
});

test('sanitizeIssueId — accepts P1.T07', () => {
  assert.equal(sanitizeIssueId('P1.T07'), 'P1.T07');
});

test('sanitizeIssueId — accepts 64-char boundary', () => {
  const id = 'A'.repeat(64);
  assert.equal(sanitizeIssueId(id), id);
});

test('sanitizeIssueId — rejects empty string with EMPTY', () => {
  try {
    sanitizeIssueId('');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'EMPTY');
  }
});

test('sanitizeIssueId — rejects 65-char overflow with TOO_LONG', () => {
  try {
    sanitizeIssueId('A'.repeat(65));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'TOO_LONG');
  }
});

test('sanitizeIssueId — rejects leading dash with LEADING_DASH', () => {
  try {
    sanitizeIssueId('-leading-dash');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'LEADING_DASH');
  }
});

test('sanitizeIssueId — rejects ../etc/passwd with PATH_TRAVERSAL', () => {
  try {
    sanitizeIssueId('../etc/passwd');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'PATH_TRAVERSAL');
  }
});

test('sanitizeIssueId — rejects absolute path /abs/path with PATH_TRAVERSAL', () => {
  try {
    sanitizeIssueId('/abs/path');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'PATH_TRAVERSAL');
  }
});

test('sanitizeIssueId — rejects backslash path with PATH_TRAVERSAL', () => {
  try {
    sanitizeIssueId('foo\\bar');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'PATH_TRAVERSAL');
  }
});

test('sanitizeIssueId — rejects NUL byte with CONTROL_CHAR', () => {
  try {
    sanitizeIssueId('FORGE\x00null');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'CONTROL_CHAR');
  }
});

test('sanitizeIssueId — rejects DEL byte with CONTROL_CHAR', () => {
  try {
    sanitizeIssueId('FORGE\x7Fdel');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'CONTROL_CHAR');
  }
});

test('sanitizeIssueId — rejects space with INVALID_CHAR', () => {
  try {
    sanitizeIssueId('foo bar');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'INVALID_CHAR');
  }
});

test('sanitizeIssueId — rejects emoji with INVALID_CHAR', () => {
  try {
    sanitizeIssueId('FORGE-fire');
    // sanity: regular ASCII passes; switch to actually-emoji case
  } catch {
    assert.fail('regression: ASCII rejected');
  }
  try {
    sanitizeIssueId('FORGE-\u{1F525}');
    assert.fail('expected throw on emoji');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'INVALID_CHAR');
  }
});

test('sanitizeIssueId — rejects non-string input', () => {
  try {
    sanitizeIssueId(undefined as unknown as string);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'EMPTY');
  }
});

test('validateUnderRoot — clean path under root', () => {
  const root = tmpdir('vur-clean');
  try {
    const target = path.join(root, 'FD-1');
    const resolved = validateUnderRoot(target, root);
    assert.ok(resolved.endsWith(path.sep + 'FD-1'));
  } finally {
    rmrf(root);
  }
});

test('validateUnderRoot — rejects parent escape via ../', () => {
  const root = tmpdir('vur-parent');
  try {
    const target = path.join(root, '..', 'evil');
    try {
      validateUnderRoot(target, root);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'PATH_ESCAPE');
    }
  } finally {
    rmrf(root);
  }
});

test('validateUnderRoot — accepts absolute path already inside root', () => {
  const root = tmpdir('vur-abs');
  try {
    const inside = path.join(root, 'subdir');
    mkdirSync(inside);
    const resolved = validateUnderRoot(inside, root);
    assert.ok(resolved.endsWith('subdir'));
  } finally {
    rmrf(root);
  }
});

test('validateUnderRoot — rejects symlink redirect outside root', () => {
  const root = tmpdir('vur-symlink');
  const outsider = tmpdir('vur-outside');
  try {
    const linkPath = path.join(root, 'escape');
    symlinkSync(outsider, linkPath);
    try {
      validateUnderRoot(linkPath, root);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'PATH_ESCAPE');
    }
  } finally {
    rmrf(root);
    rmrf(outsider);
  }
});

test('validateUnderRoot — rejects sibling-prefix collision (foo vs foobar)', () => {
  const root = tmpdir('vur-prefix');
  try {
    const fooRoot = path.join(root, 'foo');
    mkdirSync(fooRoot);
    const sibling = path.join(root, 'foobar');
    mkdirSync(sibling);
    try {
      validateUnderRoot(sibling, fooRoot);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'PATH_ESCAPE');
    }
  } finally {
    rmrf(root);
  }
});

test('validateUnderRoot — throws NOT_FOUND when root does not exist', () => {
  const ghost = path.join(os.tmpdir(), `forge-ghost-${Date.now()}-${Math.random()}`);
  try {
    validateUnderRoot(path.join(ghost, 'x'), ghost);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceError);
    assert.equal((err as WorkspaceError).code, 'NOT_FOUND');
  }
});

test('create — spawns a worktree with default branch and copyMeta manifest', async () => {
  const repoDir = tmpdir('create-repo');
  try {
    await initRepo(repoDir);
    writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# claude\n');
    writeFileSync(path.join(repoDir, 'CRITICAL.md'), '# critical\n');
    mkdirSync(path.join(repoDir, 'spec'));
    writeFileSync(path.join(repoDir, 'spec', 'SPEC.md'), '# spec\n');
    writeFileSync(path.join(repoDir, 'spec', '.gitkeep'), '');
    mkdirSync(path.join(repoDir, 'plans', 'tasks'), { recursive: true });
    writeFileSync(path.join(repoDir, 'plans', 'tasks', 'FD-1.plan.md'), '# plan\n');
    mkdirSync(path.join(repoDir, 'docs', 'learnings'), { recursive: true });
    writeFileSync(path.join(repoDir, 'docs', 'learnings', 'l1.md'), '# learning\n');
    mkdirSync(path.join(repoDir, '.forge'));
    writeFileSync(path.join(repoDir, '.forge', 'settings.yaml'), 'version: 1\n');
    await execa('git', ['add', '.'], { cwd: repoDir, reject: true });
    await execa('git', ['commit', '-m', 'meta'], { cwd: repoDir, reject: true });

    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });

    const result = await create('FD-7', { root, base: 'main', mainWorktree: repoDir });
    assert.equal(result.branch, 'feat/FD-7');
    assert.ok(existsSync(result.path));
    assert.ok(result.manifestPath !== null);
    assert.ok(existsSync(result.manifestPath!));

    const manifest = JSON.parse(readFileSync(result.manifestPath!, 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.sourceMainWorktree, repoDir);
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.includes(path.join('spec', 'SPEC.md')));
    assert.ok(manifest.files.includes(path.join('plans', 'tasks', 'FD-1.plan.md')));
    assert.ok(manifest.files.includes(path.join('docs', 'learnings', 'l1.md')));
    assert.ok(manifest.files.includes('CLAUDE.md'));
    assert.ok(manifest.files.includes('CRITICAL.md'));
    assert.ok(manifest.files.includes(path.join('.forge', 'settings.yaml')));
    assert.ok(!manifest.files.some((f: string) => f.endsWith('.gitkeep')));

    assert.ok(existsSync(path.join(result.path, 'spec', 'SPEC.md')));
    assert.ok(existsSync(path.join(result.path, 'CLAUDE.md')));

    const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir });
    assert.ok(stdout.includes(result.path));
  } finally {
    try {
      await execa('git', ['worktree', 'remove', '--force', path.join(repoDir, '.forge', 'worktrees', 'FD-7')], {
        cwd: repoDir,
      });
    } catch {
      // ignore
    }
    rmrf(repoDir);
  }
});

test('create — copyMeta:false skips meta and writes no manifest', async () => {
  const repoDir = tmpdir('create-nometa');
  try {
    await initRepo(repoDir);
    writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# claude\n');
    await execa('git', ['add', '.'], { cwd: repoDir, reject: true });
    await execa('git', ['commit', '-m', 'meta'], { cwd: repoDir, reject: true });

    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });

    const result = await create('FD-8', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    assert.equal(result.manifestPath, null);
    assert.equal(result.copiedFiles.length, 0);
    assert.ok(!existsSync(path.join(result.path, '.forge', 'copied-from-main.json')));
  } finally {
    try {
      await execa('git', ['worktree', 'remove', '--force', path.join(repoDir, '.forge', 'worktrees', 'FD-8')], {
        cwd: repoDir,
      });
    } catch {
      // ignore
    }
    rmrf(repoDir);
  }
});

test('create — surfaces git failure as GIT_FAILURE on duplicate branch', async () => {
  const repoDir = tmpdir('create-dup');
  try {
    await initRepo(repoDir);
    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });
    await create('FD-9', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    try {
      await create('FD-9', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'GIT_FAILURE');
    }
  } finally {
    try {
      await execa('git', ['worktree', 'remove', '--force', path.join(repoDir, '.forge', 'worktrees', 'FD-9')], {
        cwd: repoDir,
      });
    } catch {
      // ignore
    }
    rmrf(repoDir);
  }
});

test('cleanup — removes a clean worktree', async () => {
  const repoDir = tmpdir('cleanup-clean');
  try {
    await initRepo(repoDir);
    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });
    const result = await create('FD-10', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    assert.ok(existsSync(result.path));

    // Write a gitignore so manifest doesn't trigger gitignored loss
    const cleanupResult = await cleanup('FD-10', { root });
    assert.equal(cleanupResult.removed, true);
    assert.equal(cleanupResult.gitignoredFilesLost, 0);
    assert.ok(!existsSync(result.path));
  } finally {
    rmrf(repoDir);
  }
});

test('cleanup — refuses on gitignored file loss without force', async () => {
  const repoDir = tmpdir('cleanup-ignored');
  try {
    await initRepo(repoDir);
    writeFileSync(path.join(repoDir, '.gitignore'), 'secret.txt\n');
    await execa('git', ['add', '.gitignore'], { cwd: repoDir, reject: true });
    await execa('git', ['commit', '-m', 'gitignore'], { cwd: repoDir, reject: true });

    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });
    const created = await create('FD-11', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    writeFileSync(path.join(created.path, 'secret.txt'), 'leaked\n');

    try {
      await cleanup('FD-11', { root });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'GITIGNORED_LOSS');
      assert.equal((err as WorkspaceError).details.count, 1);
      assert.deepEqual((err as WorkspaceError).details.files, ['secret.txt']);
    }

    const forced = await cleanup('FD-11', { root, force: true });
    assert.equal(forced.removed, true);
    assert.equal(forced.gitignoredFilesLost, 1);
    assert.ok(!existsSync(created.path));
  } finally {
    rmrf(repoDir);
  }
});

test('cleanup — throws NOT_FOUND when worktree path does not exist', async () => {
  const repoDir = tmpdir('cleanup-missing');
  try {
    await initRepo(repoDir);
    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });
    try {
      await cleanup('FD-MISSING', { root });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof WorkspaceError);
      assert.equal((err as WorkspaceError).code, 'NOT_FOUND');
    }
  } finally {
    rmrf(repoDir);
  }
});

test('cleanup — deletes branch when deleteBranch is true', async () => {
  const repoDir = tmpdir('cleanup-branch');
  try {
    await initRepo(repoDir);
    const root = path.join(repoDir, '.forge', 'worktrees');
    mkdirSync(root, { recursive: true });
    await create('FD-12', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    const result = await cleanup('FD-12', { root, deleteBranch: true });
    assert.equal(result.branchDeleted, true);
    const { stdout } = await execa('git', ['branch', '--list', 'feat/FD-12'], { cwd: repoDir });
    assert.equal(stdout.trim(), '');
  } finally {
    rmrf(repoDir);
  }
});
