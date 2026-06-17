// Markdown contract tests for the FORGE-214 /drive skill.
//
// R7: these are DOCUMENTATION PINS, not behavioral proof. Skills are
// Claude-followed markdown, not executable code, so these tests can only pin the
// clauses a future edit must not drop and the forbidden strings it must not
// introduce. The re-entrancy guarantee, merge safety, review independence, and
// the pass + no-blocks review gate are NOT provable from markdown — behavioral
// proof is deferred to integration tests if a real `drive` verb / state machine
// is ever added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'drive', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

// Extract ALL fenced code blocks (``` with any/no language tag) joined into one
// string. Negative-usage assertions check inside these blocks (where actual
// commands live), not in prose (where the skill legitimately references "no
// --watch" / "MUST NOT sleep" for explanatory context). Scanning every fence —
// not just ```bash — closes the gap where a forbidden command hides in an
// untagged or differently-tagged fence.
function codeBlocks(md: string): string {
  const matches = md.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/drive/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH), 'expected skills/drive/SKILL.md to exist');
});

test('AC: frontmatter — name/description/tools', () => {
  const md = read();
  assert.match(md, /^---\nname: drive\n/);
  assert.match(md, /\ndescription: .+/);
  assert.match(md, /\ntools: .+/);
  // tools must include the Task tool (subagent spawn).
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.match(tools, /Task/, 'tools must grant the host Task tool');
});

test('AC: body references every orchestrated per-task skill', () => {
  const md = read();
  for (const skill of [
    '/pickup-task',
    '/plan-task',
    '/implement',
    '/qa',
    '/review',
    '/second-opinion',
    '/ship',
    '/wrap-up',
  ]) {
    assert.ok(md.includes(skill), `skill body must orchestrate '${skill}'`);
  }
});

test('AC: body references every required CLI verb', () => {
  const md = read();
  for (const verb of [
    'forge orchestrate second-opinion',
    'forge orchestrate question',
    'forge orchestrate doctor',
  ]) {
    assert.ok(md.includes(verb), `skill body must reference '${verb}'`);
  }
});

test('AC: documents the HITL knobs (R1 net shape — no review_threshold)', () => {
  const md = read();
  assert.ok(md.includes('drive.review_loop_cap'), 'must document review_loop_cap');
  assert.ok(md.includes('drive.merge_policy'), 'must document merge_policy');
  // R1: review_threshold was dropped — it must NOT be reintroduced as a knob.
  assert.equal(
    md.includes('drive.review_threshold'),
    false,
    'R1: drive.review_threshold must not exist (ReviewVerdict has no numeric scores)',
  );
});

test('AC: documents the pass + no-blocks review gate (R1)', () => {
  const md = read();
  // The gate is verdict pass AND zero block findings — not a numeric axis score.
  assert.match(md, /verdict === 'pass'/);
  assert.match(md.toLowerCase(), /block.*finding|no.?block|zero .*block/);
});

test('AC: documents cross-review independence (implementer != reviewer)', () => {
  const md = read();
  assert.match(md.toLowerCase(), /never reviews? its own code|implementer.*never|other model/);
  assert.match(md, /review_host_cli/);
});

test('AC: documents the worktree-local drive note for re-entrancy (R2)', () => {
  const md = read();
  assert.ok(md.includes('.forge/drive-note.json'), 'must document the drive note');
  assert.match(md.toLowerCase(), /re-?entran/);
  // A blocked_on_question ticket is parked, not resumed.
  assert.match(md.toLowerCase(), /blocked_on_question/);
});

test('AC: framed as the per-turn recipe driven by native /goal (NOT its own loop)', () => {
  const md = read();
  assert.match(md, /\/goal/);
  assert.match(md.toLowerCase(), /per-turn recipe|per-ticket recipe|one invocation|then return/);
  // Cites the ADR that reframed /goal -> /drive.
  assert.match(md.toLowerCase(), /adr/);
});

test('AC: cwd-discipline pin — cd <worktree> && git rev-parse assertion', () => {
  const md = read();
  assert.match(md, /cd <worktree> && git rev-parse/);
  assert.match(md.toLowerCase(), /cwd discipline/);
});

test('AC: documents escalation to /inbox', () => {
  const md = read();
  assert.match(md, /\/inbox/);
});

test('AC: NO claude -p (or headless invocation) inside any code block', () => {
  const blocks = codeBlocks(read());
  assert.equal(/claude\s+-p\b/.test(blocks), false, 'no code block may invoke claude -p');
  assert.equal(/claude\s+--print\b/.test(blocks), false, 'no code block may invoke claude --print');
});

test('AC: NO git worktree add in any code block', () => {
  const blocks = codeBlocks(read());
  assert.equal(/\bgit\s+worktree\s+add\b/.test(blocks), false, 'no code block may run git worktree add');
});

test('AC: NO polling/loop constructs in code blocks (sleep/watch/while/--follow/--watch)', () => {
  const blocks = codeBlocks(read());
  // R3 + cross-review fix: ban the BROAD tokens (any form), not just
  // `sleep \d` / `while true`. `sleep "$x"`, `while :; do`, and `--watch`
  // (gh pr checks --watch is a self-loop on CI) must all be caught.
  const pollPatterns = [/\bsleep\b/, /\bwatch\b/, /\bwhile\b/, /--follow\b/, /--watch\b/];
  for (const re of pollPatterns) {
    assert.equal(re.test(blocks), false, `skill must not poll/sleep/watch/while/follow — matched ${re}`);
  }
  // Explicit guard for the CI self-loop, scoped to code blocks (the prose
  // legitimately says "no gh pr checks --watch" as explanation).
  assert.equal(/gh\s+pr\s+checks[^\n]*--watch/.test(blocks), false, 'no gh pr checks --watch in code blocks');
});

test('AC: NO direct writes into .forge/orchestrator/** from code blocks', () => {
  const blocks = codeBlocks(read());
  const writePatterns = [
    /mkdir\s+-p\s+["']?\.forge\/orchestrator/,
    />\s*["']?\.forge\/orchestrator/,
    /tee\s+["']?\.forge\/orchestrator/,
  ];
  for (const re of writePatterns) {
    assert.equal(re.test(blocks), false, `skill must not write to .forge/orchestrator/** — matched ${re}`);
  }
});

test('AC: registry lists /drive so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'drive'));
});
