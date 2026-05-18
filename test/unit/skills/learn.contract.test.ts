// Markdown contract tests for FORGE-81 — /learn writes to the canonical
// learnings store (main checkout), not the active worktree.
//
// These guard the SKILL.md instructions at the artifact level — they don't
// execute the skill (which is Claude-followed markdown, not code). They DO
// ensure: file presence, frontmatter shape, the canonical-path resolution
// snippet, the dual-write contract, and a regression guard against the
// pre-fix "bare relative path" instruction that caused the back-propagation
// gap in the first place.

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

test('AC: skills/learn/SKILL.md exists', () => {
  assert.ok(
    existsSync(resolve(repoRoot, 'skills/learn/SKILL.md')),
    'expected skills/learn/SKILL.md to exist',
  );
});

test('AC: learn frontmatter — name and subagent', () => {
  const fm = frontmatter(read('skills/learn/SKILL.md'));
  assert.equal(fm.name, 'learn');
  assert.equal(
    fm.subagent,
    'learning-curator',
    'learn must delegate to learning-curator',
  );
});

test('AC: learn frontmatter — tools include Bash for git resolution', () => {
  const fm = frontmatter(read('skills/learn/SKILL.md'));
  // FORGE-81: /learn now needs Bash(git*) to resolve the main checkout path
  // via `git rev-parse --git-common-dir`. Without this declaration the skill
  // can't run the resolution snippet at all.
  assert.ok(
    fm.tools && /Bash\s*\(\s*git\*?\s*\)/i.test(fm.tools),
    `learn frontmatter must declare a Bash(git*) tool grant; got tools=${fm.tools ?? '(none)'}`,
  );
});

test('AC: learn body contains canonical-path resolution via git-common-dir', () => {
  const md = read('skills/learn/SKILL.md');
  // The whole back-propagation fix hinges on this exact idiom. If a future
  // edit drops it (or replaces it with --show-toplevel, which would return
  // the worktree root from inside a worktree), the fix silently regresses.
  assert.match(
    md,
    /git\s+rev-parse\s+--git-common-dir/,
    'learn SKILL.md must instruct resolving MAIN_ROOT via `git rev-parse --git-common-dir`',
  );
});

test('AC: learn body instructs writing to the main checkout path first', () => {
  const md = read('skills/learn/SKILL.md');
  // Must reference the absolute main-checkout path, not just `docs/learnings/`.
  // We accept either ${MAIN_ROOT}/docs/learnings or "main checkout" prose.
  assert.match(
    md,
    /\$\{?MAIN_ROOT\}?\/docs\/learnings/,
    'learn SKILL.md must instruct writing to ${MAIN_ROOT}/docs/learnings/',
  );
});

test('AC: learn body instructs mirroring to worktree path when running from a worktree', () => {
  const md = read('skills/learn/SKILL.md').toLowerCase();
  // The "mirror" / "alongside" semantic is the same-session-Read guarantee
  // from AC bullet #3. Without it, `Read ./docs/learnings/...` would 404 in
  // the same session.
  assert.ok(
    md.includes('mirror') || md.includes('alongside'),
    'learn SKILL.md must describe mirroring the write to the worktree path',
  );
  // Symlink-normalized compare avoids spurious double-writes on macOS where
  // /var and /private/var both refer to the same dir. `pwd -P` (or realpath)
  // is the explicit fix per the plan.
  assert.match(
    read('skills/learn/SKILL.md'),
    /pwd\s+-P|realpath/,
    'learn SKILL.md must use a symlink-normalized path comparison (pwd -P or realpath)',
  );
});

test('AC: learn body cross-references spec/SPEC.md §Learnings store', () => {
  const md = read('skills/learn/SKILL.md');
  assert.ok(
    md.includes('spec/SPEC.md') && /learnings\s+store/i.test(md),
    'learn SKILL.md must cross-reference spec/SPEC.md §Learnings store',
  );
});

test('AC: spec/SPEC.md has §Learnings store section', () => {
  const md = read('spec/SPEC.md');
  // A real top-level (##) heading, not just an in-prose mention.
  assert.match(
    md,
    /^##\s+Learnings\s+store\s*$/m,
    'spec/SPEC.md must contain a top-level `## Learnings store` section',
  );
  // The section must spell out the canonical-store rule and the dual-write
  // contract; otherwise the doc anchor is empty and SKILL.md's cross-ref
  // points at nothing actionable.
  assert.match(
    md,
    /git\s+rev-parse\s+--git-common-dir/,
    'spec/SPEC.md §Learnings store must specify the canonical-path resolution idiom',
  );
  assert.match(
    md,
    /\bcanonical\b/i,
    'spec/SPEC.md §Learnings store must describe the canonical-store rule',
  );
});

test('regression guard: learn must not instruct writing to the bare relative path', () => {
  const md = read('skills/learn/SKILL.md');
  // Pre-FORGE-81 the instruction was "Write 5-10 line learning to
  // `docs/learnings/{quarter}/{slug}.md`". That bare relative path is the
  // back-propagation bug. Any future edit that re-introduces it without
  // the MAIN_ROOT resolution would silently regress the fix.
  //
  // We allow the bare path to APPEAR in the file (it's referenced inside
  // the canonical-path block as a sub-component, and inside the format
  // example), but it must always co-occur with a main-checkout resolution
  // — i.e. MAIN_ROOT or `git rev-parse --git-common-dir` must be in the
  // same file. If MAIN_ROOT is missing entirely, the regression has landed.
  const mentionsBarePath = /docs\/learnings\/\{quarter\}\/\{slug\}\.md/.test(md);
  const mentionsMainRoot = /MAIN_ROOT|git rev-parse --git-common-dir/.test(md);
  if (mentionsBarePath) {
    assert.ok(
      mentionsMainRoot,
      'learn SKILL.md mentions docs/learnings/{quarter}/{slug}.md but not MAIN_ROOT resolution — this is the FORGE-81 regression',
    );
  }
});
