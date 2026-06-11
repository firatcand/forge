import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { runOrchestrateGc } from '../../../src/cli/orchestrate/gc.ts';
import { create } from '../../../src/core/workspace.ts';

// Contract test for skills/wrap-up/SKILL.md (FORGE-116), in the FORGE-93
// pattern. The skill is host-executed markdown, so its safety contract can't be
// exercised at runtime — this pins the clauses a future edit must not drop, and
// cross-checks every CLI surface it references against the real implementations.
//
// Crucially (per the plan): we do NOT only grep source for the gc flag. We
// invoke the gc handler with --remove-worktrees --dry-run --json against a tiny
// real-git fixture and assert the planner envelope shape the skill consumes.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SKILL = readFileSync(join(ROOT, 'skills', 'wrap-up', 'SKILL.md'), 'utf8');

test('frontmatter is well-formed and named wrap-up', () => {
  assert.match(SKILL, /^---\nname: wrap-up\n/);
  assert.match(SKILL, /\ndescription: .+/);
  assert.match(SKILL, /\ntools: .+/);
});

test('safety clauses are present with distinctive headings (contract-pinned)', () => {
  // Unmerged-abort: the merged gate runs before anything is deleted.
  assert.match(SKILL, /### Unmerged-abort gate/);
  assert.match(SKILL, /NOTHING is deleted/);
  // Confirmation-before-destruction: explicit confirm before destructive ops.
  assert.match(SKILL, /### Confirmation-before-destruction gate/);
  // ff-only refusal on dirty main: porcelain shown verbatim, no override.
  assert.match(SKILL, /### ff-only refusal on dirty main/);
  assert.match(SKILL, /git status --porcelain/);
  assert.match(SKILL, /--ff-only/);
  // -D second-confirm: force delete only behind a second confirmation.
  assert.match(SKILL, /### -D second-confirm/);
  assert.match(SKILL, /git branch -d <branch>/);
  assert.match(SKILL, /git branch -D/);
});

test('flow references the verb, reconcile --pull, gh merged gate, and --all', () => {
  // Candidate discovery via the verb's own planner (delta 1) — not phases.yaml grep.
  assert.match(SKILL, /forge orchestrate gc --remove-worktrees --dry-run --json/);
  // Marker-file-first task detection.
  assert.match(SKILL, /\.forge\/worktree-task\.json/);
  // PR-merged gate via gh.
  assert.match(SKILL, /gh pr view <branch> --json state,mergedAt/);
  // Reconcile pull.
  assert.match(SKILL, /forge orchestrate reconcile --pull/);
  // Execute step removes via the verb.
  assert.match(SKILL, /forge orchestrate gc --remove-worktrees --task <id>/);
  // --all batch mode.
  assert.match(SKILL, /--all/);
  // Planner envelope must document the `absent` field (fix 3 — noop distinguishable from refused).
  assert.match(SKILL, /absent/);
});

test('registry lists /wrap-up so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'wrap-up'));
});

test('gc CLI_VERBS summary mentions the --remove-worktrees mode', async () => {
  const { CLI_VERBS } = await import('../../../src/cli/registry.ts');
  const gc = CLI_VERBS.find((v) => v.name === 'gc');
  assert.ok(gc);
  assert.match(gc!.summary, /--remove-worktrees/);
});

// ── The referenced verb flag REALLY parses: invoke the planner, assert envelope ──

async function initRepo(repoDir: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', repoDir], { reject: true });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, reject: true });
  writeFileSync(join(repoDir, 'README.md'), '# test\n');
  await execa('git', ['add', '.'], { cwd: repoDir, reject: true });
  await execa('git', ['commit', '-m', 'init'], { cwd: repoDir, reject: true });
}

test('gc --remove-worktrees --dry-run --json emits the planner envelope the skill consumes', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'forge-wrapup-contract-'));
  try {
    await initRepo(repoDir);
    const forgeDir = join(repoDir, '.forge');
    const root = join(forgeDir, 'worktrees');
    mkdirSync(root, { recursive: true });

    // One eligible worktree (shipped) + state.json.
    await create('WUC-1', { root, base: 'main', copyMeta: false, mainWorktree: repoDir });
    const taskDir = join(forgeDir, 'orchestrator', 'tasks', 'WUC-1');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'state.json'),
      JSON.stringify({
        version: 1,
        task_id: 'WUC-1',
        state: 'shipped',
        state_version: 1,
        attempt_count: 1,
        current_attempt_id: null,
        updated_at: '2026-05-15T00:00:00.000Z',
        updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
      }, null, 2) + '\n',
    );

    const result = await runOrchestrateGc({
      forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WUC-1',
      dryRun: true,
      json: true,
    });

    assert.equal(result.exitCode, 0);
    const env = result.removeWorktrees;
    assert.ok(env, 'envelope present');
    assert.equal(env!.dryRun, true);
    assert.equal(env!.results, undefined, 'dry-run has no results');
    // Planner envelope: { eligible: [{task_id, worktree_path, branch, state}], refused: [...], absent: [...] }
    assert.equal(env!.eligible.length, 1);
    const e = env!.eligible[0]!;
    assert.deepEqual(Object.keys(e).sort(), ['branch', 'state', 'task_id', 'worktree_path']);
    assert.equal(e.task_id, 'WUC-1');
    assert.equal(e.branch, 'feat/WUC-1');
    assert.equal(e.state, 'shipped');
    assert.ok(existsSync(e.worktree_path), 'worktree still present (dry-run deleted nothing)');
    assert.ok(Array.isArray(env!.refused));
    assert.ok(Array.isArray(env!.absent), 'absent list is present in envelope');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
