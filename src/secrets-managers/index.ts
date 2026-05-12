export type { GetOpts, SecretsManagerType } from './types.ts';
export { SecretsError } from './errors.ts';
export type { SecretsErrorCode } from './errors.ts';
export type { SecretsManager } from './base.ts';
// Logger interface intentionally NOT re-exported to avoid colliding with
// trackers/index.ts (both modules define structurally identical Logger
// interfaces). Import directly from './secrets-managers/base.ts' if needed.
// TODO (BACKLOG): unify Logger into a single core types module.
export { EnvFileSecretsManager } from './env-file.ts';
