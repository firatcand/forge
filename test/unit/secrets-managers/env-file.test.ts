import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Logger } from '../../../src/secrets-managers/base.ts';
import { EnvFileSecretsManager } from '../../../src/secrets-managers/env-file.ts';
import { SecretsError } from '../../../src/secrets-managers/errors.ts';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface LoggedCall {
  event: string;
  fields?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const push = (event: string, fields?: Record<string, unknown>): void => {
    calls.push({ event, fields });
  };
  return {
    logger: { debug: push, info: push, warn: push, error: push },
    calls,
  };
}

function setupTempEnvFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-envfile-'));
  const path = join(dir, '.env.local');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMgr(path: string, logger: Logger = noopLogger): EnvFileSecretsManager {
  return new EnvFileSecretsManager({ manager: 'env_file', env_file_path: path }, logger);
}

// ===== Format: JSON object =====

test('JSON object — reads keys', async () => {
  const { path, cleanup } = setupTempEnvFile('{"STRIPE_KEY": "sk_test_123", "DB_URL": "postgres://localhost"}');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('STRIPE_KEY'), 'sk_test_123');
    assert.equal(await sm.get('DB_URL'), 'postgres://localhost');
  } finally {
    cleanup();
  }
});

test('JSON array rejected — must be object', async () => {
  const { path, cleanup } = setupTempEnvFile('["a", "b"]');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('anything'),
      (e: unknown) =>
        e instanceof SecretsError && e.code === 'PARSE' && e.message.includes('must be an object'),
    );
  } finally {
    cleanup();
  }
});

test('JSON object with non-string value rejected', async () => {
  const { path, cleanup } = setupTempEnvFile('{"PORT": 3000}');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('PORT'),
      (e: unknown) =>
        e instanceof SecretsError && e.code === 'PARSE' && e.message.includes("'PORT'"),
    );
  } finally {
    cleanup();
  }
});

test('malformed JSON gives PARSE error', async () => {
  const { path, cleanup } = setupTempEnvFile('{ this is not json');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('anything'),
      (e: unknown) => e instanceof SecretsError && e.code === 'PARSE',
    );
  } finally {
    cleanup();
  }
});

// ===== Format: dotenv =====

test('dotenv — reads KEY=VALUE', async () => {
  const { path, cleanup } = setupTempEnvFile('STRIPE_KEY=sk_test_123\nDB_URL=postgres://localhost\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('STRIPE_KEY'), 'sk_test_123');
    assert.equal(await sm.get('DB_URL'), 'postgres://localhost');
  } finally {
    cleanup();
  }
});

test('dotenv — strips surrounding quotes', async () => {
  const { path, cleanup } = setupTempEnvFile('A="hello world"\nB=\'single\'\nC=unquoted\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('A'), 'hello world');
    assert.equal(await sm.get('B'), 'single');
    assert.equal(await sm.get('C'), 'unquoted');
  } finally {
    cleanup();
  }
});

test('dotenv — ignores blank lines and # comments', async () => {
  const { path, cleanup } = setupTempEnvFile(
    ['# header comment', '', 'KEY1=value1', '', '  # indented comment', 'KEY2=value2', ''].join('\n'),
  );
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('KEY1'), 'value1');
    assert.equal(await sm.get('KEY2'), 'value2');
  } finally {
    cleanup();
  }
});

test('dotenv — empty value returns empty string', async () => {
  const { path, cleanup } = setupTempEnvFile('EMPTY=\nFILLED=value\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('EMPTY'), '');
    assert.equal(await sm.get('FILLED'), 'value');
  } finally {
    cleanup();
  }
});

test('dotenv — only splits on first = in value', async () => {
  const { path, cleanup } = setupTempEnvFile('CONN=postgres://user:pass@host/db?ssl=true\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('CONN'), 'postgres://user:pass@host/db?ssl=true');
  } finally {
    cleanup();
  }
});

test('dotenv — handles CRLF line endings', async () => {
  const { path, cleanup } = setupTempEnvFile('KEY1=value1\r\nKEY2=value2\r\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('KEY1'), 'value1');
    assert.equal(await sm.get('KEY2'), 'value2');
  } finally {
    cleanup();
  }
});

test('dotenv — rejects export prefix with line number', async () => {
  const { path, cleanup } = setupTempEnvFile('OK=yes\nexport FOO=bar\n');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('FOO'),
      (e: unknown) =>
        e instanceof SecretsError &&
        e.code === 'PARSE' &&
        e.message.includes('export') &&
        e.details.line === 2,
    );
  } finally {
    cleanup();
  }
});

test('dotenv — rejects ${var} interpolation', async () => {
  const { path, cleanup } = setupTempEnvFile('URL=http://${HOST}\n');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('URL'),
      (e: unknown) =>
        e instanceof SecretsError && e.code === 'PARSE' && e.message.includes('interpolation'),
    );
  } finally {
    cleanup();
  }
});

test('dotenv — rejects line without =', async () => {
  const { path, cleanup } = setupTempEnvFile('NO_EQUALS_SIGN\n');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('anything'),
      (e: unknown) =>
        e instanceof SecretsError && e.code === 'PARSE' && e.message.includes('KEY=VALUE'),
    );
  } finally {
    cleanup();
  }
});

test('empty file parses to empty map (no keys)', async () => {
  const { path, cleanup } = setupTempEnvFile('');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('anything'),
      (e: unknown) => e instanceof SecretsError && e.code === 'NOT_FOUND',
    );
    const health = await sm.healthCheck();
    assert.equal(health.ok, true);
  } finally {
    cleanup();
  }
});

// ===== Missing-key behavior =====

test('get(missing) — throws NOT_FOUND with key in details', async () => {
  const { path, cleanup } = setupTempEnvFile('PRESENT=yes\n');
  try {
    const sm = makeMgr(path);
    await assert.rejects(
      () => sm.get('ABSENT'),
      (e: unknown) =>
        e instanceof SecretsError && e.code === 'NOT_FOUND' && e.details.key === 'ABSENT',
    );
  } finally {
    cleanup();
  }
});

test('get(missing, { optional: true }) — returns undefined', async () => {
  const { path, cleanup } = setupTempEnvFile('PRESENT=yes\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('ABSENT', { optional: true }), undefined);
    assert.equal(await sm.get('PRESENT', { optional: true }), 'yes');
  } finally {
    cleanup();
  }
});

// ===== Missing file / disappearance =====

test('missing file on first call — throws MISCONFIGURED', async () => {
  const sm = makeMgr('/no/such/path/.env');
  await assert.rejects(
    () => sm.get('anything'),
    (e: unknown) =>
      e instanceof SecretsError &&
      e.code === 'MISCONFIGURED' &&
      typeof e.details.errno === 'string',
  );
});

test('env_file path that is a directory — throws MISCONFIGURED (not raw fs error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-envfile-dir-'));
  try {
    const sm = makeMgr(dir);
    await assert.rejects(
      () => sm.get('anything'),
      (e: unknown) => e instanceof SecretsError && e.code === 'MISCONFIGURED',
    );
    // healthCheck also returns ok=false rather than rethrowing
    const health = await sm.healthCheck();
    assert.equal(health.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file deleted between calls — invalidates cache and throws on subsequent calls', async () => {
  const { path, cleanup } = setupTempEnvFile('A=1\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('A'), '1');
    unlinkSync(path);
    await assert.rejects(
      () => sm.get('A'),
      (e: unknown) => e instanceof SecretsError && e.code === 'MISCONFIGURED',
    );
    await assert.rejects(
      () => sm.get('A'),
      (e: unknown) => e instanceof SecretsError && e.code === 'MISCONFIGURED',
    );
  } finally {
    cleanup();
  }
});

// ===== Cache behavior =====

test('cache invalidated when mtime changes (file rewritten with new value)', async () => {
  const { path, cleanup } = setupTempEnvFile('VERSIONED=v1\n');
  try {
    const sm = makeMgr(path);
    assert.equal(await sm.get('VERSIONED'), 'v1');
    // Wait > mtime granularity, then rewrite
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path, 'VERSIONED=v2\n');
    assert.equal(await sm.get('VERSIONED'), 'v2');
  } finally {
    cleanup();
  }
});

test('concurrent get() calls succeed and return consistent values', async () => {
  const { path, cleanup } = setupTempEnvFile('A=1\nB=2\nC=3\n');
  try {
    const sm = makeMgr(path);
    const results = await Promise.all([sm.get('A'), sm.get('B'), sm.get('C'), sm.get('A')]);
    assert.deepEqual(results, ['1', '2', '3', '1']);
  } finally {
    cleanup();
  }
});

// ===== healthCheck =====

test('healthCheck — ok when file readable + parseable', async () => {
  const { path, cleanup } = setupTempEnvFile('OK=true\n');
  try {
    const sm = makeMgr(path);
    const result = await sm.healthCheck();
    assert.equal(result.ok, true);
    assert.equal(result.detail, undefined);
  } finally {
    cleanup();
  }
});

test('healthCheck — not-ok when file missing, detail mentions path', async () => {
  const sm = makeMgr('/no/such/.env');
  const result = await sm.healthCheck();
  assert.equal(result.ok, false);
  assert.ok(result.detail?.includes('/no/such/.env'), `detail: ${result.detail ?? '<undefined>'}`);
});

test('healthCheck — not-ok when file unparseable', async () => {
  const { path, cleanup } = setupTempEnvFile('{ not valid json');
  try {
    const sm = makeMgr(path);
    const result = await sm.healthCheck();
    assert.equal(result.ok, false);
    assert.ok(result.detail !== undefined && result.detail.length > 0);
  } finally {
    cleanup();
  }
});

// ===== Logging discipline =====

test('logger never receives secret VALUES (only keys, paths, error metadata)', async () => {
  const { logger, calls } = makeCapturingLogger();
  const VALUE = 'do-not-leak-this-value';
  const { path, cleanup } = setupTempEnvFile(`VERY_SECRET=${VALUE}\n`);
  try {
    const sm = new EnvFileSecretsManager({ manager: 'env_file', env_file_path: path }, logger);
    await sm.get('VERY_SECRET');
    try {
      await sm.get('MISSING');
    } catch {
      // expected
    }
    await sm.healthCheck();

    for (const c of calls) {
      assert.ok(!c.event.includes(VALUE), `event leaked value: ${c.event}`);
      if (c.fields) {
        for (const [k, v] of Object.entries(c.fields)) {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          assert.ok(!s.includes(VALUE), `field '${k}' leaked value: ${s}`);
        }
      }
    }
  } finally {
    cleanup();
  }
});
