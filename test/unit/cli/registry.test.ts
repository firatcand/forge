import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_VERBS, SLASH_COMMANDS } from '../../../src/cli/registry.ts';
import { VERBS } from '../../../src/cli/orchestrate/index.ts';

test('registry: CLI_VERBS contains expected core verbs', () => {
  const names = CLI_VERBS.map((v) => v.name);
  for (const expected of ['claim', 'dispatch', 'complete', 'gc', 'reconcile', 'status']) {
    assert.ok(names.includes(expected), `expected ${expected}`);
  }
});

test('registry: every CLI_VERBS entry has a meaningful summary', () => {
  for (const verb of CLI_VERBS) {
    assert.ok(verb.summary.length > 15, `verb ${verb.name} summary too thin (${verb.summary.length} chars)`);
    assert.ok(verb.name === verb.name.toLowerCase(), `verb name must be lowercase kebab: ${verb.name}`);
  }
});

test('registry: SLASH_COMMANDS contains the user-facing core skills', () => {
  const names = SLASH_COMMANDS.map((s) => s.name);
  for (const expected of [
    'pickup-task',
    'plan-task',
    'implement',
    'ship',
    'review',
    'qa',
    'forge',
    'investigate',
    'fix',
  ]) {
    assert.ok(names.includes(expected), `expected ${expected}`);
  }
});

test('registry: every SLASH_COMMANDS entry has a meaningful summary', () => {
  for (const skill of SLASH_COMMANDS) {
    assert.ok(skill.summary.length > 15, `skill ${skill.name} summary too thin (${skill.summary.length} chars)`);
    assert.ok(skill.name === skill.name.toLowerCase(), `skill name must be lowercase kebab: ${skill.name}`);
  }
});

test('registry: every entry has a unique name', () => {
  const verbNames = CLI_VERBS.map((v) => v.name);
  assert.equal(new Set(verbNames).size, verbNames.length, 'verb names must be unique');
  const skillNames = SLASH_COMMANDS.map((s) => s.name);
  assert.equal(new Set(skillNames).size, skillNames.length, 'skill names must be unique');
});

// Conformance: every top-level verb registered in orchestrate/index.ts MUST
// have a corresponding entry in CLI_VERBS, or CONTEXT.md drifts from the
// installed CLI surface. Sub-verb maps (e.g., `run start`/`run list`) are
// asserted on their literal sub-verb names since CLI_VERBS lists them
// flattened as "run start" / "run list".
test('registry conformance: CLI_VERBS covers every top-level orchestrate verb', () => {
  const cliNames = new Set(CLI_VERBS.map((v) => v.name));
  for (const [topName, entry] of VERBS) {
    if (entry instanceof Map) {
      for (const [subName] of entry) {
        const flat = `${topName} ${subName}`;
        assert.ok(
          cliNames.has(flat),
          `CLI_VERBS missing "${flat}" — add it to src/cli/registry.ts to keep CONTEXT.md in sync`,
        );
      }
    } else {
      assert.ok(
        cliNames.has(topName),
        `CLI_VERBS missing "${topName}" — add it to src/cli/registry.ts to keep CONTEXT.md in sync`,
      );
    }
  }
});

// Inverse direction: CLI_VERBS should not list verbs that don't exist in the
// orchestrate registry. A verb listed in CONTEXT.md that the CLI doesn't
// implement misleads adopters and dies on first `forge orchestrate <verb>`.
test('registry conformance: every CLI_VERBS name resolves in orchestrate VERBS', () => {
  for (const { name } of CLI_VERBS) {
    const parts = name.split(' ');
    const top = parts[0];
    assert.ok(top, `verb name must be non-empty: ${name}`);
    const handler = VERBS.get(top);
    assert.ok(handler, `CLI_VERBS lists "${name}" but orchestrate VERBS has no "${top}"`);
    if (parts.length === 2) {
      const sub = parts[1];
      assert.ok(handler instanceof Map, `CLI_VERBS lists sub-verb "${name}" but "${top}" is not a sub-verb map`);
      assert.ok(sub, `sub-verb name must be non-empty: ${name}`);
      assert.ok(handler.get(sub), `CLI_VERBS lists "${name}" but sub-verb "${sub}" is not registered under "${top}"`);
    }
  }
});
