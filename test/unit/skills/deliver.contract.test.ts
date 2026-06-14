// Markdown contract tests for the FORGE-215 /deliver skill.
//
// Like drive.contract.test.ts (R7): these are DOCUMENTATION PINS, not behavioral
// proof. Skills are Claude-followed markdown, not executable code, so these tests
// pin the clauses a future edit must not drop and the forbidden strings it must
// not introduce. The batching heuristic, claim-free shared-worktree safety, lossless
// resume, and the pass + no-blocks gate are not provable from markdown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'deliver', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

// Extract ALL fenced code blocks joined into one string — negative-usage
// assertions check inside code (where commands live), not prose (where the skill
// legitimately references "no --watch" for explanation).
function codeBlocks(md: string): string {
  const matches = md.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/deliver/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH), 'expected skills/deliver/SKILL.md to exist');
});

test('AC: frontmatter — name/description/tools(Task)', () => {
  const md = read();
  assert.match(md, /^---\nname: deliver\n/);
  assert.match(md, /\ndescription: .+/);
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.match(tools, /Task/, 'tools must grant the host Task tool');
});

test('AC: body orchestrates /drive and the phase ceremony', () => {
  const md = read();
  for (const skill of ['/drive', '/plan-task', '/implement', '/review', '/second-opinion', '/ship', '/wrap-up', '/phase-gate']) {
    assert.ok(md.includes(skill), `skill body must orchestrate '${skill}'`);
  }
});

test('AC: body references every required CLI verb', () => {
  const md = read();
  for (const verb of [
    'forge orchestrate ensure-worktree',
    'forge orchestrate phases --ready',
    'forge orchestrate second-opinion',
    'forge orchestrate question',
    'forge orchestrate route',
  ]) {
    assert.ok(md.includes(verb), `skill body must reference '${verb}'`);
  }
});

test('AC: claim-free interactive path — NO claim/dispatch/complete in any code block (the load-bearing safety claim)', () => {
  const md = read();
  // Prose must state it does not drive the formal lifecycle...
  assert.match(md.toLowerCase(), /claim-free|interactive skill path|never drives? the formal|does not drive the formal/);
  // ...and crucially NO code block may invoke the lease/dispatch/complete verbs,
  // because the skill path takes no lease (a claim would strand it) and complete's
  // marker binding would reject a shared-worktree batch.
  const blocks = codeBlocks(md);
  assert.equal(/forge\s+orchestrate\s+claim\b/.test(blocks), false, 'no code block may run forge orchestrate claim');
  assert.equal(/forge\s+orchestrate\s+dispatch\b/.test(blocks), false, 'no code block may run forge orchestrate dispatch');
  assert.equal(/forge\s+orchestrate\s+complete\b/.test(blocks), false, 'no code block may run forge orchestrate complete');
  assert.equal(/forge\s+orchestrate\s+heartbeat\b/.test(blocks), false, 'no code block may run forge orchestrate heartbeat');
});

test('AC: documents the deliver HITL knobs (no review_threshold)', () => {
  const md = read();
  assert.ok(md.includes('deliver.max_batch_size'), 'must document max_batch_size');
  assert.ok(md.includes('deliver.max_batch_estimate'), 'must document max_batch_estimate');
  assert.ok(md.includes('deliver.review_loop_cap'), 'must document review_loop_cap');
  assert.ok(md.includes('deliver.merge_policy'), 'must document merge_policy');
  assert.equal(md.includes('deliver.review_threshold'), false, 'R1: no review_threshold knob');
});

test('AC: documents the pass + no-blocks review gate (R1)', () => {
  const md = read();
  assert.match(md, /verdict === 'pass'/);
  assert.match(md.toLowerCase(), /block.*finding|no.?block|zero .*block/);
});

test('AC: documents cross-review independence (implementer != reviewer)', () => {
  const md = read();
  assert.match(md.toLowerCase(), /never reviews? its own code|implementer.*never|other model|other.*lineage/);
  assert.match(md, /review_host_cli/);
});

test('AC: lossless resume from durable truth via deliver-state.md', () => {
  const md = read();
  assert.ok(md.includes('.forge/deliver-state.md'), 'must document the deliver-state scratch');
  assert.match(md.toLowerCase(), /re-?entran|resume/);
  assert.match(md.toLowerCase(), /durable/);
  // A blocked_on_question batch is parked, not resumed mid-loop.
  assert.match(md.toLowerCase(), /park/);
});

test('AC: themed batching heuristic — shared subsystem + caps + lead worktree', () => {
  const md = read();
  assert.match(md.toLowerCase(), /themed batch|batch/);
  assert.match(md.toLowerCase(), /subsystem/);
  assert.match(md.toLowerCase(), /write_globs/);
  assert.match(md.toLowerCase(), /lead/); // lead worktree owns the shared batch
  // One PR closing every batch ticket.
  assert.match(md, /Closes <ID>|Closes <id>|Closes/);
});

test('AC: framed as the per-turn recipe driven by native /goal (NOT its own loop)', () => {
  const md = read();
  assert.match(md, /\/goal/);
  assert.match(md.toLowerCase(), /per-turn recipe|one invocation|then return/);
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

test('AC: NO git worktree add in any code block (use ensure-worktree)', () => {
  const blocks = codeBlocks(read());
  assert.equal(/\bgit\s+worktree\s+add\b/.test(blocks), false, 'no code block may run git worktree add');
});

test('AC: NO polling/loop constructs in code blocks (sleep/watch/while/--follow/--watch)', () => {
  const blocks = codeBlocks(read());
  const pollPatterns = [/\bsleep\b/, /\bwatch\b/, /\bwhile\b/, /--follow\b/, /--watch\b/];
  for (const re of pollPatterns) {
    assert.equal(re.test(blocks), false, `skill must not poll/sleep/watch/while/follow — matched ${re}`);
  }
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

test('AC: registry lists /deliver so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'deliver'));
});
