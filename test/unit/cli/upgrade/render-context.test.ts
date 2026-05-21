import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContext } from '../../../../src/cli/upgrade/render-context.ts';

const FIXTURE_TEMPLATE = `# Forge methodology

Version: {{METHODOLOGY_VERSION}}

## Verbs

{{CLI_VERBS_BLOCK}}

## Commands

{{SLASH_COMMANDS_BLOCK}}
`;

test('renderContext: substitutes version placeholder', () => {
  const out = renderContext(FIXTURE_TEMPLATE, {
    version: '0.5.0',
    verbs: [],
    slashCommands: [],
  });
  assert.match(out, /Version: 0\.5\.0/);
  assert.doesNotMatch(out, /\{\{METHODOLOGY_VERSION\}\}/);
});

test('renderContext: renders verbs as a bullet list with names and summaries', () => {
  const out = renderContext(FIXTURE_TEMPLATE, {
    version: '0.5.0',
    verbs: [
      { name: 'claim', summary: 'Reserve a task.' },
      { name: 'dispatch', summary: 'Hand to host CLI.' },
    ],
    slashCommands: [],
  });
  assert.match(out, /- `forge orchestrate claim` — Reserve a task\./);
  assert.match(out, /- `forge orchestrate dispatch` — Hand to host CLI\./);
});

test('renderContext: renders slash commands with leading slash', () => {
  const out = renderContext(FIXTURE_TEMPLATE, {
    version: '0.5.0',
    verbs: [],
    slashCommands: [{ name: 'pickup-task', summary: 'Claim next task.' }],
  });
  assert.match(out, /- `\/pickup-task` — Claim next task\./);
});

test('renderContext: empty verb list renders explicit "(none)" marker', () => {
  const out = renderContext(FIXTURE_TEMPLATE, {
    version: '0.5.0',
    verbs: [],
    slashCommands: [],
  });
  assert.match(out, /## Verbs\n\n_\(none\)_/);
});

test('renderContext: leaves no unsubstituted placeholders', () => {
  const out = renderContext(FIXTURE_TEMPLATE, {
    version: '0.5.0',
    verbs: [{ name: 'a', summary: 'b' }],
    slashCommands: [{ name: 'c', summary: 'd' }],
  });
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/, 'no placeholders should remain');
});

// FORGE-152 hardening: if the template is missing one of the three required
// placeholders, the rendered output silently drops that signal. We don't want
// silent loss — assert callers know exactly what they got. Throw on missing
// placeholders so the dogfood script + Phase B's `forge upgrade` fail loudly
// rather than producing a half-rendered CONTEXT.md.
test('renderContext: throws when template is missing a required placeholder', () => {
  const broken = '# Forge\n\nVersion: {{METHODOLOGY_VERSION}}\n\n(no verbs section)';
  assert.throws(
    () =>
      renderContext(broken, {
        version: '0.5.0',
        verbs: [{ name: 'a', summary: 'b' }],
        slashCommands: [],
      }),
    /missing required placeholder: \{\{CLI_VERBS_BLOCK\}\}/,
  );
});
