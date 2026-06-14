// Markdown contract tests for the FORGE-98 /forge orchestrate skill.
//
// Skills are Claude-followed markdown, not executable, so these tests guard
// the artifact: file presence, frontmatter shape, required body sections,
// and architectural constraints (no direct .forge/orchestrator writes, no
// inline `git worktree add` — those belong to CLI verbs per ORCHESTRATOR.md
// §80-98). E2E behavior is exercised by the integration test in
// test/integration/cli/orchestrate/dispatch-skill-flow.test.ts.

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

// Extract bash fenced code blocks (```bash ... ```) joined into one string.
// Negative-usage assertions check inside these blocks (where actual commands
// live), not in prose (where the skill may legitimately reference "do NOT
// do X" for explanatory context).
function bashBlocks(md: string): string {
  const matches = md.matchAll(/```bash\n([\s\S]*?)```/g);
  const parts: string[] = [];
  for (const m of matches) parts.push(m[1] ?? '');
  return parts.join('\n');
}

test('AC: skills/forge-orchestrate/SKILL.md exists', () => {
  assert.ok(
    existsSync(resolve(repoRoot, 'skills/forge-orchestrate/SKILL.md')),
    'expected skills/forge-orchestrate/SKILL.md to exist',
  );
});

test('AC: frontmatter — name is forge-orchestrate', () => {
  const fm = frontmatter(read('skills/forge-orchestrate/SKILL.md'));
  assert.equal(fm.name, 'forge-orchestrate');
  assert.ok(fm.description && fm.description.length > 20, 'description is non-trivial');
});

test('AC: skill body mentions all four critical CLI verbs', () => {
  const md = read('skills/forge-orchestrate/SKILL.md');
  // The per-round flow must reference these verbs (ensure-worktree is the
  // architectural authority for worktree creation; the other three drive
  // the claim → dispatch → answer pipeline).
  for (const verb of ['ensure-worktree', 'claim', 'dispatch', 'answer']) {
    assert.ok(
      md.includes(`forge orchestrate ${verb}`),
      `skill body must reference 'forge orchestrate ${verb}'`,
    );
  }
});

test('AC (FORGE-210): skill consumes `forge orchestrate route` before spawning', () => {
  const md = read('skills/forge-orchestrate/SKILL.md');
  assert.ok(
    md.includes('forge orchestrate route'),
    'skill must route the worker via `forge orchestrate route` before spawn',
  );
});

test('AC: skill uses --json + --run for run-scoped question polling', () => {
  const md = read('skills/forge-orchestrate/SKILL.md');
  // Per Codex #9: must scope question polling to the current run, otherwise
  // /forge orchestrate would surface and answer questions from other concurrent
  // supervisors sharing the same .forge/orchestrator/ tree.
  assert.match(
    md,
    /forge orchestrate questions --open --run/,
    'must filter open questions by --run <run_id>',
  );
});

test('AC: skill calls render-worker-prompt to get the prompt for spawn', () => {
  const md = read('skills/forge-orchestrate/SKILL.md');
  // Dispatch verb doesn't render — the skill must call the read-only render
  // verb and inject the resulting prompt into the host's Task tool.
  assert.match(
    md,
    /forge orchestrate render-worker-prompt/,
    'must call render-worker-prompt verb',
  );
});

test('AC: skill spawns subagent via host Task tool (does NOT shell out)', () => {
  const md = read('skills/forge-orchestrate/SKILL.md').toLowerCase();
  // Per spec/SPEC.md Flow 2: workers are host-native subagents (Claude Task
  // tool / Codex native subagents), NOT execa-spawned host CLIs.
  assert.ok(md.includes('task tool'), 'skill must mention host Task tool as spawn mechanism');
});

test('AC: skill does NOT run `git worktree add` in any bash block', () => {
  // Per spec/ORCHESTRATOR.md §80-98: only the CLI may create/remove
  // .forge/worktrees/. Skills must call `forge orchestrate ensure-worktree`,
  // not git worktree add. Negative-usage check scoped to bash blocks so
  // explanatory prose ("do NOT use git worktree add — use the verb") doesn't
  // false-positive.
  const blocks = bashBlocks(read('skills/forge-orchestrate/SKILL.md'));
  assert.equal(
    /\bgit\s+worktree\s+add\b/.test(blocks),
    false,
    'no bash block may invoke `git worktree add` — use ensure-worktree verb instead',
  );
});

test('AC: skill does NOT write to .forge/orchestrator/** from bash', () => {
  // All state writes go through CLI verbs (state-machine + lease ownership).
  // A skill that writes directly to state.json or lease.json bypasses the
  // CAS protection and corrupts concurrent supervisor coordination.
  const md = read('skills/forge-orchestrate/SKILL.md');
  // Allow references to those paths in PROSE (e.g., "via CLI verbs that
  // write to .forge/orchestrator/state.json") but reject any bash write
  // operations like `>`, `>>`, `tee`, `mkdir -p .forge/orchestrator`,
  // `echo ... > .forge/orchestrator/...`.
  const writePatterns = [
    /mkdir\s+-p\s+["']?\.forge\/orchestrator/,
    />\s*["']?\.forge\/orchestrator/,
    /tee\s+["']?\.forge\/orchestrator/,
  ];
  for (const re of writePatterns) {
    assert.equal(
      re.test(md),
      false,
      `skill must not directly write to .forge/orchestrator/** — matched pattern ${re}`,
    );
  }
});

test('AC: skill does NOT poll continuously (one round per invocation)', () => {
  // Per FORGE-98 plan §F3: skill is per-round, not long-running. A literal
  // `while` loop polling phases/questions on a timer would block the user's
  // main session — that's a daemon, not a skill. The Step 6 "continue?"
  // AskUserQuestion is the only loop construct allowed (and it requires a
  // user keystroke between rounds).
  const md = read('skills/forge-orchestrate/SKILL.md');
  // Block patterns: `sleep`, `watch`, `--follow`, while-true loops in bash.
  const pollPatterns = [
    /\bsleep\s+\d/,
    /\bwatch\s+/,
    /while\s+true/,
    /--follow\b/,
  ];
  for (const re of pollPatterns) {
    assert.equal(
      re.test(md),
      false,
      `skill must not poll/sleep/watch — matched ${re}`,
    );
  }
});

test('AC: skill drops drift-routing surface from bash blocks per v0.4 architecture', () => {
  // Per docs/plans/team-mode-minimum-architecture.md §3: drift_event_id,
  // routing_hint, and /amend-roadmap routing are dropped in v0.4. The skill
  // must not USE them — but it may MENTION them in prose to document the
  // drop (negative-instruction context). Check bash blocks only.
  const blocks = bashBlocks(read('skills/forge-orchestrate/SKILL.md')).toLowerCase();
  assert.equal(blocks.includes('drift_event_id'), false, 'no bash block may use drift_event_id');
  assert.equal(blocks.includes('routing_hint'), false, 'no bash block may use routing_hint');
  assert.equal(blocks.includes('--drift-event-id'), false, 'no bash block may pass --drift-event-id');
  assert.equal(blocks.includes('--routing-hint'), false, 'no bash block may pass --routing-hint');
});

test('AC: skill references AskUserQuestion for per-question approval', () => {
  // The "suggest-don't-force" ethos: no claim, dispatch, or answer happens
  // without an explicit user AskUserQuestion call.
  const md = read('skills/forge-orchestrate/SKILL.md');
  assert.match(
    md,
    /AskUserQuestion/,
    'must reference AskUserQuestion as the approval mechanism',
  );
});

test('AC: refactored pickup-task references the ensure-worktree verb', () => {
  // Cross-skill contract: /pickup-task was refactored in this PR (Codex #5)
  // to call the same CLI verb instead of inlining git worktree add. This
  // test catches regressions where pickup-task gets reverted to the old
  // inline bash block.
  const md = read('skills/pickup-task/SKILL.md');
  assert.match(md, /forge orchestrate ensure-worktree/, 'pickup-task must call ensure-worktree verb');
  assert.equal(
    /\bgit\s+worktree\s+add\b\s+["']?\$\{WORKTREE_PATH\}/.test(md),
    false,
    'pickup-task must not run `git worktree add ${WORKTREE_PATH}` inline anymore',
  );
});
