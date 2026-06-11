import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract test for skills/pickup-task/SKILL.md (FORGE-70), in the FORGE-93 /
// wrap-up-contract pattern. The skill is host-executed markdown, so its
// behavior can't be exercised at runtime — this pins the clauses a future edit
// must not drop: the package-manager detection matrix for installing deps in a
// fresh worktree, and the gc/node_modules cleanup interaction.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SKILL = readFileSync(join(ROOT, 'skills', 'pickup-task', 'SKILL.md'), 'utf8');

test('pickup-task: frontmatter is well-formed and named pickup-task', () => {
  assert.match(SKILL, /^---\nname: pickup-task\n/);
});

test('pickup-task: instructs installing dependencies in the fresh worktree', () => {
  // The defect (FORGE-70): no install step → first build/test fails because
  // node_modules is gitignored and not hydrated.
  assert.match(SKILL, /node_modules/);
  assert.match(SKILL, /Install dependencies in the fresh worktree/i);
});

test('pickup-task: documents the package-manager detection matrix', () => {
  // Each lockfile → frozen-install command must be present.
  assert.match(SKILL, /package-lock\.json/);
  assert.match(SKILL, /npm ci/);
  assert.match(SKILL, /pnpm-lock\.yaml/);
  assert.match(SKILL, /pnpm install --frozen-lockfile/);
  assert.match(SKILL, /yarn\.lock/);
  assert.match(SKILL, /yarn install --immutable/);
  assert.match(SKILL, /bun\.lockb/);
  assert.match(SKILL, /bun install/);
});

test('pickup-task: notes the node_modules symlink alternative', () => {
  assert.match(SKILL, /symlink/i);
});

test('pickup-task: documents the gc/wrap-up node_modules cleanup interaction', () => {
  // A symlinked/installed node_modules is gitignored → gc --remove-worktrees
  // refuses with GITIGNORED_LOSS unless removed pre-cleanup.
  assert.match(SKILL, /GITIGNORED_LOSS/);
  assert.match(SKILL, /gc --remove-worktrees/);
  assert.match(SKILL, /wrap-up/i);
});
