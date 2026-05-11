import chalk from 'chalk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip' | 'ok' | 'warn';

type CanonicalStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type Helper =
  | 'banner'
  | 'section'
  | 'step'
  | 'kv'
  | 'list'
  | 'table'
  | 'spinner'
  | 'prompt'
  | 'errorBlock';

export interface Spinner {
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(status?: StepStatus, message?: string): void;
}

export interface PromptOpts {
  default?: string;
  choices?: readonly string[];
  validate?: (input: string) => true | string;
}

interface PromptModule {
  input(opts: {
    message: string;
    default?: string;
    validate?: (input: string) => true | string;
  }): Promise<string>;
  select<T>(opts: {
    message: string;
    choices: { name: string; value: T }[];
    default?: T;
  }): Promise<T>;
}

interface LoggerInternal {
  __jsonlPath: string;
  __jsonlDisabled: boolean;
  __widthWarned: boolean;
  __promptModule: PromptModule | null;
}

const internal: LoggerInternal = {
  __jsonlPath: resolve(process.cwd(), '.forge', 'logs', 'orchestrator.jsonl'),
  __jsonlDisabled: false,
  __widthWarned: false,
  __promptModule: null,
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SECRET_KEY_RE = /^(.*_(KEY|TOKEN|SECRET)|PASSWORD|APIKEY|API_KEY)$/i;

function currentLogLevel(): LogLevel {
  const raw = (process.env.FORGE_LOG_LEVEL || 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLogLevel()];
}

function envTrue(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return /^(1|true|yes)$/i.test(v);
}

function isColorDisabled(): boolean {
  return envTrue('FORGE_NO_COLOR') || envTrue('NO_COLOR');
}

function isAsciiMode(): boolean {
  const lang = (process.env.LANG || '') + ' ' + (process.env.LC_ALL || '');
  return !/utf-?8/i.test(lang);
}

function isCi(): boolean {
  return !!process.env.CI;
}

function termWidth(): number {
  const w = process.stdout.columns;
  if (!w || w <= 0) {
    if (!internal.__widthWarned && !process.env.NODE_TEST_CONTEXT) {
      internal.__widthWarned = true;
      writeJsonl('warn', 'logger.width_undefined', 'banner', { default: 80 });
    }
    return 80;
  }
  return w;
}

function styled(role: 'info' | 'success' | 'warn' | 'error' | 'muted' | 'accent', text: string): string {
  if (isColorDisabled()) return text;
  if (chalk.level === 0) chalk.level = 1;
  switch (role) {
    case 'info':
      return chalk.cyan(text);
    case 'success':
      return chalk.green(text);
    case 'warn':
      return chalk.yellow(text);
    case 'error':
      return chalk.red(text);
    case 'muted':
      return chalk.gray(text);
    case 'accent':
      return chalk.bold(text);
  }
}

const GLYPHS_UTF8 = {
  pass: '✓',
  fail: '✗',
  running: '…',
  skip: '→',
  pending: '·',
  hammer: '🔨',
  ellipsis: '…',
  bullet: '-',
  arrow: '→',
};

const GLYPHS_ASCII = {
  pass: '[ok]',
  fail: '[FAIL]',
  running: '...',
  skip: '->',
  pending: '.',
  hammer: '#',
  ellipsis: '...',
  bullet: '-',
  arrow: '->',
};

function glyphs(): typeof GLYPHS_UTF8 {
  return isAsciiMode() ? GLYPHS_ASCII : GLYPHS_UTF8;
}

function canonicalStatus(s: StepStatus): CanonicalStatus {
  if (s === 'ok') return 'pass';
  if (s === 'warn') return 'skip';
  return s;
}

function statusGlyph(s: CanonicalStatus): string {
  const g = glyphs();
  switch (s) {
    case 'pass':
      return g.pass;
    case 'fail':
      return g.fail;
    case 'running':
      return g.running;
    case 'skip':
      return g.skip;
    case 'pending':
      return g.pending;
  }
}

function statusRole(s: CanonicalStatus): 'success' | 'error' | 'info' | 'warn' | 'muted' {
  switch (s) {
    case 'pass':
      return 'success';
    case 'fail':
      return 'error';
    case 'running':
      return 'info';
    case 'skip':
      return 'warn';
    case 'pending':
      return 'muted';
  }
}

function statusLevel(s: CanonicalStatus): LogLevel {
  if (s === 'fail') return 'error';
  if (s === 'skip') return 'warn';
  return 'info';
}

export function wrap(text: string, width: number): string {
  if (width <= 0) return text;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    const words = line.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (!current) {
        current = word;
        continue;
      }
      if (current.length + 1 + word.length <= width) {
        current += ' ' + word;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out.join('\n');
}

function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return '[Buffer]';
  if (value instanceof Map || value instanceof Set) return Array.from(value as Iterable<unknown>);
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return String(value);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

function writeJsonl(level: LogLevel, event: string, helper: Helper, fields?: Record<string, unknown>): void {
  if (internal.__jsonlDisabled) return;
  if (!shouldEmit(level)) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    helper,
  };
  if (fields !== undefined) {
    entry.fields = redact(fields) as Record<string, unknown>;
  }
  const line = JSON.stringify(entry) + '\n';
  try {
    mkdirSync(dirname(internal.__jsonlPath), { recursive: true });
    appendFileSync(internal.__jsonlPath, line);
  } catch (err) {
    internal.__jsonlDisabled = true;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[logger] JSONL writes disabled: ${msg}\n`);
  }
}

function out(line: string): void {
  process.stdout.write(line + '\n');
}

export function banner(title: string, subtitle?: string): void {
  const g = glyphs();
  const head = `${g.hammer} ${styled('accent', title)}`;
  out(head);
  if (subtitle) {
    out(`   ${styled('muted', subtitle)}`);
  }
  writeJsonl('info', 'logger.banner', 'banner', { title, subtitle });
}

export function section(title: string): void {
  out('');
  out(styled('info', styled('accent', title)));
  writeJsonl('info', 'logger.section', 'section', { title });
}

export function step(message: string, status: StepStatus = 'pending'): void {
  const canon = canonicalStatus(status);
  const glyph = statusGlyph(canon);
  const role = statusRole(canon);
  const prefix = styled(role, glyph);
  const lines = message.split('\n');
  const first = lines[0] ?? '';
  out(`  ${prefix}  ${first}`);
  const indent = ' '.repeat(2 + glyph.length + 2);
  for (let i = 1; i < lines.length; i++) {
    out(`${indent}${lines[i]}`);
  }
  writeJsonl(statusLevel(canon), 'logger.step', 'step', { message, status: canon });
}

export function kv(key: string, value: unknown): void;
export function kv(pairs: Record<string, unknown>): void;
export function kv(a: string | Record<string, unknown>, b?: unknown): void {
  const pairs: Record<string, unknown> =
    typeof a === 'string' ? { [a]: b } : a;
  const entries = Object.entries(pairs);
  if (entries.length === 0) return;
  const maxKey = entries.reduce((m, [k]) => Math.max(m, k.length), 0);
  for (const [k, v] of entries) {
    const padded = (k + ':').padEnd(maxKey + 2, ' ');
    const rendered = v === undefined || v === null ? '-' : String(v);
    out(`  ${styled('muted', padded)} ${rendered}`);
  }
  writeJsonl('info', 'logger.kv', 'kv', { pairs });
}

export function list(items: string[]): void {
  const g = glyphs();
  for (const item of items) {
    out(`  ${g.bullet} ${item}`);
  }
  writeJsonl('info', 'logger.list', 'list', { items });
}

export function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    out(`  ${styled('muted', '(no rows)')}`);
    writeJsonl('info', 'logger.table', 'table', { rows });
    return;
  }
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        keys.push(k);
      }
    }
  }
  const widths: Record<string, number> = {};
  for (const k of keys) widths[k] = k.length;
  const stringRows: Record<string, string>[] = rows.map((row) => {
    const r: Record<string, string> = {};
    for (const k of keys) {
      const v = row[k];
      const s = v === undefined || v === null ? '-' : String(v);
      r[k] = s;
      const cur = widths[k] ?? 0;
      if (s.length > cur) widths[k] = s.length;
    }
    return r;
  });
  const tw = termWidth();
  const renderRow = (rec: Record<string, string>, isHeader: boolean): string => {
    const parts: string[] = [];
    for (const k of keys) {
      const w = widths[k] ?? 0;
      const cell = (rec[k] ?? '').padEnd(w, ' ');
      parts.push(isHeader ? styled('accent', cell) : cell);
    }
    let line = '  ' + parts.join('  ');
    const visibleLen = '  ' + keys.map((k) => (rec[k] ?? '').padEnd(widths[k] ?? 0, ' ')).join('  ');
    if (visibleLen.length > tw) {
      const g = glyphs();
      line = visibleLen.slice(0, Math.max(0, tw - g.ellipsis.length)) + g.ellipsis;
    }
    return line;
  };
  const headerRec: Record<string, string> = {};
  for (const k of keys) headerRec[k] = k.toUpperCase();
  out(renderRow(headerRec, true));
  for (const sr of stringRows) {
    out(renderRow(sr, false));
  }
  writeJsonl('info', 'logger.table', 'table', { rows });
}

export function spinner(message: string): Spinner {
  const disabled = isColorDisabled() || isCi() || !process.stdout.isTTY;
  let stopped = false;
  let interval: NodeJS.Timeout | null = null;
  const frames = isAsciiMode() ? ['|', '/', '-', '\\'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const render = (): void => {
    const f = frames[frameIdx % frames.length];
    frameIdx++;
    process.stdout.write(`\r  ${styled('info', f)}  ${message}`);
  };
  if (disabled) {
    step(message, 'running');
  } else {
    render();
    interval = setInterval(render, 250);
  }
  writeJsonl('info', 'logger.spinner.start', 'spinner', { message });
  const finalize = (status: CanonicalStatus, finalMessage?: string): void => {
    if (stopped) return;
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
      process.stdout.write('\r' + ' '.repeat(termWidth() - 1) + '\r');
    }
    const msg = finalMessage ?? message;
    step(msg, status);
    const level: LogLevel = status === 'fail' ? 'warn' : 'info';
    writeJsonl(level, `logger.spinner.${status}`, 'spinner', { message: msg, status });
  };
  return {
    succeed(m?: string): void {
      finalize('pass', m);
    },
    fail(m?: string): void {
      finalize('fail', m);
    },
    stop(status?: StepStatus, m?: string): void {
      const canon = status ? canonicalStatus(status) : 'pass';
      finalize(canon, m);
    },
  };
}

async function loadPromptModule(): Promise<PromptModule> {
  if (internal.__promptModule) return internal.__promptModule;
  const mod = await import('@inquirer/prompts');
  internal.__promptModule = {
    input: mod.input,
    select: mod.select as PromptModule['select'],
  };
  return internal.__promptModule;
}

export function __setPromptModuleForTests(m: PromptModule | null): void {
  internal.__promptModule = m;
}

export async function prompt(question: string, opts: PromptOpts = {}): Promise<string> {
  out('');
  const mod = await loadPromptModule();
  const message = question.endsWith('?') ? question : question + '?';
  const styledDefault =
    opts.default !== undefined ? ` ${styled('muted', `(${opts.default})`)}` : '';
  const fullMessage = message + styledDefault;
  let answer: string;
  if (opts.choices && opts.choices.length > 0) {
    answer = await mod.select<string>({
      message: fullMessage,
      choices: opts.choices.map((c) => ({ name: c, value: c })),
      default: opts.default,
    });
  } else {
    answer = await mod.input({
      message: fullMessage,
      default: opts.default,
      validate: opts.validate,
    });
  }
  writeJsonl('info', 'logger.prompt', 'prompt', { question, answer });
  return answer;
}

export function errorBlock(title: string, detail: string, hint?: string): void;
export function errorBlock(err: Error, context?: Record<string, unknown>): void;
export function errorBlock(
  a: string | Error,
  b?: string | Record<string, unknown>,
  c?: string,
): void {
  let title: string;
  let detail: string;
  let hint: string | undefined;
  let fields: Record<string, unknown> | undefined;
  if (a instanceof Error) {
    title = a.message || a.name;
    detail = a.stack ?? '';
    hint = undefined;
    fields = { error: { name: a.name, message: a.message, stack: a.stack }, context: b };
  } else {
    title = a;
    detail = typeof b === 'string' ? b : '';
    hint = c;
    fields = { title, detail, hint };
  }
  const g = glyphs();
  out('');
  out(`${styled('error', g.fail)} ${styled('error', title)}`);
  if (detail) {
    out('');
    const wrapped = wrap(detail, Math.max(20, termWidth() - 3));
    for (const line of wrapped.split('\n')) {
      out(`   ${line}`);
    }
  }
  if (hint) {
    out('');
    out(`   ${styled('muted', `Hint: ${hint}`)}`);
  }
  writeJsonl('error', 'logger.errorBlock', 'errorBlock', fields);
}

export function __setJsonlPathForTests(path: string): void {
  internal.__jsonlPath = path;
  internal.__jsonlDisabled = false;
}

export function __resetForTests(): void {
  internal.__jsonlPath = resolve(process.cwd(), '.forge', 'logs', 'orchestrator.jsonl');
  internal.__jsonlDisabled = false;
  internal.__widthWarned = false;
  internal.__promptModule = null;
}

export function __redactForTests(value: unknown): unknown {
  return redact(value);
}
