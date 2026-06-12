import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { loadSettings } from '../core/settings.ts';
import { validateUnderRoot } from '../core/workspace.ts';
import type { Settings } from '../schemas/index.ts';

// FORGE-150 — in-skill second-opinion suggestion (formerly FORGE-105 auto-codex).
// Skills (/plan-task, /ship, /update-spec) end with
// `forge second-opinion suggest <event>`, which prints a one-line hint
// suggesting the matching /second-opinion review-* verb.
// Disable levers (in precedence order):
//   1. env `FORGE_AUTO_SECOND_OPINION=0` (primary) OR legacy `FORGE_AUTO_CODEX=0`
//      (honored with a once-per-invocation deprecation note; removal v0.5)
//   2. settings `second_opinion.auto_enabled: false` (primary) OR, when only the
//      legacy block is present, `codex.auto_codex_enabled: false` (removal v0.5)
// Token-cap accounting is NOT implemented in this verb — see FORGE-124.

const SETTINGS_REL_PATH = '.forge/settings.yaml';

// Locked vocabulary per SPEC §Second-opinion suggest hooks.
// Adding a new event = SPEC amendment + new entry here + new caller in a skill.
const EVENT_TO_VERB: Readonly<Record<string, string>> = Object.freeze({
  'plan-task': 'review-plan',
  ship: 'review-impl',
  // Reserved — /update-spec skill doesn't exist yet; registered here so the
  // event is callable the moment that skill lands without another CLI patch.
  'update-spec': 'review-decision',
});

const KNOWN_EVENTS = Object.freeze(Object.keys(EVENT_TO_VERB));

export interface RunSecondOpinionSuggestOptions {
  cwd: string;
  argv: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream | { write: (s: string) => unknown };
  stderr?: NodeJS.WriteStream | { write: (s: string) => unknown };
}

export interface RunSecondOpinionSuggestResult {
  exitCode: number;
}

function writeStderr(target: RunSecondOpinionSuggestOptions['stderr'], line: string): void {
  (target ?? process.stderr).write(`${line}\n`);
}

function writeStdout(target: RunSecondOpinionSuggestOptions['stdout'], line: string): void {
  (target ?? process.stdout).write(`${line}\n`);
}

function isDisableValue(v: string | undefined): boolean {
  if (v === undefined) return false;
  const norm = v.trim().toLowerCase();
  return norm === '0' || norm === 'false' || norm === 'no';
}

// Env-based disable resolution. FORGE_AUTO_SECOND_OPINION is primary; the legacy
// FORGE_AUTO_CODEX is still honored. When the LEGACY var is the ACTIVE disable
// source (primary unset, legacy disables), print a one-line stderr deprecation
// note (suppressed by FORGE_QUIET=1).
interface EnvDisableResult {
  disabled: boolean;
  legacyDeprecationNote: boolean;
}

function resolveEnvDisabled(env: NodeJS.ProcessEnv): EnvDisableResult {
  const primary = env.FORGE_AUTO_SECOND_OPINION;
  if (primary !== undefined) {
    // Primary var present — it wins outright; legacy var is ignored entirely.
    return { disabled: isDisableValue(primary), legacyDeprecationNote: false };
  }
  const legacy = env.FORGE_AUTO_CODEX;
  if (legacy !== undefined && isDisableValue(legacy)) {
    return {
      disabled: true,
      legacyDeprecationNote: env.FORGE_QUIET !== '1',
    };
  }
  return { disabled: false, legacyDeprecationNote: false };
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

interface ResolvedSuggestConfig {
  enabled: boolean;
}

// Read the EXPLICIT-in-file boolean values for both disable levers. The zod
// schema defaults `second_opinion.auto_enabled` to `true`, so the parsed
// Settings object cannot distinguish "explicitly set to true in the file" from
// "schema expanded the default" — which is exactly the distinction precedence
// hinges on (GPT-5.5 review F1). Parse the raw YAML alongside schema validation
// to recover explicit presence. Returns `undefined` for a lever when the key is
// absent or not a boolean. Never throws — callers treat a parse failure as
// "neither explicitly set" and fall back to the schema-validated defaults.
interface ExplicitLevers {
  secondOpinion: boolean | undefined;
  codex: boolean | undefined;
}

function readExplicitLevers(settingsPath: string): ExplicitLevers {
  try {
    const doc = parseDocument(readFileSync(settingsPath, 'utf8'));
    const so = doc.getIn(['second_opinion', 'auto_enabled']);
    const cx = doc.getIn(['codex', 'auto_codex_enabled']);
    return {
      secondOpinion: typeof so === 'boolean' ? so : undefined,
      codex: typeof cx === 'boolean' ? cx : undefined,
    };
  } catch {
    return { secondOpinion: undefined, codex: undefined };
  }
}

// Resolve the settings-level enable flag. Precedence (FORGE-150, hardened per
// GPT-5.5 review F1):
//   1. explicit second_opinion.auto_enabled in the file (ANY boolean) → use it,
//      full stop. An explicit primary value ALWAYS wins over the legacy block —
//      in BOTH directions (new true beats legacy false; new false beats legacy
//      true).
//   2. else explicit legacy codex.auto_codex_enabled in the file → use it
//      (back-compat for un-migrated repos; removal v0.5)
//   3. else true
// Falls back to `enabled: true` when settings.yaml is absent OR malformed.
// Never throws — suggestion must not crash the parent skill on bad config.
function resolveSuggestConfig(
  cwd: string,
  stderrTarget: RunSecondOpinionSuggestOptions['stderr'],
): ResolvedSuggestConfig {
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
      `second-opinion suggest: settings at ${settingsPath} could not be parsed; using defaults`,
    );
    return { enabled: true };
  }

  // Determine explicit presence from the RAW YAML (the schema-validated load
  // above has already proven the file parses; this second parse only recovers
  // which keys the adopter actually wrote).
  const explicit = readExplicitLevers(settingsPath);
  if (explicit.secondOpinion !== undefined) {
    return { enabled: explicit.secondOpinion };
  }
  if (explicit.codex !== undefined) {
    return { enabled: explicit.codex };
  }
  // Neither lever explicitly set — use the schema-defaulted primary value
  // (which is `true` unless a future schema change moves it).
  return { enabled: settings.second_opinion.auto_enabled };
}

function suggestionLine(event: string): string {
  const verb = EVENT_TO_VERB[event];
  if (!verb) throw new Error(`second-opinion suggest: no verb mapping for event '${event}'`);
  return `💡 Suggested next: /second-opinion ${verb} (run with FORGE_AUTO_SECOND_OPINION=0 to disable)`;
}

function printUsage(stderrTarget: RunSecondOpinionSuggestOptions['stderr']): void {
  writeStderr(
    stderrTarget,
    `forge: second-opinion suggest: missing event arg (expected one of: ${KNOWN_EVENTS.join(', ')})`,
  );
  writeStderr(stderrTarget, 'usage: forge second-opinion suggest <event>');
}

const LEGACY_ENV_DEPRECATION =
  'forge: FORGE_AUTO_CODEX is deprecated — use FORGE_AUTO_SECOND_OPINION; removal in v0.5.';

export function runSecondOpinionSuggest(
  opts: RunSecondOpinionSuggestOptions,
): RunSecondOpinionSuggestResult {
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
      `forge: second-opinion suggest: unknown event '${event ?? ''}' (expected one of: ${KNOWN_EVENTS.join(', ')})`,
    );
    return { exitCode: 1 };
  }

  const envDisabled = resolveEnvDisabled(env);
  if (envDisabled.legacyDeprecationNote) {
    writeStderr(opts.stderr, LEGACY_ENV_DEPRECATION);
  }
  if (envDisabled.disabled) {
    return { exitCode: 0 };
  }

  const cfg = resolveSuggestConfig(opts.cwd, opts.stderr);
  if (!cfg.enabled) {
    return { exitCode: 0 };
  }

  writeStdout(opts.stdout, suggestionLine(event));
  return { exitCode: 0 };
}

// Internal-only export for tests that need to assert the event vocabulary.
export const __TEST_ONLY = Object.freeze({ EVENT_TO_VERB, KNOWN_EVENTS });
