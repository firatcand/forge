import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ok, fail, EnvelopeSchema, emit } from '../../../src/cli/envelope.ts';

test('ok wraps data in the success envelope shape', () => {
  const env = ok({ count: 3 });
  assert.equal(env.ok, true);
  if (env.ok) assert.deepEqual(env.data, { count: 3 });
});

test('fail builds the error envelope with required fields', () => {
  const env = fail('CODE', 'message text', true);
  assert.equal(env.ok, false);
  if (!env.ok) {
    assert.equal(env.error.code, 'CODE');
    assert.equal(env.error.message, 'message text');
    assert.equal(env.error.retriable, true);
    assert.equal(env.error.details, undefined);
  }
});

test('fail attaches optional details', () => {
  const env = fail('CODE', 'message', false, { extra: 'context' });
  if (!env.ok) {
    assert.deepEqual(env.error.details, { extra: 'context' });
  }
});

test('EnvelopeSchema validates a success envelope', () => {
  const result = EnvelopeSchema.safeParse(ok({ x: 1 }));
  assert.equal(result.success, true);
});

test('EnvelopeSchema validates an error envelope', () => {
  const result = EnvelopeSchema.safeParse(fail('X', 'y', true));
  assert.equal(result.success, true);
});

test('EnvelopeSchema rejects malformed envelopes', () => {
  const result = EnvelopeSchema.safeParse({ ok: true /* missing data */ } as unknown);
  // The schema requires `data` when ok=true.
  assert.equal(result.success, false);
});

test('emit writes JSON to stdout when --json and exits 0 for ok', async (t) => {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  const code = emit(ok({ a: 1 }), { json: true });
  assert.equal(code, 0);
  assert.equal(buf.length, 1);
  assert.deepEqual(JSON.parse(buf[0] ?? ''), { ok: true, data: { a: 1 } });
});

test('emit exits 1 for fail envelopes by default', () => {
  const code = emit(fail('X', 'y', false), { json: true });
  assert.equal(code, 1);
});
