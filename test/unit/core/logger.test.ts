import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  banner,
  section,
  step,
  kv,
  list,
  table,
  spinner,
  errorBlock,
  wrap,
  prompt,
} from '../../../src/core/logger.ts';
import {
  __setJsonlPathForTests,
  __resetForTests,
  __redactForTests,
  __setPromptModuleForTests,
} from '../../../src/core/logger.ts';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

interface CapturedRun {
  stdout: string;
  jsonl: string[];
}

function captureRun(fn: () => void | Promise<void>, envOverride: Record<string, string | undefined> = {}): Promise<CapturedRun> {
  return (async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forge-logger-'));
    const jsonlPath = join(tmp, 'orchestrator.jsonl');
    const prevWrite = process.stdout.write.bind(process.stdout);
    const buf: string[] = [];
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
      buf.push(s);
      return true;
    };
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of Object.keys(envOverride)) {
      prevEnv[k] = process.env[k];
      if (envOverride[k] === undefined) delete process.env[k];
      else process.env[k] = envOverride[k] as string;
    }
    __setJsonlPathForTests(jsonlPath);
    try {
      await fn();
    } finally {
      (process.stdout as unknown as { write: typeof prevWrite }).write = prevWrite;
      for (const k of Object.keys(prevEnv)) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k] as string;
      }
    }
    let jsonl: string[] = [];
    if (existsSync(jsonlPath)) {
      const raw = readFileSync(jsonlPath, 'utf8');
      jsonl = raw.split('\n').filter((l) => l.length > 0);
    }
    rmSync(tmp, { recursive: true, force: true });
    __resetForTests();
    return { stdout: buf.join(''), jsonl };
  })();
}

const UTF8_ENV = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', CI: undefined, FORGE_NO_COLOR: undefined, NO_COLOR: undefined };
const NO_COLOR_ENV = { ...UTF8_ENV, FORGE_NO_COLOR: '1' };
const ASCII_ENV = { ...UTF8_ENV, LANG: 'C', LC_ALL: 'C' };

// ───────── AC1: exports + types ─────────

test('AC1 — all 9 helpers exported and callable', () => {
  assert.equal(typeof banner, 'function');
  assert.equal(typeof section, 'function');
  assert.equal(typeof step, 'function');
  assert.equal(typeof kv, 'function');
  assert.equal(typeof list, 'function');
  assert.equal(typeof table, 'function');
  assert.equal(typeof spinner, 'function');
  assert.equal(typeof prompt, 'function');
  assert.equal(typeof errorBlock, 'function');
});

// ───────── AC2: FORGE_NO_COLOR=1 disables chalk, structure preserved ─────────

test('AC2 — banner with FORGE_NO_COLOR=1 emits no ANSI escapes', async () => {
  const r = await captureRun(() => banner('forge — orchestrate', 'project: x'), NO_COLOR_ENV);
  assert.ok(!/\x1b\[/.test(r.stdout), `unexpected ANSI: ${JSON.stringify(r.stdout)}`);
});

test('AC2 — section stripped color matches no-color output', async () => {
  const a = await captureRun(() => section('Project'), UTF8_ENV);
  const b = await captureRun(() => section('Project'), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC2 — step stripped color matches no-color across statuses', async () => {
  for (const status of ['pass', 'fail', 'pending', 'running', 'skip'] as const) {
    const a = await captureRun(() => step('msg', status), UTF8_ENV);
    const b = await captureRun(() => step('msg', status), NO_COLOR_ENV);
    assert.equal(stripAnsi(a.stdout), b.stdout, `mismatch for status=${status}`);
    assert.ok(!/\x1b\[/.test(b.stdout));
  }
});

test('AC2 — kv stripped color matches no-color', async () => {
  const a = await captureRun(() => kv({ tracker: 'linear', primary_host_cli: 'claude' }), UTF8_ENV);
  const b = await captureRun(() => kv({ tracker: 'linear', primary_host_cli: 'claude' }), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC2 — list stripped color matches no-color', async () => {
  const a = await captureRun(() => list(['one', 'two']), UTF8_ENV);
  const b = await captureRun(() => list(['one', 'two']), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC2 — table stripped color matches no-color', async () => {
  const rows = [{ TASK: 'F-12', PHASE: 'implement' }];
  const a = await captureRun(() => table(rows), UTF8_ENV);
  const b = await captureRun(() => table(rows), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC2 — spinner in no-color mode falls back to step', async () => {
  const r = await captureRun(() => {
    const s = spinner('validating');
    s.succeed('done');
  }, NO_COLOR_ENV);
  assert.ok(!/\x1b\[/.test(r.stdout));
  assert.ok(r.stdout.includes('validating'));
  assert.ok(r.stdout.includes('done'));
});

test('AC2 — errorBlock stripped color matches no-color', async () => {
  const a = await captureRun(() => errorBlock('Tracker failed', 'detail', 'try again'), UTF8_ENV);
  const b = await captureRun(() => errorBlock('Tracker failed', 'detail', 'try again'), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC2 — prompt with mocked module strips color to match no-color', async () => {
  __setPromptModuleForTests({
    async input(opts) {
      return opts.default ?? 'mock';
    },
    async select<T>(opts: { default?: T }): Promise<T> {
      return opts.default as T;
    },
  });
  const a = await captureRun(async () => {
    await prompt('What is your name?', { default: 'forge' });
  }, UTF8_ENV);
  __setPromptModuleForTests({
    async input(opts) {
      return opts.default ?? 'mock';
    },
    async select<T>(opts: { default?: T }): Promise<T> {
      return opts.default as T;
    },
  });
  const b = await captureRun(async () => {
    await prompt('What is your name?', { default: 'forge' });
  }, NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

// ───────── AC3: ASCII fallback ─────────

test('AC3 — ASCII fallback replaces unicode glyphs for step', async () => {
  const r = await captureRun(() => {
    step('ok', 'pass');
    step('bad', 'fail');
    step('wait', 'running');
  }, ASCII_ENV);
  assert.ok(!r.stdout.includes('✓'), 'expected no ✓');
  assert.ok(!r.stdout.includes('✗'), 'expected no ✗');
  assert.ok(!r.stdout.includes('…'), 'expected no …');
  assert.ok(r.stdout.includes('[ok]'));
  assert.ok(r.stdout.includes('[FAIL]'));
  assert.ok(r.stdout.includes('...'));
});

test('AC3 — ASCII fallback replaces hammer in banner', async () => {
  const r = await captureRun(() => banner('hi'), ASCII_ENV);
  assert.ok(!r.stdout.includes('🔨'));
  assert.ok(r.stdout.includes('#'));
});

test('AC3 — ASCII fallback errorBlock uses [FAIL]', async () => {
  const r = await captureRun(() => errorBlock('bad', 'detail'), ASCII_ENV);
  assert.ok(!r.stdout.includes('✗'));
  assert.ok(r.stdout.includes('[FAIL]'));
});

// ───────── prompt redaction (security) ─────────

test('prompt — answer is NOT written to JSONL (credentials may pass through)', async () => {
  const secret = 'sk-very-secret-api-key-value-123';
  __setPromptModuleForTests({
    async input() {
      return secret;
    },
    async select<T>(opts: { default?: T }): Promise<T> {
      return opts.default as T;
    },
  });
  const r = await captureRun(async () => {
    await prompt('Paste your API key', {});
  }, NO_COLOR_ENV);
  assert.equal(r.jsonl.length, 1);
  const line = r.jsonl[0] as string;
  assert.ok(!line.includes(secret), `JSONL leaked the answer: ${line}`);
  const entry = JSON.parse(line) as { fields: Record<string, unknown> };
  assert.equal(Object.prototype.hasOwnProperty.call(entry.fields, 'answer'), false, 'JSONL must not contain an "answer" field');
  assert.equal(entry.fields.question, 'Paste your API key');
  assert.equal(entry.fields.hasDefault, false);
  assert.equal(entry.fields.mode, 'input');
});

test('prompt — select mode marks mode=select and hasDefault correctly', async () => {
  __setPromptModuleForTests({
    async input(opts) {
      return opts.default ?? '';
    },
    async select<T>(opts: { default?: T }): Promise<T> {
      return opts.default as T;
    },
  });
  const r = await captureRun(async () => {
    await prompt('Pick one', { choices: ['a', 'b'], default: 'a' });
  }, NO_COLOR_ENV);
  const entry = JSON.parse(r.jsonl[0] as string) as { fields: Record<string, unknown> };
  assert.equal(entry.fields.mode, 'select');
  assert.equal(entry.fields.hasDefault, true);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.fields, 'answer'), false);
});

// ───────── AC4: redactor ─────────

test('AC4 — redacts top-level *_KEY', () => {
  const out = __redactForTests({ API_KEY: 'secret', name: 'fine' }) as Record<string, unknown>;
  assert.equal(out.API_KEY, '[REDACTED]');
  assert.equal(out.name, 'fine');
});

test('AC4 — redacts *_TOKEN, *_SECRET (case-insensitive)', () => {
  const out = __redactForTests({ AUTH_TOKEN: 'a', stripe_secret: 'b' }) as Record<string, unknown>;
  assert.equal(out.AUTH_TOKEN, '[REDACTED]');
  assert.equal(out.stripe_secret, '[REDACTED]');
});

test('AC4 — redacts password, apikey, api_key exact-match keys', () => {
  const out = __redactForTests({ password: 'p', APIKEY: 'a', api_key: 'k' }) as Record<string, unknown>;
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.APIKEY, '[REDACTED]');
  assert.equal(out.api_key, '[REDACTED]');
});

test('AC4 — redacts nested object', () => {
  const out = __redactForTests({ nested: { OPENAI_KEY: 'x', safe: 1 } }) as { nested: Record<string, unknown> };
  assert.equal(out.nested.OPENAI_KEY, '[REDACTED]');
  assert.equal(out.nested.safe, 1);
});

test('AC4 — redacts inside arrays', () => {
  const out = __redactForTests({ arr: [{ DB_TOKEN: 'x' }, { ok: 'y' }] }) as { arr: Record<string, unknown>[] };
  assert.equal(out.arr[0]?.DB_TOKEN, '[REDACTED]');
  assert.equal(out.arr[1]?.ok, 'y');
});

test('AC4 — does NOT redact non-matching keys (keyboard, tokenize)', () => {
  const out = __redactForTests({ keyboard: 'k', tokenize: 't', secretary: 's' }) as Record<string, unknown>;
  assert.equal(out.keyboard, 'k');
  assert.equal(out.tokenize, 't');
  assert.equal(out.secretary, 's');
});

test('AC4 — circular references replaced with [CIRCULAR]', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  const out = __redactForTests(a) as Record<string, unknown>;
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[CIRCULAR]');
});

test('AC4 — Map keys matching SECRET_KEY_RE are redacted (recurses into Map)', () => {
  const m = new Map<string, unknown>([
    ['API_KEY', 'super-secret-value'],
    ['safe', 'visible'],
  ]);
  const out = __redactForTests({ m }) as { m: Record<string, unknown> };
  assert.equal(out.m.API_KEY, '[REDACTED]');
  assert.equal(out.m.safe, 'visible');
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('super-secret-value'), `serialized leaked: ${serialized}`);
});

test('AC4 — Set containing objects with secret keys recurses and redacts', () => {
  const s = new Set([{ API_KEY: 'leak-me', ok: 1 }, { plain: 'fine' }]);
  const out = __redactForTests({ s }) as { s: Record<string, unknown>[] };
  assert.equal(out.s[0]?.API_KEY, '[REDACTED]');
  assert.equal(out.s[0]?.ok, 1);
  assert.equal(out.s[1]?.plain, 'fine');
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('leak-me'), `serialized leaked: ${serialized}`);
});

test('AC4 — JSONL writer applies redaction in fields', async () => {
  const r = await captureRun(() => kv({ API_KEY: 'secret', plain: 'visible' }), UTF8_ENV);
  assert.ok(r.stdout.includes('secret'), 'stdout shows un-redacted secret');
  assert.equal(r.jsonl.length, 1);
  const entry = JSON.parse(r.jsonl[0] as string) as { fields: { pairs: Record<string, unknown> } };
  assert.equal(entry.fields.pairs.API_KEY, '[REDACTED]');
  assert.equal(entry.fields.pairs.plain, 'visible');
});

// ───────── AC5: snapshot-style byte-exact output (with + without color) ─────────

test('AC5 — banner snapshot (no-color, utf8)', async () => {
  const r = await captureRun(() => banner('forge — orchestrate', 'project: my-product'), NO_COLOR_ENV);
  assert.equal(r.stdout, '🔨 forge — orchestrate\n   project: my-product\n');
});

test('AC5 — banner snapshot (color, utf8)', async () => {
  const r = await captureRun(() => banner('forge — orchestrate', 'project: my-product'), UTF8_ENV);
  assert.equal(stripAnsi(r.stdout), '🔨 forge — orchestrate\n   project: my-product\n');
  assert.ok(/\x1b\[/.test(r.stdout), 'expected ANSI codes in color mode');
});

test('AC5 — section snapshot (no-color)', async () => {
  const r = await captureRun(() => section('Init checks'), NO_COLOR_ENV);
  assert.equal(r.stdout, '\nInit checks\n');
});

test('AC5 — section snapshot (color)', async () => {
  const r = await captureRun(() => section('Init checks'), UTF8_ENV);
  assert.equal(stripAnsi(r.stdout), '\nInit checks\n');
  assert.ok(/\x1b\[/.test(r.stdout));
});

test('AC5 — step snapshot (no-color)', async () => {
  const r = await captureRun(() => {
    step('gh CLI authenticated', 'pass');
    step('Linear MCP not detected', 'fail');
  }, NO_COLOR_ENV);
  assert.equal(r.stdout, '  ✓  gh CLI authenticated\n  ✗  Linear MCP not detected\n');
});

test('AC5 — step snapshot (color)', async () => {
  const r = await captureRun(() => step('gh CLI authenticated', 'pass'), UTF8_ENV);
  assert.equal(stripAnsi(r.stdout), '  ✓  gh CLI authenticated\n');
  assert.ok(/\x1b\[32m/.test(r.stdout) || /\x1b\[/.test(r.stdout));
});

test('AC5 — kv snapshot (no-color)', async () => {
  const r = await captureRun(() => kv({ tracker: 'linear', primary_host_cli: 'claude' }), NO_COLOR_ENV);
  assert.equal(
    r.stdout,
    '  tracker:           linear\n  primary_host_cli:  claude\n',
  );
});

test('AC5 — kv single-pair overload (no-color)', async () => {
  const r = await captureRun(() => kv('tracker', 'linear'), NO_COLOR_ENV);
  assert.equal(r.stdout, '  tracker:  linear\n');
});

test('AC5 — list snapshot (no-color)', async () => {
  const r = await captureRun(() => list(['spec/BRIEF.md written', 'spec/PRD.md written']), NO_COLOR_ENV);
  assert.equal(r.stdout, '  - spec/BRIEF.md written\n  - spec/PRD.md written\n');
});

test('AC5 — list snapshot (color matches no-color stripped)', async () => {
  const a = await captureRun(() => list(['a', 'b']), UTF8_ENV);
  const b = await captureRun(() => list(['a', 'b']), NO_COLOR_ENV);
  assert.equal(stripAnsi(a.stdout), b.stdout);
});

test('AC5 — table snapshot (no-color)', async () => {
  const r = await captureRun(
    () =>
      table([
        { task: 'FORGE-12', phase: 'implement', agent: 'claude' },
        { task: 'FORGE-15', phase: 'review', agent: 'codex' },
      ]),
    NO_COLOR_ENV,
  );
  const expected =
    '  TASK      PHASE      AGENT \n' +
    '  FORGE-12  implement  claude\n' +
    '  FORGE-15  review     codex \n';
  assert.equal(r.stdout, expected);
});

test('AC5 — table snapshot (color)', async () => {
  const r = await captureRun(
    () => table([{ task: 'F-1', phase: 'impl' }]),
    UTF8_ENV,
  );
  assert.ok(/\x1b\[/.test(r.stdout));
});

test('AC5 — spinner snapshot (no-color falls back to step)', async () => {
  const r = await captureRun(() => {
    const s = spinner('validating tracker');
    s.succeed('validated tracker');
  }, NO_COLOR_ENV);
  assert.ok(r.stdout.includes('validating tracker'));
  assert.ok(r.stdout.includes('✓  validated tracker'));
});

test('AC5 — errorBlock snapshot (no-color)', async () => {
  const r = await captureRun(
    () => errorBlock('Tracker validation failed', 'GitHub Issues adapter requires gh CLI.', 're-run forge init'),
    NO_COLOR_ENV,
  );
  const expected =
    '\n' +
    '✗ Tracker validation failed\n' +
    '\n' +
    '   GitHub Issues adapter requires gh CLI.\n' +
    '\n' +
    '   Hint: re-run forge init\n';
  assert.equal(r.stdout, expected);
});

test('AC5 — errorBlock snapshot (color)', async () => {
  const r = await captureRun(() => errorBlock('boom', 'detail'), UTF8_ENV);
  assert.ok(/\x1b\[31m/.test(r.stdout) || /\x1b\[/.test(r.stdout));
});

test('AC5 — prompt snapshot (no-color, mocked)', async () => {
  __setPromptModuleForTests({
    async input(opts) {
      return opts.default ?? '';
    },
    async select<T>(opts: { default?: T }): Promise<T> {
      return opts.default as T;
    },
  });
  const r = await captureRun(async () => {
    const ans = await prompt('What is your project name', { default: 'my-product' });
    assert.equal(ans, 'my-product');
  }, NO_COLOR_ENV);
  assert.equal(r.stdout, '\n');
});

// ───────── ASCII snapshots for unicode helpers ─────────

test('AC3 — banner snapshot in ASCII mode', async () => {
  const r = await captureRun(() => banner('hi'), { ...ASCII_ENV, FORGE_NO_COLOR: '1' });
  assert.equal(r.stdout, '# hi\n');
});

test('AC3 — step snapshot in ASCII mode', async () => {
  const r = await captureRun(() => step('done', 'pass'), { ...ASCII_ENV, FORGE_NO_COLOR: '1' });
  assert.equal(r.stdout, '  [ok]  done\n');
});

test('AC3 — list snapshot in ASCII mode', async () => {
  const r = await captureRun(() => list(['a', 'b']), { ...ASCII_ENV, FORGE_NO_COLOR: '1' });
  assert.equal(r.stdout, '  - a\n  - b\n');
});

test('AC3 — errorBlock snapshot in ASCII mode', async () => {
  const r = await captureRun(() => errorBlock('bad', 'detail'), { ...ASCII_ENV, FORGE_NO_COLOR: '1' });
  assert.equal(
    r.stdout,
    '\n[FAIL] bad\n\n   detail\n',
  );
});

// ───────── JSONL writer behaviors ─────────

test('JSONL — writes one line per call, parseable JSON', async () => {
  const r = await captureRun(() => {
    banner('hi');
    section('Section');
    step('done', 'pass');
  }, NO_COLOR_ENV);
  assert.equal(r.jsonl.length, 3);
  for (const line of r.jsonl) {
    const parsed = JSON.parse(line) as { ts: string; level: string; event: string; helper: string };
    assert.ok(parsed.ts);
    assert.ok(['debug', 'info', 'warn', 'error'].includes(parsed.level));
    assert.ok(parsed.event.startsWith('logger.'));
  }
});

test('JSONL — creates .forge/logs directory if missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'forge-logger-mk-'));
  const path = join(tmp, 'nested', 'a', 'b', 'orchestrator.jsonl');
  __setJsonlPathForTests(path);
  const prevWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    section('hi');
  } finally {
    (process.stdout as unknown as { write: typeof prevWrite }).write = prevWrite;
  }
  assert.ok(existsSync(path), 'expected JSONL file to be created');
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  rmSync(tmp, { recursive: true, force: true });
  __resetForTests();
});

test('JSONL — entries are newline-delimited (no trailing comma, no array brackets)', async () => {
  const r = await captureRun(() => {
    section('a');
    section('b');
  }, NO_COLOR_ENV);
  const raw = r.jsonl.join('\n');
  assert.ok(!raw.includes('['));
  assert.ok(!raw.includes(']'));
  for (const line of r.jsonl) {
    assert.ok(!line.endsWith(','));
  }
});

test('JSONL — FORGE_JSONL_LEVEL=error suppresses info entries', async () => {
  const r = await captureRun(() => {
    section('a');
    step('boom', 'fail');
  }, { ...NO_COLOR_ENV, FORGE_JSONL_LEVEL: 'error' });
  assert.equal(r.jsonl.length, 1);
  const entry = JSON.parse(r.jsonl[0] as string) as { event: string; level: string };
  assert.equal(entry.level, 'error');
});

test('JSONL — FORGE_JSONL_LEVEL gates JSONL only, stdout always shows step', async () => {
  const r = await captureRun(() => {
    step('foo', 'pass');
  }, { ...NO_COLOR_ENV, FORGE_JSONL_LEVEL: 'error' });
  assert.ok(r.stdout.includes('foo'), 'stdout must still render step regardless of JSONL level');
  assert.ok(r.stdout.includes('✓'));
  assert.equal(r.jsonl.length, 0, 'JSONL must be empty when info-level event is gated');
});

// ───────── wrap util ─────────

test('wrap util breaks long lines at word boundaries', () => {
  const out = wrap('one two three four five', 10);
  assert.equal(out, 'one two\nthree four\nfive');
});

test('wrap util preserves short lines', () => {
  assert.equal(wrap('short', 80), 'short');
});

// ───────── status aliases (DESIGN ↔ task description) ─────────

test('status alias — ok maps to pass', async () => {
  const r = await captureRun(() => step('done', 'ok'), NO_COLOR_ENV);
  assert.ok(r.stdout.includes('✓'));
});

test('status alias — warn maps to skip', async () => {
  const r = await captureRun(() => step('skipped', 'warn'), NO_COLOR_ENV);
  assert.ok(r.stdout.includes('→'));
});

// ───────── spinner cleanup safety ─────────

test('spinner — setInterval handle is .unref()ed so a forgotten spinner does not pin the event loop', async () => {
  const realSetInterval = global.setInterval;
  const intervals: NodeJS.Timeout[] = [];
  const unrefCalls: NodeJS.Timeout[] = [];
  (global as unknown as { setInterval: typeof setInterval }).setInterval = ((
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): NodeJS.Timeout => {
    const t = realSetInterval(cb, ms, ...args);
    const origUnref = t.unref.bind(t);
    t.unref = (): NodeJS.Timeout => {
      unrefCalls.push(t);
      return origUnref();
    };
    intervals.push(t);
    return t;
  }) as typeof setInterval;
  const prevIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    await captureRun(() => {
      const s = spinner('forgotten');
      // intentionally never call succeed/fail/stop — ensure unref happened anyway
      void s;
    }, UTF8_ENV);
    assert.ok(intervals.length >= 1, 'expected setInterval to have been called for spinner');
    assert.ok(unrefCalls.length >= 1, 'expected interval.unref() to be called');
    // cleanup: clear leaked intervals so the test runner can exit
    for (const t of intervals) clearInterval(t);
  } finally {
    (global as unknown as { setInterval: typeof setInterval }).setInterval = realSetInterval;
    Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTty, configurable: true });
  }
});

// ───────── spinner stop() shape from task description ─────────

test('spinner.stop() also works (task description shape)', async () => {
  const r = await captureRun(() => {
    const s = spinner('working');
    s.stop('pass', 'done');
  }, NO_COLOR_ENV);
  assert.ok(r.stdout.includes('✓  done'));
});

// ───────── errorBlock(err: Error, context) shape from task description ─────────

test('errorBlock with Error instance overload', async () => {
  const r = await captureRun(() => {
    const err = new Error('boom');
    errorBlock(err, { taskId: 'F-1' });
  }, NO_COLOR_ENV);
  assert.ok(r.stdout.includes('boom'));
  assert.equal(r.jsonl.length, 1);
  const entry = JSON.parse(r.jsonl[0] as string) as { fields: { error: { message: string } } };
  assert.equal(entry.fields.error.message, 'boom');
});

// ───────── table edge cases ─────────

test('table — empty rows shows (no rows)', async () => {
  const r = await captureRun(() => table([]), NO_COLOR_ENV);
  assert.ok(r.stdout.includes('(no rows)'));
});

test('table — mismatched keys fills missing with -', async () => {
  const r = await captureRun(
    () => table([{ a: '1', b: '2' }, { a: '3' }]),
    NO_COLOR_ENV,
  );
  assert.ok(r.stdout.includes('-'));
});

// ───────── kv edge cases ─────────

test('kv — undefined value rendered as -', async () => {
  const r = await captureRun(() => kv({ x: undefined }), NO_COLOR_ENV);
  assert.ok(r.stdout.includes('-'));
});
