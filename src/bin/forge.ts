#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { loadForgeEnv } from '../core/forge-env.ts';
import { runInit } from '../cli/init.ts';
import { runSecondOpinionSuggest } from '../cli/second-opinion-suggest.ts';
import { runProjectStatus } from '../cli/project-status.ts';
import { runStatusline } from '../cli/statusline.ts';
import { dispatchOrchestrate } from '../cli/orchestrate/index.ts';
import { upgrade } from '../cli/upgrade/upgrade.ts';
import { runMigrate } from '../cli/migrate/migrate.ts';
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
    '  forge status [--json] Report this project\'s forge state (read-only)',
    '  forge migrate [--dry-run|--yes]  Migrate a v0.2.x project to v0.4 conventions',
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
// FORGE-202 follow-on: `tripwire-hook` is a PostToolUse hook that must be TOTALLY
// fail-open — it must never throw or emit at startup. readVersion() can throw
// (no resolvable package.json), and it runs BEFORE the hook's own dispatch+guard
// below, so skip it for this command. `version` is never consumed on the
// tripwire-hook path (help/version/no-command are skipped, and the drift/pin
// pre-hooks + loadForgeEnv + dispatch all early-return for `tripwire-hook`).
const version = args[0] === 'tripwire-hook' ? '' : readVersion();

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

// FORGE-197: dispatch `statusline` EARLY — before loadForgeEnv (which reads
// .forge/.env and may emit stderr) and before the drift/pin pre-hooks. A status
// line runs frequently and must be NOISE-FREE: any incidental stderr would
// corrupt the host's prompt. (It is also in the drift/pin skip lists below as
// belt-and-suspenders, but those hooks never run for it because we return here.)
if (command === 'statusline') {
  // A status line must NEVER be noisy or non-zero. Even resolving the cwd can
  // throw (ENOENT/uv_cwd when the working directory was deleted out from under
  // the process), and that would happen BEFORE runStatusline's own guards — so
  // wrap the whole dispatch and degrade to a silent exit 0 on any throw.
  try {
    const result = runStatusline({ cwd: process.cwd(), rest: args.slice(1) });
    process.exit(result.exitCode);
  } catch {
    process.exit(0);
  }
}

// FORGE-202 follow-on: dispatch `tripwire-hook` EARLY — like statusline, BEFORE
// loadForgeEnv and the drift/pin pre-hooks. This verb is a Claude Code
// PostToolUse hook: it reads untrusted JSON from stdin, scans for prompt-
// injection, and must NEVER load repo env/settings or emit incidental noise. It
// is FAIL-OPEN SILENT — any throw here (including a dynamic-import failure)
// degrades to exit 0 so a crashing hook never destabilizes the host session.
// The async dispatch returns immediately, so we gate the synchronous pre-hooks
// below on `command !== 'tripwire-hook'` (and the dispatcher's own guard) so
// neither drift/pin warnings nor loadForgeEnv ever run for this command.
if (command === 'tripwire-hook') {
  void (async () => {
    try {
      const { tripwireHookMain } = await import('../cli/tripwire-hook/index.ts');
      const code = await tripwireHookMain();
      process.exit(code);
    } catch {
      process.exit(0);
    }
  })();
}

// FORGE-153 B8: drift-warning pre-hook. Fires once per CLI invocation when the
// repo's .forge/.version disagrees with the bundled methodology version.
// - Suppressed by FORGE_QUIET=1 (matches design §9 contract).
// - Suppressed for `upgrade` itself — running the verb that fixes drift
//   shouldn't print "run forge upgrade to refresh."
// - Failures are swallowed silently. The pre-hook is a courtesy; never let it
//   break unrelated commands (e.g., when cwd has no .forge/ at all).
function maybeWarnDrift(cmd: string): void {
  // migrate is suppressed for the same reason as upgrade: telling the user to
  // "run forge upgrade" mid-migration is noise — migrate IS the fix path.
  // FORGE-197: statusline is dispatched+exited before this hook ever runs;
  // listed here as belt-and-suspenders so a status line is never noisy.
  if (cmd === 'upgrade' || cmd === 'migrate' || cmd === 'statusline' || cmd === 'tripwire-hook') return;
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

// FORGE-161: methodology-pin mismatch pre-hook. Fires once per CLI invocation
// when the repo's TRACKED `.forge/settings.yaml` `methodology_version` pin
// disagrees with the installed CLI's bundled version. Distinct from
// maybeWarnDrift (which compares the gitignored `.forge/.version` runtime
// marker): the pin is a reviewable, committed team contract.
// - Suppressed for upgrade/migrate (same rationale as drift: those verbs ARE
//   the fix path) and by FORGE_QUIET=1.
// - Best-effort + hardened: lstat first (skip symlinks), size-bound the read,
//   require `typeof methodology_version === 'string'` before comparing.
//   Absent file/field → silent. All errors swallowed.
const PIN_READ_MAX_BYTES = 256 * 1024;
function maybeWarnMethodologyPin(cmd: string): void {
  // FORGE-197: statusline skip — see maybeWarnDrift note above.
  // FORGE-202 follow-on: tripwire-hook skips too (already dispatched above).
  if (cmd === 'upgrade' || cmd === 'migrate' || cmd === 'statusline' || cmd === 'tripwire-hook') return;
  if (process.env.FORGE_QUIET === '1') return;
  try {
    const settingsPath = resolve(process.cwd(), '.forge/settings.yaml');
    const st = lstatSync(settingsPath);
    // Skip symlinks (never follow) and over-large files.
    if (st.isSymbolicLink() || !st.isFile()) return;
    if (st.size > PIN_READ_MAX_BYTES) return;
    const parsed = yamlParse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return;
    const pin = (parsed as { methodology_version?: unknown }).methodology_version;
    if (typeof pin !== 'string') return;
    if (pin === version) return;
    process.stderr.write(
      `forge: this repo pins methodology ${pin}, installed CLI is ${version} — run \`forge upgrade\` (or align installs).\n`,
    );
  } catch {
    // Swallow — pin warnings are best-effort.
  }
}
maybeWarnMethodologyPin(command);

// FORGE-202 follow-on: tripwire-hook was dispatched EARLY (async) above and must
// NOT load repo env or fall into the command dispatch chain (the trailing
// `else` would failUnknown it). Skip everything below for it; its IIFE will
// process.exit when it resolves.
if (command !== 'tripwire-hook') {

// FORGE per-repo tracker credentials: seed process.env from .forge/.env (if any)
// before any command dispatches. Allowlisted + no-override; best-effort.
loadForgeEnv(process.cwd());

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
} else if (command === 'status') {
  // FORGE-159: read-only project-state report. Distinct from
  // `forge orchestrate status` (orchestrator run-state). Synchronous + never
  // writes; always exits 0 (a non-forge dir or degraded section is information).
  const result = runProjectStatus({ cwd: process.cwd(), rest: args.slice(1) });
  process.exit(result.exitCode);
} else if (command === 'second-opinion') {
  // FORGE-150: in-skill second-opinion hint emitter. The `suggest <event>`
  // subcommand prints the next-step nudge at skill end. Synchronous + stateless.
  // NOTE: distinct from `forge orchestrate second-opinion` (the review dispatch
  // verb under the orchestrate namespace) — this is the suggestion emitter.
  const sub = args[1];
  if (sub !== 'suggest') {
    console.error(
      [
        `forge: second-opinion: unknown subcommand '${sub ?? ''}'.`,
        'usage: forge second-opinion suggest <event>',
        '(for review dispatch, see `forge orchestrate second-opinion`)',
      ].join('\n'),
    );
    process.exit(1);
  }
  const result = runSecondOpinionSuggest({ cwd: process.cwd(), argv: args.slice(2) });
  process.exit(result.exitCode);
} else if (command === 'codex-suggest') {
  // FORGE-150: deprecation alias for `forge second-opinion suggest`. Prints ONE
  // stderr warning, then delegates with identical behavior. Removal in v0.6.
  process.stderr.write(
    'forge codex-suggest is deprecated — use `forge second-opinion suggest`; removal in v0.6.\n',
  );
  const result = runSecondOpinionSuggest({ cwd: process.cwd(), argv: args.slice(1) });
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
        console.error('forge upgrade: --add-agent requires a value (claude, codex, gemini, or cursor)');
        process.exit(1);
      }
      if (removeAgentParse === 'MISSING_VALUE') {
        console.error('forge upgrade: --remove-agent requires a value (claude, codex, gemini, or cursor)');
        process.exit(1);
      }
      const addAgent = addAgentParse;
      const removeAgent = removeAgentParse;
      if (addAgent !== null && removeAgent !== null) {
        console.error('forge upgrade: --add-agent and --remove-agent are mutually exclusive (Codex round-1 review)');
        process.exit(1);
      }
      if (addAgent !== null && !isValidAgentKind(addAgent)) {
        console.error(`forge upgrade: --add-agent: unknown agent '${addAgent}' (expected: claude, codex, gemini, cursor)`);
        process.exit(1);
      }
      if (removeAgent !== null && !isValidAgentKind(removeAgent)) {
        console.error(`forge upgrade: --remove-agent: unknown agent '${removeAgent}' (expected: claude, codex, gemini, cursor)`);
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
      // FORGE-197: the statusLine opt-in discovery offer. Printed to stderr at
      // the CLI boundary (kept out of UpgradeResult.stderr so the structured
      // field stays a deterministic contract). Already FORGE_QUIET-gated upstream.
      if (result.discoveryNotice) process.stderr.write(`${result.discoveryNotice}\n`);
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge upgrade failed: ${msg}`);
      process.exit(1);
    }
  })();
} else if (command === 'migrate') {
  // FORGE-109: v0.2.x → v0.4 project migration. Top-level verb (like eject —
  // a project-lifecycle command, not an orchestrator state transition).
  void (async () => {
    try {
      const result = await runMigrate({ cwd: process.cwd(), argv: args.slice(1) });
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge migrate failed: ${msg}`);
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
} else if (command === 'loom') {
  // FORGE-200: the local memory graph (reindex/recall/status). DYNAMIC import
  // (Codex B1) so non-loom commands never load loom code — and crucially never
  // load `node:sqlite` (whose ExperimentalWarning would corrupt the noise-free
  // statusline/--version contract). The sqlite import is itself lazy inside
  // src/memory/local/db.ts:openDb, so even this dispatcher loads zero sqlite
  // until a verb opens the db.
  void (async () => {
    try {
      const { dispatchLoom } = await import('../cli/loom/index.ts');
      const result = await dispatchLoom(args.slice(1), { cwd: process.cwd() });
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge loom failed: ${msg}`);
      process.exit(1);
    }
  })();
} else if (command === 'search') {
  // FORGE-204: the pluggable core search adapter (fetch/query). DYNAMIC import
  // (mirrors the loom branch) so non-search commands never load search code.
  // `forge search fetch` is the first untrusted-text → agent path; every result
  // is Tripwire-scanned at the adapter base.
  void (async () => {
    try {
      const { dispatchSearch } = await import('../cli/search/index.ts');
      const result = await dispatchSearch(args.slice(1), { cwd: process.cwd() });
      process.exit(result.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`forge search failed: ${msg}`);
      process.exit(1);
    }
  })();
} else {
  failUnknown(command, version);
}

} // end: if (command !== 'tripwire-hook')

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

function isValidAgentKind(v: string | null): v is 'claude' | 'codex' | 'gemini' | 'cursor' {
  return v === 'claude' || v === 'codex' || v === 'gemini' || v === 'cursor';
}
