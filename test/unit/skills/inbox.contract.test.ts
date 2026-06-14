// Markdown contract tests for the FORGE-196 /inbox skill.
//
// R7 (mirrors drive.contract.test.ts): these are DOCUMENTATION PINS, not
// behavioral proof. Skills are Claude-followed markdown, not executable code, so
// these tests pin the clauses a future edit must not drop and the forbidden
// strings it must not introduce. The digest → pick → deep-dive → answer recipe,
// the suggest-don't-force discipline, and the answer-verb-owns-the-write contract
// are NOT provable from markdown — behavioral proof lives in the inbox + answer
// verb unit tests (the verbs already exist; /inbox writes no production code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'inbox', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

// Extract ALL fenced code blocks (``` with any/no language tag) joined into one
// string. Negative-usage assertions check inside these blocks (where actual
// commands live), not in prose (where the skill legitimately references "no
// --watch" / "no self-loop" for explanatory context). Scanning every fence —
// not just ```bash — closes the gap where a forbidden command hides in an
// untagged or differently-tagged fence.
function codeBlocks(md: string): string {
  const matches = md.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/inbox/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH), 'expected skills/inbox/SKILL.md to exist');
});

test('AC: frontmatter — name/description/tools (Bash(forge*), no Task)', () => {
  const md = read();
  assert.match(md, /^---\nname: inbox\n/);
  assert.match(md, /\ndescription: .+/);
  assert.match(md, /\ntools: .+/);
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  // /inbox shells out to forge verbs only.
  assert.match(tools, /Bash\(forge\*\)/, 'tools must grant Bash(forge*)');
  // /inbox spawns NO subagents — it must NOT request the Task tool.
  assert.equal(/\bTask\b/.test(tools), false, 'tools must NOT include Task (no subagents)');
});

test('AC: body reads the inbox verb and answers via the answer verb', () => {
  const md = read();
  assert.ok(md.includes('forge orchestrate inbox'), 'must read forge orchestrate inbox');
  assert.ok(md.includes('forge orchestrate answer'), 'must answer via forge orchestrate answer');
});

test('AC: exact command shapes in code blocks (drift guard)', () => {
  const blocks = codeBlocks(read());
  // inbox must be read with --json (the parseable surface).
  assert.match(blocks, /forge\s+orchestrate\s+inbox\s+--json/, 'inbox must be invoked with --json');
  // answer takes a POSITIONAL question id + --option <id> (NO --json flag exists).
  assert.match(
    blocks,
    /forge\s+orchestrate\s+answer\s+"?\$?\{?[^"\s]*\}?"?\s+--option/,
    'answer must use a positional question id followed by --option',
  );
  assert.equal(
    /forge\s+orchestrate\s+answer[^\n]*--json/.test(blocks),
    false,
    'the answer verb has no --json flag — the skill must not pass it',
  );
});

test('AC: body uses AskUserQuestion for the per-question deep-dive', () => {
  const md = read();
  assert.match(md, /AskUserQuestion/);
  // References the canonical question format contract.
  assert.match(md, /question-format\.md/);
});

test('AC: documents the answer-verb-owns-the-write contract', () => {
  const md = read();
  assert.match(md.toLowerCase(), /answer verb owns the (state )?write|verb owns the write/);
  // /inbox never transitions task state itself.
  assert.match(md.toLowerCase(), /blocked_on_question/);
  assert.match(md.toLowerCase(), /heartbeat/);
});

test('AC: documents DUPLICATE_ID skip + NOT_FOUND/invalid-option surface', () => {
  const md = read();
  assert.match(md, /DUPLICATE_ID/);
  assert.match(md.toLowerCase(), /skip/);
  assert.match(md, /NOT_FOUND/);
  assert.match(md.toLowerCase(), /invalid option/);
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
  const pollPatterns = [/\bsleep\b/, /\bwatch\b/, /\bwhile\b/, /--follow\b/, /--watch\b/];
  for (const re of pollPatterns) {
    assert.equal(re.test(blocks), false, `skill must not poll/sleep/watch/while/follow — matched ${re}`);
  }
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

test('AC: the answer verb is never called with --json (it returns plain text)', () => {
  const blocks = codeBlocks(read());
  // The answer verb has no JSON mode; asserting this keeps the skill accurate.
  assert.equal(
    /forge\s+orchestrate\s+answer[^\n]*--json/.test(blocks),
    false,
    'answer verb must not be invoked with --json (it has no JSON flag)',
  );
});

test('AC: registry lists /inbox in BOTH SLASH_COMMANDS and CLI_VERBS', async () => {
  const { SLASH_COMMANDS, CLI_VERBS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'inbox'), 'SLASH_COMMANDS must list inbox');
  assert.ok(CLI_VERBS.some((v) => v.name === 'inbox'), 'CLI_VERBS must list inbox');
});
