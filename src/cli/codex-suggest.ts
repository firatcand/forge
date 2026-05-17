import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { loadSettings } from '../core/settings.ts';
import { validateUnderRoot } from '../core/workspace.ts';
import type { Settings } from '../schemas/index.ts';

// FORGE-105 (P2.5-T13) — auto-codex in-skill hooks.
// Skills (/plan-task, /ship) end with `forge codex-suggest <event>`, which
// prints a one-line hint suggesting the matching /codex review-* verb.
// Disable levers: env `FORGE_AUTO_CODEX=0` OR settings `codex.auto_codex_enabled: false`.
// Token-cap accounting is NOT implemented in this verb — see plan §6 Q2.

const SETTINGS_REL_PATH = '.forge/settings.yaml';

// Locked vocabulary per SPEC §Auto-codex skill-level hooks (line 950-955).
// Adding a new event = SPEC amendment + new entry here + new caller in a skill.
const EVENT_TO_VERB: Readonly<Record<string, string>> = Object.freeze({
  'plan-task': 'review-plan',
  ship: 'review-impl',
  // Reserved — /update-spec skill doesn't exist yet; registered here so the
  // event is callable the moment that skill lands without another CLI patch.
  'update-spec': 'review-decision',
});

const KNOWN_EVENTS = Object.freeze(Object.keys(EVENT_TO_VERB));

export interface RunCodexSuggestOptions {
  cwd: string;
  argv: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream | { write: (s: string) => unknown };
  stderr?: NodeJS.WriteStream | { write: (s: string) => unknown };
}

export interface RunCodexSuggestResult {
  exitCode: number;
}

function writeStderr(target: RunCodexSuggestOptions['stderr'], line: string): void {
  (target ?? process.stderr).write(`${line}\n`);
}

function writeStdout(target: RunCodexSuggestOptions['stdout'], line: string): void {
  (target ?? process.stdout).write(`${line}\n`);
}

function isEnvDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.FORGE_AUTO_CODEX;
  if (v === undefined) return false;
  const norm = v.trim().toLowerCase();
  return norm === '0' || norm === 'false' || norm === 'no';
}

// Resolve the main checkout root from cwd via git-common-dir. Returns null
// if cwd is not in a git repo (e.g., test fixtures outside any worktree).
// Uses execFileSync (not execSync) — no shell, no injection surface.
//
// Path-trust hardening (Codex F1, confidence 8): Git honors GIT_DIR /
// GIT_WORK_TREE / GIT_COMMON_DIR env vars and would resolve the common-dir
// relative to those, not cwd. An attacker who can set those env vars could
// redirect us to a `.forge/settings.yaml` outside the user's actual project.
// We strip those vars before invoking git so resolution is anchored on cwd.
function resolveGitCommonRoot(cwd: string): string | null {
  const sanitizedEnv = { ...process.env };
  delete sanitizedEnv.GIT_DIR;
  delete sanitizedEnv.GIT_WORK_TREE;
  delete sanitizedEnv.GIT_COMMON_DIR;
  delete sanitizedEnv.GIT_CEILING_DIRECTORIES;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    const commonDir = path.isAbsolute(out) ? out : path.resolve(cwd, out);
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

// Resolve the settings.yaml path: cwd first, then main checkout via
// git-common-dir. Returns null if neither location has the file.
function resolveSettingsPath(cwd: string): string | null {
  const direct = path.resolve(cwd, SETTINGS_REL_PATH);
  try {
    const safe = validateUnderRoot(direct, cwd);
    if (existsSync(safe)) return safe;
  } catch {
    // PATH_ESCAPE or NOT_FOUND on cwd — fall through to git-common-dir resolution.
  }

  const mainRoot = resolveGitCommonRoot(cwd);
  if (!mainRoot || mainRoot === cwd) return null;
  const mainSettings = path.resolve(mainRoot, SETTINGS_REL_PATH);
  try {
    const safe = validateUnderRoot(mainSettings, mainRoot);
    if (existsSync(safe)) return safe;
  } catch {
    // ignore — fall through to defaults
  }
  return null;
}

interface ResolvedCodexConfig {
  enabled: boolean;
}

// Read settings.codex.auto_codex_enabled. Falls back to schema default (true)
// when settings.yaml is absent OR malformed. Never throws — codex-suggest
// must not crash the parent skill on bad config.
function resolveCodexConfig(
  cwd: string,
  stderrTarget: RunCodexSuggestOptions['stderr'],
): ResolvedCodexConfig {
  const settingsPath = resolveSettingsPath(cwd);
  if (!settingsPath) {
    return { enabled: true };
  }

  let settings: Settings;
  try {
    settings = loadSettings(settingsPath);
  } catch {
    writeStderr(
      stderrTarget,
      `codex-suggest: settings at ${settingsPath} could not be parsed; using defaults`,
    );
    return { enabled: true };
  }

  return { enabled: settings.codex.auto_codex_enabled };
}

function suggestionLine(event: string): string {
  const verb = EVENT_TO_VERB[event];
  if (!verb) throw new Error(`codex-suggest: no verb mapping for event '${event}'`);
  return `💡 Suggested next: /codex ${verb} (run with FORGE_AUTO_CODEX=0 to disable)`;
}

function printUsage(stderrTarget: RunCodexSuggestOptions['stderr']): void {
  writeStderr(
    stderrTarget,
    `forge: codex-suggest: missing event arg (expected one of: ${KNOWN_EVENTS.join(', ')})`,
  );
  writeStderr(stderrTarget, 'usage: forge codex-suggest <event>');
}

export function runCodexSuggest(opts: RunCodexSuggestOptions): RunCodexSuggestResult {
  const env = opts.env ?? process.env;
  const argv = opts.argv;

  if (argv.length === 0) {
    printUsage(opts.stderr);
    return { exitCode: 1 };
  }

  const event = argv[0];
  if (event === undefined || !(event in EVENT_TO_VERB)) {
    writeStderr(
      opts.stderr,
      `forge: codex-suggest: unknown event '${event ?? ''}' (expected one of: ${KNOWN_EVENTS.join(', ')})`,
    );
    return { exitCode: 1 };
  }

  if (isEnvDisabled(env)) {
    return { exitCode: 0 };
  }

  const cfg = resolveCodexConfig(opts.cwd, opts.stderr);
  if (!cfg.enabled) {
    return { exitCode: 0 };
  }

  writeStdout(opts.stdout, suggestionLine(event));
  return { exitCode: 0 };
}

// Internal-only export for tests that need to assert the event vocabulary.
export const __TEST_ONLY = Object.freeze({ EVENT_TO_VERB, KNOWN_EVENTS });
