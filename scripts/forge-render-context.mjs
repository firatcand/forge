#!/usr/bin/env node
// FORGE-152 (Phase A interim, throwaway): render .forge/CONTEXT.md + write
// .forge/.version against the bundled templates + CLI registry.
//
// This is the new-clone bootstrap script for the forge repo itself between
// Phase A merge and Phase B's `forge upgrade` shipping. Run via:
//
//   npm run forge:render-context
//
// Behavior matches src/cli/init/scaffold.ts:
//   - Read templates/CONTEXT.template.md
//   - Render with CLI_VERBS + SLASH_COMMANDS from src/cli/registry.ts
//   - Write .forge/CONTEXT.md + .forge/.version (gitignored after first init).
//
// Phase B (FORGE-153) replaces this with `forge upgrade`, which adds
// strict edit-detection + --force --bak + drift warning. Delete this file
// when Phase B lands.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// Use tsx's import register so we can import the TS sources directly without
// a build step. Run via `node --import tsx scripts/forge-render-context.mjs`
// (npm script wires this).
const { renderContext } = await import('../src/cli/upgrade/render-context.ts');
const { CLI_VERBS, SLASH_COMMANDS } = await import('../src/cli/registry.ts');

const templatePath = resolve(repoRoot, 'templates/CONTEXT.template.md');
const template = readFileSync(templatePath, 'utf8');

const require_ = createRequire(import.meta.url);
const pkg = require_(resolve(repoRoot, 'package.json'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('forge-render-context: package.json has no usable version string');
  process.exit(1);
}

const rendered = renderContext(template, {
  version,
  verbs: CLI_VERBS,
  slashCommands: SLASH_COMMANDS,
});

const forgeDir = resolve(repoRoot, '.forge');
if (!existsSync(forgeDir)) {
  mkdirSync(forgeDir, { recursive: true });
}

writeFileSync(resolve(forgeDir, 'CONTEXT.md'), rendered);
writeFileSync(resolve(forgeDir, '.version'), `${version}\n`);

console.log(`forge-render-context: wrote .forge/CONTEXT.md and .forge/.version (v${version})`);
