import type { GetOpts, SecretsManagerType } from './types.ts';

export type { GetOpts, SecretsManagerType };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface SecretsManager {
  readonly type: SecretsManagerType;

  get(key: string, opts: { optional: true }): Promise<string | undefined>;
  get(key: string, opts?: { optional?: false | undefined }): Promise<string>;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
