import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { NativeBackend } from '../../../src/search/native.ts';
import type { LookupFn, RequestFn } from '../../../src/search/base.ts';
import { SearchError } from '../../../src/search/types.ts';

const publicLookup: LookupFn = (_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]);

function cannedRequest(contentType: string, body: string): RequestFn {
  return (_url, _o, callback) => {
    const res = new EventEmitter() as unknown as {
      statusCode: number;
      headers: Record<string, string>;
      on: EventEmitter['on'];
      destroy: () => void;
    };
    res.statusCode = 200;
    res.headers = { 'content-type': contentType };
    res.destroy = () => {};
    const req = new EventEmitter() as unknown as {
      on: EventEmitter['on'];
      setTimeout: (ms: number, cb: () => void) => unknown;
      destroy: () => void;
      end: () => void;
    };
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      callback(res as never);
      queueMicrotask(() => {
        const r = res as unknown as EventEmitter;
        r.emit('data', Buffer.from(body));
        r.emit('end');
      });
    };
    return req as never;
  };
}

test('NativeBackend.fetchRaw — extracts text from an HTML page + carries raw HTML', async () => {
  const backend = new NativeBackend({
    lookup: publicLookup,
    request: cannedRequest('text/html', '<html><body><h1>Title</h1><p>Body text</p></body></html>'),
  });
  const results = await backend.fetchRaw('http://example.com/');
  assert.equal(results.length, 1);
  assert.match(results[0]!.text, /Title/);
  assert.match(results[0]!.text, /Body text/);
  assert.ok(results[0]!.rawHtml, 'raw HTML is carried for the defense-in-depth scan');
});

test('NativeBackend.fetchRaw — passes plain text through without extraction', async () => {
  const backend = new NativeBackend({
    lookup: publicLookup,
    request: cannedRequest('text/plain', 'raw plain body'),
  });
  const results = await backend.fetchRaw('http://example.com/');
  assert.equal(results[0]!.text, 'raw plain body');
  assert.equal(results[0]!.rawHtml, undefined);
});

test('NativeBackend.searchRaw — throws UNSUPPORTED_OPERATION with provider guidance', async () => {
  const backend = new NativeBackend();
  await assert.rejects(
    async () => backend.searchRaw('q'),
    (e: unknown) =>
      e instanceof SearchError &&
      e.code === 'UNSUPPORTED_OPERATION' &&
      /search\.provider = exa\|parallel\|perplexity/.test(e.message),
  );
});

test('NativeBackend.healthCheck — ok', async () => {
  const backend = new NativeBackend();
  assert.deepEqual(await backend.healthCheck(), { ok: true });
});
