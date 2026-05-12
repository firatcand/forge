// Markdown contract tests for the FORGE-23 rename.
//
// These guard the skill+agent rename at the artifact level — they don't
// exercise behavior (skills are Claude-followed markdown, not executable).
// They DO ensure: file presence, frontmatter shape, body keywords, and
// that the deprecation alias still forwards.

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

test('AC: skills/push-to-tracker/SKILL.md exists', () => {
  assert.ok(
    existsSync(resolve(repoRoot, 'skills/push-to-tracker/SKILL.md')),
    'expected skills/push-to-tracker/SKILL.md to exist',
  );
});

test('AC: push-to-tracker frontmatter — name and subagent', () => {
  const md = read('skills/push-to-tracker/SKILL.md');
  const fm = frontmatter(md);
  assert.equal(fm.name, 'push-to-tracker');
  assert.equal(fm.subagent, 'tracker-syncer');
  // No mcp: lock — the skill must remain MCP-agnostic so it works for
  // github / notion / linear under one skill.
  assert.equal(fm.mcp, undefined, 'push-to-tracker must not lock to a single MCP');
});

test('AC: push-to-tracker body mentions all three trackers and the dispatch key', () => {
  const md = read('skills/push-to-tracker/SKILL.md').toLowerCase();
  for (const word of ['linear', 'github', 'notion', 'tracker.type']) {
    assert.ok(
      md.includes(word.toLowerCase()),
      `push-to-tracker SKILL.md must mention "${word}"`,
    );
  }
});

test('AC: agents/tracker-syncer.md exists with correct frontmatter', () => {
  const path = 'agents/tracker-syncer.md';
  assert.ok(existsSync(resolve(repoRoot, path)), `expected ${path} to exist`);
  const fm = frontmatter(read(path));
  assert.equal(fm.name, 'tracker-syncer');
});

test('AC: agents/linear-syncer.md does NOT exist (renamed)', () => {
  assert.equal(
    existsSync(resolve(repoRoot, 'agents/linear-syncer.md')),
    false,
    'linear-syncer.md must be deleted (no stub — agents addressed by frontmatter name:)',
  );
});

test('AC: skills/push-to-linear/SKILL.md exists as deprecation alias', () => {
  const path = 'skills/push-to-linear/SKILL.md';
  assert.ok(existsSync(resolve(repoRoot, path)), `expected ${path} to exist`);
  const body = read(path);
  assert.match(body, /DEPRECATED/, 'deprecation stub must say DEPRECATED');
  assert.ok(
    body.includes('/push-to-tracker'),
    'deprecation stub must forward to /push-to-tracker',
  );
});

test('AC: deprecation stub frontmatter forwards to tracker-syncer', () => {
  const fm = frontmatter(read('skills/push-to-linear/SKILL.md'));
  assert.equal(fm.name, 'push-to-linear');
  assert.equal(fm.subagent, 'tracker-syncer');
});

test('AC: docs/trackers/{linear,github,notion}.md + README index exist', () => {
  for (const name of ['README.md', 'linear.md', 'github.md', 'notion.md']) {
    const path = `docs/trackers/${name}`;
    assert.ok(
      existsSync(resolve(repoRoot, path)),
      `expected ${path} to exist`,
    );
  }
});

test('AC: docs/LINEAR-INTEGRATION.md no longer exists (moved to docs/trackers/linear.md)', () => {
  assert.equal(
    existsSync(resolve(repoRoot, 'docs/LINEAR-INTEGRATION.md')),
    false,
    'docs/LINEAR-INTEGRATION.md must be moved to docs/trackers/linear.md',
  );
});
