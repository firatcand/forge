// EnvFileSecretsManager — reads secrets from a local file in JSON or dotenv format.
//
// Format auto-detect: if file content (trimmed) starts with '{', parsed as JSON object.
// Otherwise parsed as strict dotenv (KEY=VALUE per line, # comments, blank lines OK,
// surrounding "..." or '...' stripped). Exotic dotenv features (multi-line values,
// ${var} interpolation, `export` prefix) are rejected with line-numbered PARSE errors.
//
// Caching: mtime-based. First call reads + parses + caches; subsequent calls re-stat
// the file and reuse the cache if mtime is unchanged. If the file disappears between
// calls, the cache is invalidated (file-deletion-as-revocation semantic) and subsequent
// calls throw MISCONFIGURED until the file is restored.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnvFile } from '../core/env-file-parse.ts';
import type { EnvFileSecrets } from '../schemas/settings.ts';

import type { GetOpts, Logger, SecretsManager } from './base.ts';
import { SecretsError } from './errors.ts';

export class EnvFileSecretsManager implements SecretsManager {
  readonly type = 'env_file' as const;

  private readonly config: EnvFileSecrets;
  private readonly logger: Logger;
  private cache: Map<string, string> | null = null;
  private cacheMtimeMs: number | null = null;

  constructor(config: EnvFileSecrets, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async get(key: string, opts: { optional: true }): Promise<string | undefined>;
  async get(key: string, opts?: { optional?: false | undefined }): Promise<string>;
  async get(key: string, opts?: GetOpts): Promise<string | undefined> {
    const map = this.loadIfChanged();
    if (!map.has(key)) {
      if (opts?.optional) return undefined;
      throw new SecretsError(
        'NOT_FOUND',
        `key '${key}' not found in env_file '${this.config.env_file_path}'`,
        { key, path: this.config.env_file_path },
      );
    }
    this.logger.debug('secrets.get', { manager: 'env_file', key });
    return map.get(key);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      this.loadIfChanged();
      return { ok: true };
    } catch (e) {
      if (e instanceof SecretsError) {
        return { ok: false, detail: e.message };
      }
      throw e;
    }
  }

  private loadIfChanged(): Map<string, string> {
    const path = resolve(this.config.env_file_path);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      // File missing: invalidate cache (revocation semantic), then throw.
      this.cache = null;
      this.cacheMtimeMs = null;
      const cause = err as NodeJS.ErrnoException;
      throw new SecretsError(
        'MISCONFIGURED',
        `env_file path '${path}' does not exist or is unreadable (${cause.code ?? 'unknown'})`,
        { path, errno: cause.code },
        { cause: err },
      );
    }

    if (this.cache && this.cacheMtimeMs === mtimeMs) {
      return this.cache;
    }

    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      // Path stat'd successfully but read failed: directory, permission loss
      // after stat, deletion between stat and read, etc. Treat as MISCONFIGURED
      // (revocation semantic) and clear cache so subsequent calls also throw.
      this.cache = null;
      this.cacheMtimeMs = null;
      const cause = err as NodeJS.ErrnoException;
      throw new SecretsError(
        'MISCONFIGURED',
        `env_file path '${path}' could not be read (${cause.code ?? 'unknown'})`,
        { path, errno: cause.code },
        { cause: err },
      );
    }
    const map = parseEnvFile(content, path);
    this.cache = map;
    this.cacheMtimeMs = mtimeMs;
    return map;
  }
}
