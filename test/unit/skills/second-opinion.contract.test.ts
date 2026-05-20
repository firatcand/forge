// Markdown contract tests for the FORGE-89 (P2-T21) rename:
//   skills/codex/ → skills/second-opinion/, with skills/codex/ kept as a
//   description-only deprecation alias.
//
// Guards file presence, frontmatter shape, body keywords, and that the
// caller skills (/ship, /review, /plan-task) reference the new name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function frontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

// ── /second-opinion canonical skill ─────────────────────────────────────────

test('AC: skills/second-opinion/SKILL.md exists', () => {
  assert.ok(
    existsSync(resolve(repoRoot, 'skills/second-opinion/SKILL.md')),
    'expected skills/second-opinion/SKILL.md to exist',
  );
});

test('AC: second-opinion frontmatter — name matches', () => {
  const fm = frontmatter(read('skills/second-opinion/SKILL.md'));
  assert.equal(fm.name, 'second-opinion');
});

test('AC: second-opinion description names both supported reviewers', () => {
  const md = read('skills/second-opinion/SKILL.md');
  const fm = frontmatter(md);
  const desc = (fm.description ?? '').toLowerCase();
  assert.ok(desc.includes('codex'), 'description must mention Codex');
  assert.ok(desc.includes('gemini'), 'description must mention Gemini');
});

test('AC: second-opinion body dispatches via the CLI verb, not codex exec directly', () => {
  const md = read('skills/second-opinion/SKILL.md');
  assert.ok(
    md.includes('forge orchestrate second-opinion'),
    'second-opinion body must call `forge orchestrate second-opinion`',
  );
  // The new skill must NOT spawn codex/gemini directly — that boundary is
  // owned by the CLI verb / IHarness adapter. The only allowed `codex exec`
  // / `gemini` shell mention is documentation/prose. Heuristic: no bash
  // codex-exec invocation in code fences.
  assert.ok(
    !md.includes('codex exec --color'),
    'second-opinion must not invoke `codex exec` directly — dispatch goes through the verb',
  );
});

test('AC: second-opinion body documents the JSON envelope shape', () => {
  const md = read('skills/second-opinion/SKILL.md');
  assert.match(md, /verdict/i);
  assert.ok(md.includes('"host":') || md.includes('host:'), 'envelope shape must show the host field');
});

// ── /codex deprecation alias ───────────────────────────────────────────────

test('AC: skills/codex/SKILL.md exists as deprecation alias', () => {
  const path = 'skills/codex/SKILL.md';
  assert.ok(existsSync(resolve(repoRoot, path)), `expected ${path} to exist`);
});

test('AC: codex alias frontmatter description marks it DEPRECATED', () => {
  const md = read('skills/codex/SKILL.md');
  const fm = frontmatter(md);
  assert.equal(fm.name, 'codex');
  assert.match(
    fm.description ?? '',
    /DEPRECATED/i,
    'codex skill description must say DEPRECATED',
  );
});

test('AC: codex alias body forwards to /second-opinion', () => {
  const md = read('skills/codex/SKILL.md');
  assert.match(md, /DEPRECATED/);
  assert.ok(
    md.includes('/second-opinion'),
    'deprecation stub must forward to /second-opinion',
  );
});

test('AC: codex alias names the removal version (v0.5.0)', () => {
  const md = read('skills/codex/SKILL.md');
  assert.match(md, /v0\.5\.0/, 'removal version must be stated so users know the deadline');
});

// ── Caller skill cross-references ─────────────────────────────────────────

test('AC: /ship references /second-opinion (not /codex) for the CRITICAL gate', () => {
  const md = read('skills/ship/SKILL.md');
  // The CRITICAL-path gate line must point at the new skill name.
  assert.ok(
    md.includes('/second-opinion'),
    '/ship must mention /second-opinion as the CRITICAL-path review',
  );
});

test('AC: /plan-task suggestion string points at /second-opinion', () => {
  const md = read('skills/plan-task/SKILL.md');
  assert.ok(
    md.includes('/second-opinion'),
    '/plan-task post-skill hint must suggest /second-opinion',
  );
});

test('AC: /review invokes /second-opinion on CRITICAL.md path matches', () => {
  const md = read('skills/review/SKILL.md');
  assert.ok(
    md.includes('/second-opinion'),
    '/review must invoke /second-opinion when CRITICAL.md paths are touched',
  );
});
