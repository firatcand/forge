// FORGE-152: pure rendering function for `.forge/CONTEXT.md`.
// Consumes the static template (templates/CONTEXT.template.md) + the
// registry (src/cli/registry.ts) and produces the final markdown.
//
// Pure: no fs, no fetch, no clock. Deterministic for given inputs —
// the same (template, input) always produces byte-identical output.
// That property is load-bearing for the strict edit-detection check
// `forge upgrade` will run in Phase B.

import type { RegistryEntry } from '../registry.ts';

export interface RenderContextInput {
  readonly version: string;
  readonly verbs: readonly RegistryEntry[];
  readonly slashCommands: readonly RegistryEntry[];
}

const NONE_MARKER = '_(none)_';

const REQUIRED_PLACEHOLDERS = [
  '{{METHODOLOGY_VERSION}}',
  '{{CLI_VERBS_BLOCK}}',
  '{{SLASH_COMMANDS_BLOCK}}',
] as const;

function renderEntries(
  entries: readonly RegistryEntry[],
  prefix: string,
): string {
  if (entries.length === 0) return NONE_MARKER;
  return entries.map((e) => `- \`${prefix}${e.name}\` — ${e.summary}`).join('\n');
}

export function renderContext(
  template: string,
  input: RenderContextInput,
): string {
  // Refuse to render against a broken template. Silent placeholder loss
  // would produce a CONTEXT.md that looks intact but is missing the CLI
  // surface — adopters wouldn't know the regen had failed.
  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    if (!template.includes(placeholder)) {
      throw new Error(
        `renderContext: template missing required placeholder: ${placeholder}`,
      );
    }
  }

  const verbsBlock = renderEntries(input.verbs, 'forge orchestrate ');
  const slashBlock = renderEntries(input.slashCommands, '/');

  return template
    .replaceAll('{{METHODOLOGY_VERSION}}', input.version)
    .replaceAll('{{CLI_VERBS_BLOCK}}', verbsBlock)
    .replaceAll('{{SLASH_COMMANDS_BLOCK}}', slashBlock);
}
