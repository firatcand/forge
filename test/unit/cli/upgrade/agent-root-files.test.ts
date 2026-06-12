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

// FORGE-152 drift gate: the marker block at the top of each project template
// MUST match buildPrefixBlock's output byte-for-byte. Without this gate,
// init and `forge upgrade` could produce divergent prefix blocks (init reads
// the template verbatim; upgrade calls buildPrefixBlock) — and Phase B's
// strict edit-detection would flag every fresh init as "user-edited."
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
})();

function readTemplate(name: string): string {
  return readFileSync(resolve(REPO_ROOT, 'templates', name), 'utf8');
}

function extractTemplateMarkerBlock(template: string): string | null {
  return extractPrefixBlock(template);
}

test('drift gate: CLAUDE.project.template.md marker block matches buildPrefixBlock("claude")', () => {
  const expected = buildPrefixBlock('claude', { repoUrl: REPO_URL });
  const template = readTemplate('CLAUDE.project.template.md');
  const actual = extractTemplateMarkerBlock(template);
  assert.equal(
    actual,
    expected,
    'CLAUDE.project.template.md marker block does not match buildPrefixBlock("claude"). Re-render the template prose to match agent-root-files.ts.',
  );
});

test('drift gate: AGENTS.project.template.md marker block matches buildPrefixBlock("codex")', () => {
  const expected = buildPrefixBlock('codex', { repoUrl: REPO_URL });
  const template = readTemplate('AGENTS.project.template.md');
  const actual = extractTemplateMarkerBlock(template);
  assert.equal(actual, expected);
});

test('drift gate: GEMINI.project.template.md marker block matches buildPrefixBlock("gemini")', () => {
  const expected = buildPrefixBlock('gemini', { repoUrl: REPO_URL });
  const template = readTemplate('GEMINI.project.template.md');
  const actual = extractTemplateMarkerBlock(template);
  assert.equal(actual, expected);
});

// ── FORGE-160: cursor host (frontmatter-first .mdc assembly) ──

import {
  ROOT_FILE_BY_AGENT as RFBA_CURSOR,
  MATERIALIZE_WHEN_ENABLED,
  buildCursorRuleFile,
  buildCursorBlock,
  writeCursorRuleBody,
  cursorConventionsBody,
} from '../../../../src/cli/upgrade/agent-root-files.ts';

const INLINED = '# forge methodology\n\nThis is the rendered CONTEXT.md.';

test('FORGE-160 — ROOT_FILE_BY_AGENT.cursor is the nested .mdc path', () => {
  assert.equal(RFBA_CURSOR.cursor, '.cursor/rules/forge-context.mdc');
});

test('FORGE-160 — MATERIALIZE_WHEN_ENABLED: only cursor is create-when-missing', () => {
  assert.equal(MATERIALIZE_WHEN_ENABLED.cursor, true);
  assert.equal(MATERIALIZE_WHEN_ENABLED.claude, false);
  assert.equal(MATERIALIZE_WHEN_ENABLED.codex, false);
  assert.equal(MATERIALIZE_WHEN_ENABLED.gemini, false);
});

test('FORGE-160 — buildCursorRuleFile: frontmatter is the FIRST bytes, then marker block', () => {
  const file = buildCursorRuleFile({ repoUrl: REPO_URL }, INLINED);
  assert.ok(file.startsWith('---\n'), 'must start with .mdc frontmatter');
  assert.match(file, /^---\nalwaysApply: true\n/);
  // marker block appears AFTER the frontmatter close.
  const fmEnd = file.indexOf('\n---\n');
  const markerIdx = file.indexOf('<!-- >>> forge-managed');
  assert.ok(markerIdx > fmEnd, 'marker block must come after frontmatter');
  // inlined context is present verbatim.
  assert.ok(file.includes(INLINED), 'rendered context must be inlined verbatim');
});

test('FORGE-160 — buildPrefixBlock throws for cursor (generic path must not be used)', () => {
  assert.throws(() => buildPrefixBlock('cursor', { repoUrl: REPO_URL }), /buildCursorRuleFile/);
});

test('FORGE-160 — writeCursorRuleBody: marker round-trip preserves frontmatter + replaces block', () => {
  const original = buildCursorRuleFile({ repoUrl: REPO_URL }, 'OLD CONTEXT');
  const newBlock = buildCursorBlock({ repoUrl: REPO_URL }, 'NEW CONTEXT');
  const updated = writeCursorRuleBody(original, newBlock);
  assert.ok(updated.startsWith('---\n'), 'frontmatter still first');
  assert.ok(updated.includes('NEW CONTEXT'), 'context refreshed');
  assert.ok(!updated.includes('OLD CONTEXT'), 'old context removed');
  // idempotent: applying the same block again is a no-op.
  const again = writeCursorRuleBody(updated, newBlock);
  assert.equal(again, updated);
});

test('FORGE-160 — writeCursorRuleBody: inline-content refresh on context change', () => {
  const v1 = buildCursorRuleFile({ repoUrl: REPO_URL }, 'CONTEXT v1');
  const v2 = writeCursorRuleBody(v1, buildCursorBlock({ repoUrl: REPO_URL }, 'CONTEXT v2'));
  assert.notEqual(v1, v2);
  assert.ok(v2.includes('CONTEXT v2'));
});

test('FORGE-160 — writeCursorRuleBody preserves user-edited frontmatter', () => {
  const custom = '---\nalwaysApply: true\ndescription: my custom desc\nglobs: "**/*.ts"\n---\n\n';
  const block = buildCursorBlock({ repoUrl: REPO_URL }, INLINED);
  const file = custom + block;
  const updated = writeCursorRuleBody(file, buildCursorBlock({ repoUrl: REPO_URL }, 'CHANGED'));
  assert.match(updated, /description: my custom desc/);
  assert.match(updated, /globs: "\*\*\/\*\.ts"/);
  assert.ok(updated.includes('CHANGED'));
});

test('FORGE-160 — writeCursorRuleBody re-attaches frontmatter when absent', () => {
  const updated = writeCursorRuleBody('', buildCursorBlock({ repoUrl: REPO_URL }, INLINED));
  assert.ok(updated.startsWith('---\nalwaysApply: true\n'), 'canonical frontmatter re-attached');
  assert.ok(updated.includes(INLINED));
});

test('FORGE-160 — cursorConventionsBody strips frontmatter AND markers, keeps inlined body', () => {
  const file = buildCursorRuleFile({ repoUrl: REPO_URL }, INLINED);
  const body = cursorConventionsBody(file);
  assert.ok(!body.includes('---'), 'frontmatter stripped');
  assert.ok(!body.includes('forge-managed'), 'markers stripped');
  assert.ok(body.includes(INLINED), 'inlined context retained');
});

test('FORGE-160 — cursorConventionsBody returns "" when no marker block present', () => {
  assert.equal(cursorConventionsBody('---\nalwaysApply: true\n---\n\njust prose'), '');
});
