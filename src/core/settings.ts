import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SettingsSchema, type Settings } from '../schemas/index.ts';
import { SettingsError } from './errors.ts';

interface CacheEntry {
  mtimeMs: number;
  settings: Settings;
}

const cache = new Map<string, CacheEntry>();

interface YamlParseErrorShape {
  name?: string;
  message?: string;
  code?: string;
  linePos?: ReadonlyArray<{ line: number; col: number }>;
}

function isYamlParseError(err: unknown): err is YamlParseErrorShape {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown };
  return typeof e.name === 'string' && e.name === 'YAMLParseError';
}

function mapFsError(err: unknown, absPath: string): SettingsError {
  const e = err as NodeJS.ErrnoException;
  if (e && e.code === 'ENOENT') {
    return new SettingsError(
      'FILE_NOT_FOUND',
      `settings file not found at ${absPath}`,
      { path: absPath },
      { cause: err },
    );
  }
  return new SettingsError(
    'IO_ERROR',
    `failed to read settings at ${absPath}: ${e?.message ?? String(err)}`,
    { path: absPath, cause: e?.code ?? (e?.message ?? String(err)) },
    { cause: err },
  );
}

function readAndValidate(absPath: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw mapFsError(err, absPath);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    if (isYamlParseError(err)) {
      const first = err.linePos && err.linePos.length > 0 ? err.linePos[0] : undefined;
      throw new SettingsError(
        'YAML_PARSE_ERROR',
        `failed to parse YAML at ${absPath}: ${err.message ?? 'unknown parse error'}`,
        {
          path: absPath,
          cause: err.message ?? String(err),
          ...(first ? { line: first.line, column: first.col } : {}),
        },
        { cause: err },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SettingsError(
      'YAML_PARSE_ERROR',
      `failed to parse YAML at ${absPath}: ${msg}`,
      { path: absPath, cause: msg },
      { cause: err },
    );
  }

  const result = SettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new SettingsError(
      'VALIDATION_ERROR',
      `settings at ${absPath} failed schema validation`,
      { path: absPath, issues: result.error.issues },
      { cause: result.error },
    );
  }
  return result.data;
}

export function loadSettings(filePath: string): Settings {
  const absPath = path.resolve(filePath);
  return readAndValidate(absPath);
}

export function loadSettingsIfChanged(filePath: string): Settings | null {
  const absPath = path.resolve(filePath);

  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    throw mapFsError(err, absPath);
  }

  const prev = cache.get(absPath);
  if (prev && prev.mtimeMs === st.mtimeMs) {
    return null;
  }

  const settings = readAndValidate(absPath);
  cache.set(absPath, { mtimeMs: st.mtimeMs, settings });
  return settings;
}

export function __resetSettingsCacheForTests(): void {
  cache.clear();
}
