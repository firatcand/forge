// Markdown contract tests for the FORGE-212 /models skill (R7).
//
// Documentation pins, not behavioral proof: skills are Claude-followed markdown,
// so these assert the clauses a future edit must not drop and the forbidden
// patterns it must not introduce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'models', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

function codeBlocks(md: string): string {
  const matches = md.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/models/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH));
});

test('AC: frontmatter name=models + description + tools', () => {
  const md = read();
  assert.match(md, /^---\nname: models\n/);
  assert.match(md, /\ndescription: .+/);
  assert.match(md, /\ntools: .+/);
});

test('AC: tools include WebSearch + WebFetch', () => {
  const md = read();
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.match(tools, /WebSearch/, 'tools must include WebSearch');
  assert.match(tools, /WebFetch/, 'tools must include WebFetch');
});

test('AC: references forge orchestrate models --refresh', () => {
  const md = read();
  assert.ok(md.includes('forge orchestrate models --refresh'));
});

test('AC: graceful fallback when no web tool (cold-start seed covers no-web)', () => {
  const md = read();
  assert.match(md.toLowerCase(), /seed/);
  assert.match(md.toLowerCase(), /no-web|no web|do not fabricate|don't fabricate/);
});

test('AC: no self-loop (sleep/watch/while/--follow/--watch) in code blocks', () => {
  const blocks = codeBlocks(read());
  for (const re of [/\bsleep\b/, /\bwatch\b/, /\bwhile\b/, /--follow\b/, /--watch\b/]) {
    assert.equal(re.test(blocks), false, `skill must not poll/loop — matched ${re}`);
  }
});

test('AC: registry lists /models so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'models'));
});
