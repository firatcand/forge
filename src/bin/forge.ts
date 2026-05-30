#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../cli/init.ts';
import { runCodexSuggest } from '../cli/codex-suggest.ts';
import { dispatchOrchestrate } from '../cli/orchestrate/index.ts';
import { upgrade } from '../cli/upgrade/upgrade.ts';
import { eject as ejectRun, type EjectResult } from '../cli/eject/eject.ts';
import {
  checkVersionDrift,
  formatDriftWarning,
} from '../cli/upgrade/version-check.ts';
import type { AgentKind } from '../cli/upgrade/agent-root-files.ts';

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

// Global --help / --version only fire when they're the first argument.
// Subcommands (e.g., `forge orchestrate run --help`) keep --help so the
// dispatcher can render scoped usage.
if (args[0] === '--help' || args[0] === '-h') {
  printHelp(version);
  process.exit(0);
}

if (args[0] === '--version' || args[0] === '-v') {
  console.log(version);
  process.exit(0);
}

if (args.length === 0) {
  failNoCommand(version);
}

const command = args[0] ?? '';

// FORGE-153 B8: drift-warning pre-hook. Fires once per CLI invocation when the
// repo's .forge/.version disagrees with the bundled methodology version.
// - Suppressed by FORGE_QUIET=1 (matches design §9 contract).
// - Suppressed for `upgrade` itself — running the verb that fixes drift
//   shouldn't print "run forge upgrade to refresh."
// - Failures are swallowed silently. The pre-hook is a courtesy; never let it
//   break unrelated commands (e.g., when cwd has no .forge/ at all).
function maybeWarnDrift(cmd: string): void {
  if (cmd === 'upgrade') return;
  if (process.env.FORGE_QUIET === '1') return;
  try {
    const drift = checkVersionDrift({ cwd: process.cwd(), currentVersion: version });
    if (drift) {
      process.stderr.write(`${formatDriftWarning(drift)}\n`);
    }
  } catch {
    // Swallow — drift warnings are best-effort.
  }
}
maybeWarnDrift(command);

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
  void (async () => {
    const result = await dispatchOrchestrate(args.slice(1), { cwd: process.cwd() });
    process.exit(result.exitCode);
  })();
} else if (command === 'codex-suggest') {
  // FORGE-105: in-skill auto-codex hint emitter. Synchronous + stateless;
  // safe to call from /plan-task and /ship at skill end.
  const result = runCodexSuggest({ cwd: process.cwd(), argv: args.slice(1) });
  process.exit(result.exitCode);
} else if (command === 'upgrade') {
  void (async () => {
    try {
      const flags = args.slice(1);
      const addAgentParse = readFlagValue(flags, '--add-agent');
      const removeAgentParse = readFlagValue(flags, '--remove-agent');
      const force = flags.includes('--force');
      const dryRun = flags.includes('--dry-run');
      const confirm = flags.includes('--confirm');
      const migrateClaudemd = flags.includes('--migrate-claudemd');

      // Reject ambiguous flag states early — fail before any work.
      if (addAgentParse === 'MISSING_VALUE') {
        console.error('forge upgrade: --add-agent requires a value (claude, codex, or gemini)');
        process.exit(1);
      }
      if (removeAgentParse === 'MISSING_VALUE') {
        console.error('forge upgrade: --remove-agent requires a value (claude, codex, or gemini)');
        process.exit(1);
      }
      const addAgent = addAgentParse;
      const removeAgent = removeAgentParse;
      if (addAgent !== null && removeAgent !== null) {
        console.error('forge upgrade: --add-agent and --remove-agent are mutually exclusive (Codex round-1 review)');
        process.exit(1);
      }
      if (addAgent !== null && !isValidAgentKind(addAgent)) {
        console.error(`forge upgrade: --add-agent: unknown agent '${addAgent}' (expected: claude, codex, gemini)`);
        process.exit(1);
      }
      if (removeAgent !== null && !isValidAgentKind(removeAgent)) {
        console.error(`forge upgrade: --remove-agent: unknown agent '${removeAgent}' (expected: claude, codex, gemini)`);
        process.exit(1);
      }
      // FORGE-154 (plan Q3): --migrate-claudemd is mutually exclusive with
      // every other write-modifying flag. Migration is one-shot legacy
      // support; the other flags assume a v0.5-shape repo. --dry-run is
      // allowed (preview the migration without writes).
      if (migrateClaudemd) {
        const conflicting: string[] = [];
        if (force) conflicting.push('--force');
        if (addAgent !== null) conflicting.push('--add-agent');
        if (removeAgent !== null) conflicting.push('--remove-agent');
        if (confirm) conflicting.push('--confirm');
        if (conflicting.length > 0) {
          console.error(
            `forge upgrade: --migrate-claudemd is mutually exclusive with ${conflicting.join(', ')}. Run migration first, then re-run upgrade with the other flags.`,
          );
          process.exit(1);
        }
      }

      const result = await upgrade({
        cwd: process.cwd(),
        force,
        dryRun,
        confirm,
        migrateClaudemd,
        ...(addAgent !== null ? { addAgent: addAgent as AgentKind } : {}),
        ...(removeAgent !== null ? { removeAgent: removeAgent as AgentKind } : {}),
      });

      if (result.stderr) process.stderr.write(`${result.stderr}\n`);
      for (const f of result.filesChanged) {
        process.stdout.write(`changed: ${f}\n`);
      }
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge upgrade failed: ${msg}`);
      process.exit(1);
    }
  })();
} else if (command === 'eject') {
  // FORGE-158: clean uninstall. Top-level verb only (not under orchestrate —
  // it's a project-lifecycle command, not an orchestrator state transition).
  const flags = args.slice(1);
  const restoreParse = readFlagValue(flags, '--restore');
  if (restoreParse === 'MISSING_VALUE') {
    console.error('forge eject: --restore requires a backup directory path');
    process.exit(1);
  }
  const result = ejectRun({
    cwd: process.cwd(),
    confirm: flags.includes('--confirm'),
    noBackup: flags.includes('--no-backup'),
    ...(restoreParse !== null ? { restore: restoreParse } : {}),
  });
  process.stdout.write(`${renderEject(result, flags.includes('--confirm'))}\n`);
  process.exit(result.exitCode);
} else {
  failUnknown(command, version);
}

function renderEject(result: EjectResult, confirm: boolean): string {
  const out: string[] = [];
  if (result.mode === 'noop') {
    return result.stderr;
  }
  if (result.mode === 'refused') {
    return result.stderr;
  }
  if (result.mode === 'restored') {
    out.push(`forge eject --restore: restored ${result.planned.length} path(s) from ${result.backupDir}`);
    for (const p of result.planned) out.push(`  restored: ${p.path}`);
  } else {
    const verb = result.mode === 'applied' ? 'Removed' : 'Would remove';
    out.push(confirm ? 'forge eject: done.' : 'forge eject (dry-run — pass --confirm to apply):');
    for (const p of result.planned) out.push(`  ${verb.toLowerCase()}: [${p.action}] ${p.path}`);
    if (result.backupDir) out.push(`Backup snapshot: ${result.backupDir} (restore via \`forge eject --restore ${result.backupDir}\`)`);
  }
  for (const w of result.warnings) out.push(`⚠ ${w}`);
  return out.join('\n');
}

// Returns: the flag's value (string), 'MISSING_VALUE' sentinel if the flag is
// present but has no value (e.g., `--add-agent` with nothing after, or followed
// by another flag), or null if the flag is absent entirely.
function readFlagValue(flags: string[], name: string): string | 'MISSING_VALUE' | null {
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (f === name) {
      const next = flags[i + 1];
      // Missing entirely OR next token is another flag → treat as missing value.
      if (next === undefined || next.startsWith('--')) return 'MISSING_VALUE';
      return next;
    }
    if (f.startsWith(`${name}=`)) {
      const v = f.slice(name.length + 1);
      // `--flag=` with nothing after the equals.
      return v.length === 0 ? 'MISSING_VALUE' : v;
    }
  }
  return null;
}

function isValidAgentKind(v: string | null): v is 'claude' | 'codex' | 'gemini' {
  return v === 'claude' || v === 'codex' || v === 'gemini';
}
