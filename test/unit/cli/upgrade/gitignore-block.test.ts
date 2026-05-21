import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGitignoreBlock,
  hasGitignoreBlock,
} from '../../../../src/cli/upgrade/gitignore-block.ts';

test('applyGitignoreBlock: appends block to empty gitignore', () => {
  const result = applyGitignoreBlock('');
  assert.match(result, /# >>> forge-managed/);
  assert.match(result, /\/\.forge\/\*/);
  assert.match(result, /!\/\.forge\/settings\.yaml/);
  assert.match(result, /# <<< forge-managed/);
});

test('applyGitignoreBlock: appends block to existing gitignore with user rules above', () => {
  const original = 'node_modules\n.env\ndist/\n';
  const result = applyGitignoreBlock(original);
  assert.ok(result.startsWith(original), 'user rules preserved at top');
  assert.match(result, /# >>> forge-managed/);
});

test('applyGitignoreBlock: replaces existing block in place; user rules around it survive', () => {
  const original = `node_modules

# >>> forge-managed (do not edit between markers) >>>
/.forge/worktrees/
# <<< forge-managed <<<

dist/
`;
  const result = applyGitignoreBlock(original);
  assert.ok(result.includes('node_modules'));
  assert.ok(result.includes('dist/'));
  assert.match(result, /!\/\.forge\/settings\.yaml/);
  assert.doesNotMatch(result, /\.forge\/worktrees\//, 'old block content should be gone');
  const opens = result.match(/# >>> forge-managed/g) ?? [];
  assert.equal(opens.length, 1);
});

test('applyGitignoreBlock: idempotent', () => {
  const once = applyGitignoreBlock('');
  const twice = applyGitignoreBlock(once);
  assert.equal(twice, once);
});

test('applyGitignoreBlock: handles gitignore that does NOT end with newline', () => {
  const original = 'node_modules\n.env';
  const result = applyGitignoreBlock(original);
  assert.ok(result.startsWith('node_modules\n.env'), 'user rules preserved');
  assert.match(result, /# >>> forge-managed/);
});

test('applyGitignoreBlock: preserves user .forge exception rules outside the block', () => {
  // A user may have a !/.forge/something-else exception line outside the
  // marker block. Marker-delimited replacement must NOT touch it.
  const original = `node_modules
!/.forge/my-custom-thing
dist/
`;
  const result = applyGitignoreBlock(original);
  assert.ok(result.includes('!/.forge/my-custom-thing'), 'user exception survives');
});

test('hasGitignoreBlock: true when marker present, false when absent', () => {
  assert.equal(hasGitignoreBlock(''), false);
  assert.equal(hasGitignoreBlock('node_modules\n'), false);
  assert.equal(hasGitignoreBlock(applyGitignoreBlock('')), true);
});
