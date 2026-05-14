#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../cli/init.ts';
import { runOrchestrateAnswer } from '../cli/orchestrate-answer.ts';
import { runOrchestrateAttach } from '../cli/orchestrate-attach.ts';
import { runOrchestrateQuestions } from '../cli/orchestrate-questions.ts';
import { runOrchestrateStatus } from '../cli/orchestrate-status.ts';

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

const command = args[0] ?? '';

if (command === 'init') {
  // No top-level await: the CJS build target (dist/bin/forge.cjs) doesn't support it.
  const positional = args.slice(1).find((a) => !a.startsWith('-'));
  void (async () => {
    try {
      const result = await runInit({
        cwd: process.cwd(),
        ...(positional ? { positionalName: positional } : {}),
      });
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge init failed: ${msg}`);
      process.exit(1);
    }
  })();
} else if (command === 'orchestrate') {
  dispatchOrchestrate(args.slice(1));
} else {
  failUnknown(command, version);
}

function parseFlag(rest: readonly string[], long: string): string | undefined {
  // Supports `--flag value` and `--flag=value`. Order independent.
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a === `--${long}`) {
      return rest[i + 1];
    }
    if (a.startsWith(`--${long}=`)) {
      return a.slice(long.length + 3);
    }
  }
  return undefined;
}

function hasFlag(rest: readonly string[], long: string): boolean {
  for (const a of rest) {
    if (a === `--${long}` || a.startsWith(`--${long}=`)) return true;
  }
  return false;
}

function firstPositional(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      // Skip the value of a `--flag value` pair (not `--flag=value`).
      if (!a.includes('=') && i + 1 < rest.length && !rest[i + 1]?.startsWith('--')) {
        i += 1;
      }
      continue;
    }
    return a;
  }
  return undefined;
}

function dispatchOrchestrate(rest: readonly string[]): void {
  const sub = rest[0];
  if (!sub) {
    console.error(
      'Usage: forge orchestrate <questions|answer|status|attach> [...]',
    );
    process.exit(1);
  }
  const subArgs = rest.slice(1);
  const forgeDir = parseFlag(subArgs, 'forge-dir') ?? `${process.cwd()}/.forge`;

  if (sub === 'questions') {
    const open = hasFlag(subArgs, 'open');
    const result = runOrchestrateQuestions({ open, forgeDir });
    process.exit(result.exitCode);
  }
  if (sub === 'answer') {
    const questionId = firstPositional(subArgs) ?? '';
    const optionId = parseFlag(subArgs, 'option') ?? '';
    const note = parseFlag(subArgs, 'note');
    const result = runOrchestrateAnswer({
      questionId,
      optionId,
      forgeDir,
      ...(note ? { note } : {}),
    });
    process.exit(result.exitCode);
  }
  if (sub === 'status') {
    const runId = firstPositional(subArgs) ?? parseFlag(subArgs, 'run-id');
    const result = runOrchestrateStatus({
      forgeDir,
      ...(runId ? { runId } : {}),
    });
    process.exit(result.exitCode);
  }
  if (sub === 'attach') {
    const runId = firstPositional(subArgs) ?? parseFlag(subArgs, 'run-id');
    void (async () => {
      const result = await runOrchestrateAttach({
        forgeDir,
        follow: true,
        ...(runId ? { runId } : {}),
      });
      process.exit(result.exitCode);
    })();
    return;
  }
  console.error(
    `forge orchestrate: unknown subcommand '${sub}'. Use questions|answer|status|attach.`,
  );
  process.exit(1);
}
