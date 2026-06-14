// Markdown contract tests for the FORGE-217 /autopilot skill.
//
// Like drive/deliver contract tests (R7): these are DOCUMENTATION PINS, not
// behavioral proof. Skills are Claude-followed markdown, so these tests pin the
// clauses a future edit must not drop (the human gates, approval-state resume,
// the reused chain) and the forbidden strings it must not introduce (self-loop,
// orchestrator writes). The approval semantics themselves are not provable from
// markdown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SKILL_PATH = resolve(repoRoot, 'skills', 'autopilot', 'SKILL.md');

function read(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

function codeBlocks(md: string): string {
  const matches = md.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/autopilot/SKILL.md exists', () => {
  assert.ok(existsSync(SKILL_PATH), 'expected skills/autopilot/SKILL.md to exist');
});

test('AC: frontmatter — name/description/tools(Task)', () => {
  const md = read();
  assert.match(md, /^---\nname: autopilot\n/);
  assert.match(md, /\ndescription: .+/);
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const tools = fm.split('\n').find((l) => l.startsWith('tools:')) ?? '';
  assert.match(tools, /Task/, 'tools must grant the host Task tool');
});

test('AC: orchestrates EVERY front-half chain skill + the /deliver handoff', () => {
  const md = read();
  for (const skill of [
    '/forge',
    '/draft-prd',
    '/draft-spec',
    '/draft-design',
    '/ingest-spec',
    '/decompose',
    '/push-to-tracker',
    '/deliver',
  ]) {
    assert.ok(md.includes(skill), `skill body must orchestrate '${skill}'`);
  }
});

test('AC: reuses existing skills verbatim — NO forked spec chain', () => {
  const md = read();
  assert.match(md.toLowerCase(), /reuses? the existing|no forked spec chain|reuses the existing chain/);
});

test('AC: every ceremony stays a real gate — never auto-approve a spec', () => {
  const md = read();
  // The four suggest gates + the blocking ingest gate must all be named.
  assert.match(md.toLowerCase(), /brief sign-?off/);
  assert.match(md.toLowerCase(), /prd review/);
  assert.match(md.toLowerCase(), /spec approval/);
  assert.match(md.toLowerCase(), /decompose review/);
  assert.match(md.toLowerCase(), /blocking/); // ingest-spec blocking validation
  assert.match(md.toLowerCase(), /suggest-don'?t-force/);
  assert.match(md.toLowerCase(), /never auto-?approve/);
});

test('AC: approval-state resume — artifact without recorded approval re-presents the gate (never skips)', () => {
  const md = read();
  assert.ok(md.includes('.forge/autopilot-state.md'), 'must document the approval-state scratch');
  assert.match(md.toLowerCase(), /approv/); // approval/approved
  assert.match(md.toLowerCase(), /re-?present/);
  // The trap it guards against: artifacts are written before the gate passes.
  assert.match(md.toLowerCase(), /artifact exist|before .*gate|bare artifact/);
});

test('AC: forge-initialized precondition (does NOT auto-run forge init)', () => {
  const md = read();
  assert.match(md, /\.forge\/settings\.yaml/);
  assert.match(md.toLowerCase(), /forge init/);
  assert.match(md.toLowerCase(), /not auto-?run|do not auto-?run/);
});

test('AC: framed as a per-turn recipe driven by native /goal (NOT its own loop)', () => {
  const md = read();
  assert.match(md, /\/goal/);
  assert.match(md.toLowerCase(), /per-turn recipe|one invocation|then return/);
  assert.match(md.toLowerCase(), /adr/);
});

test('AC: NO claude -p inside any code block', () => {
  const blocks = codeBlocks(read());
  assert.equal(/claude\s+-p\b/.test(blocks), false, 'no code block may invoke claude -p');
  assert.equal(/claude\s+--print\b/.test(blocks), false, 'no code block may invoke claude --print');
});

test('AC: NO git worktree add in any code block (autopilot does not create worktrees)', () => {
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

test('AC: registry lists /autopilot so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'autopilot'));
});

test('AC: dogfood walkthrough + recorded-answers fixture exist and reference the chain', () => {
  const walkthrough = resolve(repoRoot, 'examples', 'autopilot-walkthrough.md');
  const answers = resolve(repoRoot, 'examples', 'autopilot-answers.linear.json');
  assert.ok(existsSync(walkthrough), 'examples/autopilot-walkthrough.md must exist');
  assert.ok(existsSync(answers), 'examples/autopilot-answers.linear.json must exist');
  const wt = readFileSync(walkthrough, 'utf8');
  // References the chain + the worked example fixture.
  for (const ref of ['/forge', '/draft-prd', '/draft-spec', '/decompose', '/push-to-tracker', '/deliver', 'greenfield-linear']) {
    assert.ok(wt.includes(ref), `walkthrough must reference '${ref}'`);
  }
  // The recorded answers fixture is valid JSON and points at the expected output.
  const parsed = JSON.parse(readFileSync(answers, 'utf8')) as { expected_output?: string };
  assert.match(parsed.expected_output ?? '', /greenfield-linear/);
});
