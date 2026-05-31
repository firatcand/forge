// Shared dotenv/JSON parser for forge env files.
//
// Extracted from EnvFileSecretsManager so two callers share one dialect:
//   - EnvFileSecretsManager (runtime secrets from settings.secrets.env_file_path)
//   - loadForgeEnv (startup load of per-repo .forge/.env)
//
// Format auto-detect: content (trimmed) starting with '{' or '[' is parsed as
// JSON (must be a string-keyed object); otherwise strict dotenv — KEY=VALUE per
// line, '#' comments, blank lines OK, surrounding "..."/'...' stripped. Exotic
// dotenv features (multi-line values, ${var} interpolation, `export` prefix) are
// rejected with line-numbered PARSE errors.

import { SecretsError } from '../secrets-managers/errors.ts';

export function parseEnvFile(content: string, path: string): Map<string, string> {
  const trimmed = content.trim();

  // JSON format (detected by leading '{' or '['). Arrays are valid JSON but
  // not valid for our schema (we need a string-keyed object), so we let them
  // through the parse and reject with a clear "must be an object" message.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new SecretsError(
        'PARSE',
        `env_file '${path}' starts with JSON delimiter ('{' or '[') but is not valid JSON: ${(e as Error).message}`,
        { path },
        { cause: e },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const what = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
      throw new SecretsError(
        'PARSE',
        `env_file '${path}' JSON must be an object (got ${what})`,
        { path },
      );
    }
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') {
        throw new SecretsError(
          'PARSE',
          `env_file '${path}' JSON value for key '${k}' must be a string (got ${typeof v})`,
          { path, key: k },
        );
      }
      m.set(k, v);
    }
    return m;
  }

  // Dotenv format (strict basics only)
  const m = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      throw new SecretsError(
        'PARSE',
        `env_file '${path}' line ${i + 1}: 'export' prefix not supported. Use 'KEY=VALUE'.`,
        { path, line: i + 1 },
      );
    }
    const eq = line.indexOf('=');
    if (eq < 1) {
      throw new SecretsError(
        'PARSE',
        `env_file '${path}' line ${i + 1}: expected 'KEY=VALUE' format`,
        { path, line: i + 1 },
      );
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (value.includes('${')) {
      throw new SecretsError(
        'PARSE',
        `env_file '${path}' line ${i + 1}: variable interpolation ('\${...}') not supported. Use literal values.`,
        { path, line: i + 1 },
      );
    }
    m.set(key, value);
  }
  return m;
}
