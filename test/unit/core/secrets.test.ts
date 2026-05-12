import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSecretsManager } from '../../../src/core/secrets.ts';
import type { Secrets } from '../../../src/schemas/settings.ts';
import type { Logger } from '../../../src/secrets-managers/base.ts';
import { EnvFileSecretsManager } from '../../../src/secrets-managers/env-file.ts';
import { SecretsError } from '../../../src/secrets-managers/errors.ts';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

test('createSecretsManager — env_file dispatches to EnvFileSecretsManager', () => {
  const sm = createSecretsManager(
    { manager: 'env_file', env_file_path: './.env.local' },
    noopLogger,
  );
  assert.ok(sm instanceof EnvFileSecretsManager);
  assert.equal(sm.type, 'env_file');
});

const unbuiltCases: Secrets[] = [
  { manager: '1password', vault: 'MyVault' },
  { manager: 'doppler', project: 'p', config: 'c' },
  { manager: 'aws_secrets', region: 'us-east-1' },
  { manager: 'infisical', workspace_id: 'w', env: 'e' },
];

for (const config of unbuiltCases) {
  test(`createSecretsManager — '${config.manager}' throws MISCONFIGURED with actionable message`, () => {
    assert.throws(
      () => createSecretsManager(config, noopLogger),
      (e: unknown) =>
        e instanceof SecretsError &&
        e.code === 'MISCONFIGURED' &&
        e.message.includes(config.manager) &&
        e.message.toLowerCase().includes('backlog') &&
        e.details.manager === config.manager,
    );
  });
}
