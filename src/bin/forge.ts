#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = { version: string };

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', 'package.json'),
    resolve(here, 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const pkg = JSON.parse(raw) as PackageJson;
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      continue;
    }
  }
  throw new Error('forge: could not locate package.json to resolve version');
}

function printHelp(version: string): void {
  const lines = [
    `forge ${version} — foundations release`,
    '',
    'Usage:',
    '  forge --version       Print the installed version',
    '  forge --help          Show this help',
    '',
    `v${version} ships the schemas, core utilities, and skill/agent assets.`,
    'The full command surface (init, orchestrate, doctor, etc.) lands',
    'incrementally in subsequent patches as Phase 2 tasks ship. See:',
    '  https://github.com/firatcand/forge/blob/main/CHANGELOG.md',
  ];
  console.log(lines.join('\n'));
}

function failUnknown(command: string, version: string): never {
  // Fail loudly per FORGE-6 retro: never silently no-op on commands we do not implement yet.
  const message = [
    `forge: '${command}' is not yet available in ${version}.`,
    '',
    `v${version} is the foundations release; the full CLI (init, orchestrate, doctor, etc.) lands`,
    'incrementally in subsequent patches as Phase 2 tasks ship. See:',
    '  https://github.com/firatcand/forge/blob/main/CHANGELOG.md',
  ].join('\n');
  console.error(message);
  process.exit(1);
}

function failNoCommand(version: string): never {
  // Bare `npx @firatcand/forge` was the v0.2.1 default install entry. Codex caught
  // that silently printing help and exiting 0 here regresses any script depending on
  // that surface — treat no-args as an explicit failure, distinct from `--help`.
  const message = [
    'forge: no command specified.',
    '',
    `v${version} is a foundations release; the install/setup flow that was the v0.2.1`,
    'default (`npx @firatcand/forge`) is not yet available. Use `forge --help` for',
    'currently-supported commands. The full CLI lands in 0.3.x patches:',
    '  https://github.com/firatcand/forge/blob/main/CHANGELOG.md',
  ].join('\n');
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const version = readVersion();

if (args.includes('--help') || args.includes('-h')) {
  printHelp(version);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
  process.exit(0);
}

if (args.length === 0) {
  failNoCommand(version);
}

failUnknown(args[0] ?? '', version);
