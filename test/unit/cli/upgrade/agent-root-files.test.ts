import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrefixBlock,
  replacePrefixBlock,
  extractPrefixBlock,
  bodyWithoutPrefixBlock,
  ROOT_FILE_BY_AGENT,
} from '../../../../src/cli/upgrade/agent-root-files.ts';

const REPO_URL = 'https://github.com/firatcand/forge';

test('ROOT_FILE_BY_AGENT: claude → CLAUDE.md, codex → AGENTS.md, gemini → GEMINI.md', () => {
  assert.equal(ROOT_FILE_BY_AGENT.claude, 'CLAUDE.md');
  assert.equal(ROOT_FILE_BY_AGENT.codex, 'AGENTS.md');
  assert.equal(ROOT_FILE_BY_AGENT.gemini, 'GEMINI.md');
});

test('buildPrefixBlock: claude includes @import directive', () => {
  const block = buildPrefixBlock('claude', { repoUrl: REPO_URL });
  assert.match(block, /@\.forge\/CONTEXT\.md/);
  assert.match(block, /<!-- >>> forge-managed/);
  assert.match(block, /<!-- <<< forge-managed/);
});

test('buildPrefixBlock: claude calls out the first-run approval dialog (A2.5)', () => {
  // A2.5: Claude Code shows a one-time approval prompt the first time it
  // encounters an @-import. If users decline, imports are silently disabled
  // and they get a CLAUDE.md without methodology context — and don't know
  // it. The breadcrumb prose must call out the dialog explicitly.
  const block = buildPrefixBlock('claude', { repoUrl: REPO_URL });
  assert.match(
    block,
    /approve|approval|permission/i,
    'claude breadcrumb must mention the first-run approval dialog',
  );
});

test('buildPrefixBlock: codex uses prose directive (no @import)', () => {
  const block = buildPrefixBlock('codex', { repoUrl: REPO_URL });
  assert.doesNotMatch(block, /@\.forge/);
  assert.match(block, /read `\.forge\/CONTEXT\.md`/);
});

test('buildPrefixBlock: gemini uses prose directive (mirrors codex)', () => {
  const block = buildPrefixBlock('gemini', { repoUrl: REPO_URL });
  assert.doesNotMatch(block, /@\.forge/);
  assert.match(block, /read `\.forge\/CONTEXT\.md`/);
});

test('buildPrefixBlock: marker block has both open and close markers', () => {
  for (const agent of ['claude', 'codex', 'gemini'] as const) {
    const block = buildPrefixBlock(agent, { repoUrl: REPO_URL });
    assert.match(block, /<!-- >>> forge-managed/, `${agent} missing open marker`);
    assert.match(block, /<!-- <<< forge-managed/, `${agent} missing close marker`);
  }
});

test('replacePrefixBlock: prepends block when file has none', () => {
  const original = '# My Product\n\n## Stack\nTypeScript.\n';
  const block = '<!-- >>> forge-managed (do not edit between markers) >>> -->\nFORGE\n<!-- <<< forge-managed <<< -->\n';
  const result = replacePrefixBlock(original, block);
  assert.ok(result.startsWith(block), 'block should be prepended');
  assert.ok(result.includes('# My Product'), 'product content preserved');
});

test('replacePrefixBlock: replaces existing block in place', () => {
  const original = `<!-- >>> forge-managed (do not edit between markers) >>> -->
old content
<!-- <<< forge-managed <<< -->

# My Product

## Stack
TypeScript.
`;
  const block = `<!-- >>> forge-managed (do not edit between markers) >>> -->
new content
<!-- <<< forge-managed <<< -->
`;
  const result = replacePrefixBlock(original, block);
  assert.ok(result.includes('new content'));
  assert.ok(!result.includes('old content'));
  assert.ok(result.includes('# My Product'));
  assert.ok(result.includes('## Stack'));
});

test('replacePrefixBlock: preserves user content below second marker exactly', () => {
  const userContent = '# My Product\n\n## Stack\nTypeScript & React.\n## Tricks\nUse `pnpm`.\n';
  const original = `<!-- >>> forge-managed (do not edit between markers) >>> -->
old
<!-- <<< forge-managed <<< -->

${userContent}`;
  const newBlock = `<!-- >>> forge-managed (do not edit between markers) >>> -->
new
<!-- <<< forge-managed <<< -->
`;
  const result = replacePrefixBlock(original, newBlock);
  assert.ok(
    result.endsWith(userContent),
    `expected to end with user content, got: ${JSON.stringify(result.slice(-100))}`,
  );
});

test('replacePrefixBlock: empty file → just the block', () => {
  const block = '<!-- >>> forge-managed (do not edit between markers) >>> -->\nFORGE\n<!-- <<< forge-managed <<< -->\n';
  assert.equal(replacePrefixBlock('', block), block);
});

test('extractPrefixBlock: returns block when present', () => {
  const block = '<!-- >>> forge-managed (do not edit between markers) >>> -->\nFORGE\n<!-- <<< forge-managed <<< -->\n';
  const file = `${block}\n# Product`;
  assert.equal(extractPrefixBlock(file), block);
});

test('extractPrefixBlock: returns null when absent', () => {
  assert.equal(extractPrefixBlock('# Product\n'), null);
});

test('bodyWithoutPrefixBlock: strips block + leading blank lines', () => {
  const block = '<!-- >>> forge-managed (do not edit between markers) >>> -->\nFORGE\n<!-- <<< forge-managed <<< -->\n';
  const file = `${block}\n\n# Product\n`;
  assert.equal(bodyWithoutPrefixBlock(file), '# Product\n');
});

test('bodyWithoutPrefixBlock: passthrough when no block', () => {
  assert.equal(bodyWithoutPrefixBlock('# Product\n'), '# Product\n');
});
