// Markdown contract tests for the FORGE-187 /auto-review skill.
//
// Skills are Claude-followed markdown, not executable, so these tests can only
// pin DOCUMENTATION — the clauses a future edit must not drop and the forbidden
// strings it must not introduce. The billing/interactive guarantees here are
// documented pins, not behavioral proof; the end-to-end behavior is exercised by
// test/integration/cli/orchestrate/auto-review-flow.test.ts. (FORGE-187 R5.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'auto-review', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

// Extract bash fenced code blocks (```bash ... ```) joined into one string.
// Negative-usage assertions check inside these blocks (where actual commands
// live), not in prose (where the skill legitimately references "NEVER claude -p"
// for explanatory context).
function bashBlocks(md: string): string {
  const matches = md.matchAll(/```bash\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/auto-review/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH), 'expected skills/auto-review/SKILL.md to exist');
});

test('AC: frontmatter — name/description/tools', () => {
  const md = read();
  assert.match(md, /^---\nname: auto-review\n/);
  assert.match(md, /\ndescription: .+/);
  assert.match(md, /\ntools: .+/);
  // tools must include the Task tool (in-session subagent spawn) and forge bash.
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.match(tools, /Task/, 'tools must grant the host Task tool');
  assert.match(tools, /Bash\(forge\*\)/, 'tools must grant forge bash');
});

test('AC: body references every required CLI verb', () => {
  const md = read();
  for (const verb of [
    'forge orchestrate review-queue',
    'forge orchestrate second-opinion',
    'forge orchestrate guardrail-check',
    'forge orchestrate complete',
    'forge orchestrate question',
    'forge orchestrate review-compose',
  ]) {
    assert.ok(md.includes(verb), `skill body must reference '${verb}'`);
  }
});

test('AC: documented as interactive-only and spawns primary review via Task tool', () => {
  const md = read();
  // Interactive-session-only marker (escalation needs structured input).
  assert.match(md, /[Ii]nteractive session only/);
  // Primary review runs as an in-session subagent via the host Task tool.
  assert.match(md, /Task/);
  assert.match(md.toLowerCase(), /subagent/);
});

test('AC: documents the billing invariant (subscription-billed primary, never claude -p)', () => {
  const md = read();
  assert.match(md.toLowerCase(), /billing invariant/);
  assert.match(md.toLowerCase(), /subscription/);
  // It must say it NEVER uses claude -p (prose negation is fine here).
  assert.ok(md.includes('claude -p'), 'must name claude -p in the prohibition prose');
});

test('AC: framed as the per-turn recipe drained by native /goal (NOT its own loop)', () => {
  const md = read();
  // Reinforces the no-sleep/no-while contract: the loop lives in native /goal.
  assert.match(md, /\/goal/);
  assert.match(md.toLowerCase(), /per-turn recipe|per round|one drain pass|one task/);
  assert.match(md.toLowerCase(), /review-queue is empty|queue is empty|review-queue empty/);
});

test('AC: NO claude -p (or headless invocation) inside any bash block', () => {
  const blocks = bashBlocks(read());
  assert.equal(/claude\s+-p\b/.test(blocks), false, 'no bash block may invoke claude -p');
  assert.equal(/claude\s+--print\b/.test(blocks), false, 'no bash block may invoke claude --print');
});

test('AC: NO git worktree add in any bash block', () => {
  const blocks = bashBlocks(read());
  assert.equal(/\bgit\s+worktree\s+add\b/.test(blocks), false, 'no bash block may run git worktree add');
});

test('AC: NO polling/loop constructs (sleep/watch/while true/--follow) in bash blocks', () => {
  const blocks = bashBlocks(read());
  const pollPatterns = [/\bsleep\s+\d/, /\bwatch\s+/, /while\s+true/, /--follow\b/];
  for (const re of pollPatterns) {
    assert.equal(re.test(blocks), false, `skill must not poll/sleep/watch/follow — matched ${re}`);
  }
});

test('AC: NO direct writes into .forge/orchestrator/** from bash', () => {
  const blocks = bashBlocks(read());
  const writePatterns = [
    /mkdir\s+-p\s+["']?\.forge\/orchestrator/,
    />\s*["']?\.forge\/orchestrator/,
    /tee\s+["']?\.forge\/orchestrator/,
  ];
  for (const re of writePatterns) {
    assert.equal(re.test(blocks), false, `skill must not write to .forge/orchestrator/** — matched ${re}`);
  }
});

test('AC: registry lists /auto-review so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'auto-review'));
});

test('AC: registry lists the review-compose CLI verb', async () => {
  const { CLI_VERBS } = await import('../../../src/cli/registry.ts');
  assert.ok(CLI_VERBS.some((v) => v.name === 'review-compose'));
});
