// loadForgeEnv — load per-repo tracker credentials from .forge/.env at CLI startup.
//
// Linear API keys (and Notion tokens) are workspace-scoped, so the tracker
// credential belongs to the repo, not the user's machine — unlike a GitHub
// token. forge therefore reads a per-repo .forge/.env (git-ignored) and seeds
// process.env before any command dispatches. The tracker adapters read
// process.env lazily, so populating it here is sufficient with no adapter change.
//
// Two deliberate guards:
//   - Allowlist: .forge/.env loads into the GLOBAL process env, so we only honor
//     a fixed set of tracker-auth keys. A stray NODE_OPTIONS / FORGE_NOOP_TRACKER
//     in the file must never change CLI behavior. Adding a tracker → add its key.
//   - No-override: an already-set var (exported in the shell, injected by CI)
//     always wins; .forge/.env only fills in what's missing.
//
// Best-effort: a missing file is a silent no-op; a malformed file is reported
// loudly (with the parser's precise line message) but never crashes the command —
// `forge status` / diagnostics must keep working when the env file has a typo.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SecretsError } from '../secrets-managers/errors.ts';

import { parseEnvFile } from './env-file-parse.ts';

// Keys forge will seed from .forge/.env. Intentionally an allowlist (see header).
// Adding a tracker means adding its auth env var(s) here.
export const TRACKER_ENV_ALLOWLIST: readonly string[] = [
  'LINEAR_API_KEY',
  'NOTION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'FORGE_NOTION_PARENT_PAGE_ID',
];

const ALLOWED = new Set(TRACKER_ENV_ALLOWLIST);

export function loadForgeEnv(
  cwd: string,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): void {
  const path = resolve(cwd, '.forge', '.env');

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // absent file → silent no-op
    warn(`forge: could not read ${path} (${code ?? 'unknown'}); skipping`);
    return;
  }

  let parsed: Map<string, string>;
  try {
    parsed = parseEnvFile(content, path);
  } catch (err) {
    const detail = err instanceof SecretsError ? err.message : String(err);
    warn(`forge: ignoring malformed .forge/.env — ${detail}`);
    return;
  }

  for (const [key, value] of parsed) {
    if (!ALLOWED.has(key)) continue; // allowlist
    if (process.env[key] !== undefined) continue; // no-override
    process.env[key] = value;
  }
}
