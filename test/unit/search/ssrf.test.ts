import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  hardenedFetch,
  isPublicAddress,
  type LookupFn,
  type RequestFn,
} from '../../../src/search/base.ts';
import { SearchError } from '../../../src/search/types.ts';

// A lookup that returns a fixed address (or addresses) for ANY hostname. Used to
// simulate a public hostname whose DNS record points at a private IP (rebind
// shape) and to confirm the public-only wrapper rejects it BEFORE connecting.
function fixedLookup(...addrs: { address: string; family: number }[]): LookupFn {
  return (_hostname, _options, callback) => {
    callback(null, addrs);
  };
}

// A request transport that should NEVER be called when the guard rejects. If it
// IS called, the test fails loudly (proves no network is hit on a blocked host).
const explodingRequest: RequestFn = () => {
  throw new Error('transport must not be called for a blocked target');
};

// A transport that behaves like node:https: it invokes options.lookup (as the
// socket would) and, if the lookup errors, emits that error on the request —
// exactly the path that turns a private-resolution into an SSRF_BLOCKED. Used to
// exercise the custom-lookup rebind defense without a real socket.
const lookupInvokingRequest: RequestFn = (url, options, _callback) => {
  const req = new EventEmitter() as unknown as {
    on: EventEmitter['on'];
    setTimeout: (ms: number, cb: () => void) => unknown;
    destroy: () => void;
    end: () => void;
  };
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = () => {
    const host = new URL(url).hostname;
    const lookup = (options as { lookup?: LookupFn }).lookup!;
    lookup(host, { all: true } as never, (err) => {
      queueMicrotask(() => {
        if (err) (req as unknown as EventEmitter).emit('error', err);
        else (req as unknown as EventEmitter).emit('error', new Error('should not connect'));
      });
    });
  };
  return req as never;
};

// A transport that returns a canned 200 text/plain body — used for the
// happy/redirect paths so we never touch the network.
function cannedRequest(
  script: (url: string) => { status: number; headers?: Record<string, string>; body?: string },
): RequestFn {
  return (url, _options, callback) => {
    const plan = script(url);
    const res = new EventEmitter() as unknown as {
      statusCode: number;
      headers: Record<string, string>;
      on: EventEmitter['on'];
      destroy: () => void;
    };
    res.statusCode = plan.status;
    res.headers = plan.headers ?? { 'content-type': 'text/plain' };
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
        if (plan.status >= 200 && plan.status < 300) {
          if (plan.body !== undefined) (res as unknown as EventEmitter).emit('data', Buffer.from(plan.body));
          (res as unknown as EventEmitter).emit('end');
        }
      });
    };
    return req as never;
  };
}

// ── isPublicAddress unit matrix ──────────────────────────────────────────────

test('isPublicAddress — blocks loopback / private / link-local / CGNAT / reserved v4', () => {
  for (const a of [
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '198.18.0.1', // benchmarking
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '255.255.255.255',
  ]) {
    assert.equal(isPublicAddress(a), false, `${a} must be non-public`);
  }
});

test('isPublicAddress — allows genuine public v4', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isPublicAddress(a), true, `${a} must be public`);
  }
});

test('isPublicAddress — blocks v6 loopback / ULA / link-local / mapped-private', () => {
  for (const a of [
    '::1',
    '::',
    'fc00::1', // unique-local
    'fd00::1',
    'fe80::1', // link-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:10.0.0.1',
  ]) {
    assert.equal(isPublicAddress(a), false, `${a} must be non-public`);
  }
});

test('isPublicAddress — allows public v6 and mapped-public', () => {
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

// ── hardenedFetch scheme + host-literal rejection (no transport needed) ──────

test('hardenedFetch — rejects non-http(s) schemes', async () => {
  for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/x', 'gopher://x']) {
    await assert.rejects(
      () => hardenedFetch(url, undefined, { request: explodingRequest }),
      (e: unknown) => e instanceof SearchError && e.code === 'SCHEME_REJECTED',
      url,
    );
  }
});

test('hardenedFetch — rejects loopback / metadata hostnames + literals', async () => {
  const blocked = [
    'http://localhost/',
    'http://localhost./', // trailing dot
    'http://foo.localhost/',
    'http://metadata.google.internal/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
  ];
  for (const url of blocked) {
    await assert.rejects(
      () => hardenedFetch(url, undefined, { request: explodingRequest }),
      (e: unknown) => e instanceof SearchError && e.code === 'SSRF_BLOCKED',
      url,
    );
  }
});

test('hardenedFetch — rejects octal/hex/integer host encodings', async () => {
  for (const url of [
    'http://2130706433/', // 127.0.0.1 as integer
    'http://0x7f000001/', // hex
    'http://0177.0.0.1/', // octal first octet
    'http://0x7f.0.0.1/',
  ]) {
    await assert.rejects(
      () => hardenedFetch(url, undefined, { request: explodingRequest }),
      (e: unknown) => e instanceof SearchError && e.code === 'SSRF_BLOCKED',
      url,
    );
  }
});

// ── DNS-rebind shape: public hostname → private A-record → rejected by lookup ─

test('hardenedFetch — public hostname resolving to a private IP is rejected (no connect)', async () => {
  await assert.rejects(
    () =>
      hardenedFetch('http://evil.example.com/', undefined, {
        lookup: fixedLookup({ address: '169.254.169.254', family: 4 }),
        request: lookupInvokingRequest,
      }),
    (e: unknown) => e instanceof SearchError && e.code === 'SSRF_BLOCKED',
  );
});

test('hardenedFetch — rejects if ANY resolved address is private (mixed records)', async () => {
  await assert.rejects(
    () =>
      hardenedFetch('http://evil.example.com/', undefined, {
        lookup: fixedLookup(
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ),
        request: lookupInvokingRequest,
      }),
    (e: unknown) => e instanceof SearchError && e.code === 'SSRF_BLOCKED',
  );
});

// ── Redirect to a blocked host is re-guarded at the hop ──────────────────────

test('hardenedFetch — redirect from an allowed host to a blocked host is rejected', async () => {
  let calls = 0;
  const req = cannedRequest((url) => {
    calls += 1;
    if (url.startsWith('http://good.example.com')) {
      return { status: 302, headers: { location: 'http://169.254.169.254/' } };
    }
    throw new Error(`transport must not follow into ${url}`);
  });
  await assert.rejects(
    () =>
      hardenedFetch('http://good.example.com/', undefined, {
        lookup: fixedLookup({ address: '8.8.8.8', family: 4 }),
        request: req,
      }),
    (e: unknown) => e instanceof SearchError && e.code === 'SSRF_BLOCKED',
  );
  assert.equal(calls, 1, 'transport must be called once (the first hop only)');
});

// ── allowPrivate opt-out actually bypasses the guard ─────────────────────────

test('hardenedFetch — allowPrivate lets a loopback target through', async () => {
  const req = cannedRequest(() => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'ok',
  }));
  const res = await hardenedFetch('http://127.0.0.1/', { allowPrivate: true }, {
    lookup: fixedLookup({ address: '127.0.0.1', family: 4 }),
    request: req,
  });
  assert.equal(res.body, 'ok');
});

// ── Happy path with a public resolution ──────────────────────────────────────

test('hardenedFetch — public host happy path returns body', async () => {
  const req = cannedRequest(() => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'hello world',
  }));
  const res = await hardenedFetch('http://example.com/', undefined, {
    lookup: fixedLookup({ address: '93.184.216.34', family: 4 }),
    request: req,
  });
  assert.equal(res.body, 'hello world');
  assert.equal(res.contentType, 'text/plain');
});
