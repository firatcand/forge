import type { Secrets } from '../schemas/settings.ts';
import type { Logger, SecretsManager } from '../secrets-managers/base.ts';
import { EnvFileSecretsManager } from '../secrets-managers/env-file.ts';
import { SecretsError } from '../secrets-managers/errors.ts';

export function createSecretsManager(config: Secrets, logger: Logger): SecretsManager {
  switch (config.manager) {
    case 'env_file':
      return new EnvFileSecretsManager(config, logger);
    case '1password':
    case 'doppler':
    case 'aws_secrets':
    case 'infisical':
      throw new SecretsError(
        'MISCONFIGURED',
        `secrets.manager '${config.manager}' is configured but adapter not yet implemented. ` +
          `Currently available: env_file. 1password and doppler are planned next; aws_secrets and infisical further out. ` +
          `Track progress in plans/BACKLOG.md.`,
        { manager: config.manager },
      );
    default: {
      const _exhaustive: never = config;
      void _exhaustive;
      throw new SecretsError(
        'UNKNOWN',
        `unhandled secrets.manager value: ${String((config as { manager: string }).manager)}`,
      );
    }
  }
}
