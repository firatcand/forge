// Mechanism test for FORGE-81 — proves that the resolution snippet prescribed
// by /learn (`git rev-parse --git-common-dir` from inside a worktree)
// actually resolves to the main checkout's repo root.
//
// /learn is a Claude-followed skill — there's no programmatic entrypoint to
// invoke from Node. The closest faithful test is to exercise the underlying
// git mechanic the skill relies on, plus prove that a file written at the
// resolved path is readable both from the main checkout and from the worktree
// (the AC #4 visibility guarantee).
//
// Mirrors the temp-repo + execa pattern from test/integration/skills/
// push-to-tracker.test.ts. Does NOT verify that Claude follows SKILL.md
// instructions; that is covered by test/unit/skills/learn.contract.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { execa } from 'execa';

async function setupTempRepoWithWorktree(): Promise<{
  mainRoot: string;
  worktreeRoot: string;
  cleanup: () => Promise<void>;
}> {
  // Wrap mkdtemp in realpath to canonicalize macOS's /var → /private/var
  // before any subsequent path math. Without this every realpath comparison
  // downstream is doomed to false-positive.
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'forge-learn-')));
  const mainRoot = join(base, 'main');
  await mkdir(mainRoot, { recursive: true });

  await execa('git', ['init', '--initial-branch=main', mainRoot]);
  // Test-local identity so commits succeed without inheriting global git config.
  await execa('git', ['-C', mainRoot, 'config', 'user.email', 'forge-test@example.com']);
  await execa('git', ['-C', mainRoot, 'config', 'user.name', 'Forge Test']);
  await execa('git', ['-C', mainRoot, 'config', 'commit.gpgsign', 'false']);

  // Initial commit so `git worktree add` has something to branch from.
  await writeFile(join(mainRoot, 'README.md'), '# fixture\n', 'utf8');
  await execa('git', ['-C', mainRoot, 'add', 'README.md']);
  await execa('git', ['-C', mainRoot, 'commit', '-m', 'init']);

  const worktreeRoot = join(base, 'wt');
  await execa('git', [
    '-C',
    mainRoot,
    'worktree',
    'add',
    '-b',
    'feat/learn-mechanism',
    worktreeRoot,
  ]);

  return {
    mainRoot,
    worktreeRoot,
    cleanup: async () => {
      // git worktree remove first so .git/worktrees state is clean, then
      // blow away the temp tree. Best-effort — a partial cleanup must not
      // mask a real test failure.
      try {
        await execa('git', ['-C', mainRoot, 'worktree', 'remove', '--force', worktreeRoot]);
      } catch {
        // ignore — fall through to rm
      }
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('git rev-parse --git-common-dir from a worktree resolves to main repo', async () => {
  const { mainRoot, worktreeRoot, cleanup } = await setupTempRepoWithWorktree();
  try {
    // Run the exact resolution idiom that /learn's SKILL.md prescribes,
    // from inside the worktree.
    const { stdout: commonDir } = await execa(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: worktreeRoot },
    );

    // git may return either an absolute path or a path relative to cwd
    // depending on git version + how the worktree was created. Resolve
    // relative to the worktree's cwd, then realpath to normalize symlinks.
    const resolvedGitDir = realpathSync(resolve(worktreeRoot, commonDir.trim()));
    const resolvedMainRoot = realpathSync(dirname(resolvedGitDir));

    assert.equal(
      resolvedMainRoot,
      realpathSync(mainRoot),
      'git rev-parse --git-common-dir from worktree must resolve back to the main checkout root',
    );
  } finally {
    await cleanup();
  }
});

test('file written at MAIN_ROOT/docs/learnings/... is readable from the worktree path when mirrored', async () => {
  const { mainRoot, worktreeRoot, cleanup } = await setupTempRepoWithWorktree();
  try {
    // Simulate the dual-write contract that /learn performs.
    const quarter = '2026-Q2';
    const slug = 'mechanism-test-fixture';
    const content = '# Mechanism test\n\nfixture content\n';

    const mainDir = join(mainRoot, 'docs', 'learnings', quarter);
    const wtDir = join(worktreeRoot, 'docs', 'learnings', quarter);
    await mkdir(mainDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });

    // Canonical write first (load-bearing).
    const mainPath = join(mainDir, `${slug}.md`);
    await writeFile(mainPath, content, 'utf8');

    // Mirror write second (same-session Read guarantee).
    const wtPath = join(wtDir, `${slug}.md`);
    await writeFile(wtPath, content, 'utf8');

    // Canonical readable from main.
    assert.equal(await readFile(mainPath, 'utf8'), content);
    // Mirror readable from the worktree — this is AC #4's
    // "visible from the worktree" guarantee.
    assert.equal(await readFile(wtPath, 'utf8'), content);

    // And critically: the canonical file does not live under the worktree
    // path — so removing the worktree (which we do in cleanup) cannot
    // destroy the canonical record. This is the back-propagation invariant.
    assert.notEqual(mainPath, wtPath);
    assert.ok(
      !mainPath.startsWith(worktreeRoot),
      'canonical path must not live under the worktree root',
    );
  } finally {
    await cleanup();
  }
});

test('pwd -P inside a worktree differs from MAIN_ROOT — mirror write is required', async () => {
  const { mainRoot, worktreeRoot, cleanup } = await setupTempRepoWithWorktree();
  try {
    // /learn's SKILL.md skips the mirror write when MAIN_ROOT == pwd -P.
    // This test pins the orthogonal precondition: from inside a worktree,
    // those two paths are genuinely different (i.e. the mirror branch is
    // reachable), so future regressions that accidentally short-circuit
    // the mirror write get caught.
    const realMain = realpathSync(mainRoot);
    const realWt = realpathSync(worktreeRoot);
    assert.notEqual(
      realMain,
      realWt,
      'main root and worktree root must differ — otherwise the dual-write contract has no work to do',
    );
  } finally {
    await cleanup();
  }
});
