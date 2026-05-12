import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SecretsError, type SecretsErrorCode } from '../../../src/secrets-managers/errors.ts';

test('SecretsError — constructs for each code with name/message/details defaulted', () => {
  const codes: SecretsErrorCode[] = ['NOT_FOUND', 'MISCONFIGURED', 'PARSE', 'UNKNOWN'];
  for (const code of codes) {
    const err = new SecretsError(code, `msg for ${code}`);
    assert.equal(err.name, 'SecretsError');
    assert.equal(err.code, code);
    assert.equal(err.message, `msg for ${code}`);
    assert.deepEqual(err.details, {});
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SecretsError);
  }
});

test('SecretsError — preserves details', () => {
  const err = new SecretsError('PARSE', 'malformed', { path: '/x/.env', line: 5 });
  assert.deepEqual(err.details, { path: '/x/.env', line: 5 });
});

test('SecretsError — preserves cause via Error options', () => {
  const inner = new Error('inner');
  const err = new SecretsError('MISCONFIGURED', 'wrapped', {}, { cause: inner });
  assert.equal(err.cause, inner);
});
