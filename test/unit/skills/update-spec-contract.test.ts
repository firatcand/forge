import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract test for skills/update-spec/SKILL.md (FORGE-93). The skill is
// host-executed markdown, so its safety contract can't be exercised at
// runtime here — instead this pins the clauses a future edit must not drop,
// and cross-checks every CLI surface the skill references against the real
// implementations (the same drift-guard idea as registry.test.ts).

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SKILL = readFileSync(join(ROOT, 'skills', 'update-spec', 'SKILL.md'), 'utf8');

test('frontmatter is well-formed and named update-spec', () => {
  assert.match(SKILL, /^---\nname: update-spec\n/);
  assert.match(SKILL, /\ndescription: .+/);
  assert.match(SKILL, /\ntools: .+/);
});

test('safety contract clauses are present (canonical files, journal trust, clean targets, staged-patch audit)', () => {
  // Canonical-file gate: section refs may only target the two spec artifacts.
  assert.match(SKILL, /Canonical-file gate/);
  assert.match(SKILL, /exactly `spec\/SPEC\.md`/);
  assert.match(SKILL, /exactly `spec\/PRD\.md`/);
  // Journal-trust gate: resumed/hand-edited journals are untrusted input,
  // and the skill enforces journal ⊆ ADR-declared (the verb only checks ⊇).
  assert.match(SKILL, /Journal-trust gate/);
  assert.match(SKILL, /journal ⊆ declared/);
  // Tracker scope is bounded by the ADR declaration (verb never gates it).
  assert.match(SKILL, /`tracker_issues\[\]\.id` ⊆ the ADR's `affected_tasks`/);
  // Recovery is reachable: completed-archive branch precedes ADR resolution.
  assert.match(SKILL, /Completed-archive check comes FIRST/);
  assert.ok(
    SKILL.indexOf('Completed-archive check comes FIRST') < SKILL.indexOf('Read the ADR.'),
    'recovery branch must precede ADR resolution in the apply flow',
  );
  // Clean-target gate: target files must be clean before the first mutation.
  assert.match(SKILL, /Clean-target gate/);
  assert.match(SKILL, /must be CLEAN/);
  // already_applied recovery: existing apply commit detected via git log
  // before any re-commit; dirty-after-commit means unrelated work.
  assert.match(SKILL, /git log --grep "\^spec: apply decision <slug>\$" -n 1/);
  // Staged-patch audit before the commit.
  assert.match(SKILL, /Staged-patch audit/);
  // Commit body survives markdown headings.
  assert.match(SKILL, /git commit --cleanup=verbatim -F/);
});

test('draft preflight distinguishes malformed ADRs from companions', () => {
  assert.match(SKILL, /malformed ADR — fix or remove it first/);
  assert.match(SKILL, /companions never block/);
  assert.match(SKILL, /status: rejected/);
});

test('every verb invocation the skill references exists with those flags', () => {
  const applyDecision = readFileSync(
    join(ROOT, 'src', 'cli', 'orchestrate', 'apply-decision.ts'),
    'utf8',
  );
  // The skill invokes: forge orchestrate apply-decision <slug> --json
  // [--yes-all] [--resume] [--dry-run]; all must be parsed by the handler.
  for (const flag of ["'yes-all'", "'resume'", "'dry-run'", "'json'"]) {
    assert.ok(applyDecision.includes(flag), `apply-decision handler must parse ${flag}`);
  }
  assert.match(SKILL, /forge orchestrate apply-decision <slug> --json/);

  // FORGE-150: the second-opinion suggest hook event must stay registered.
  const suggest = readFileSync(join(ROOT, 'src', 'cli', 'second-opinion-suggest.ts'), 'utf8');
  assert.match(suggest, /'update-spec': 'review-decision'/);
  assert.match(SKILL, /forge second-opinion suggest update-spec/);
});

test('journal worked example matches ApplyJournalSchema exactly', async () => {
  const { ApplyJournalSchema } = await import('../../../src/schemas/apply-journal.ts');
  const fence = SKILL.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fence, 'SKILL must contain the worked journal example as a json fence');
  // The example contains a human placeholder ellipsis — normalize it before
  // parsing; the structure is what the schema validates.
  const parsed = JSON.parse(fence![1]!) as unknown;
  const result = ApplyJournalSchema.safeParse(parsed);
  assert.ok(
    result.success,
    `worked example must validate: ${result.success ? '' : result.error.issues[0]?.path.join('.')}: ${result.success ? '' : result.error.issues[0]?.message}`,
  );
});

test('registry lists /update-spec so CONTEXT.md renders it', async () => {
  const { SLASH_COMMANDS } = await import('../../../src/cli/registry.ts');
  assert.ok(SLASH_COMMANDS.some((s) => s.name === 'update-spec'));
});
