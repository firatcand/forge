import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHarnessVerdict,
  synthesizeVerdict,
} from '../../../src/harnesses/verdict-parser.ts';
import { isHarnessError } from '../../../src/harnesses/base.ts';

const validBlock = JSON.stringify({
  version: 1,
  verdict: 'pass',
  findings: [
    {
      severity: 'improvement',
      path: 'src/foo.ts',
      message: 'consider naming',
    },
  ],
  host: 'codex',
});

test('parseHarnessVerdict extracts fenced JSON block', () => {
  const stdout = `chatter before\n\`\`\`json\n${validBlock}\n\`\`\`\nepilogue`;
  const verdict = parseHarnessVerdict({ host: 'codex', stdout });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.host, 'codex');
  assert.equal(verdict.findings.length, 1);
});

test('parseHarnessVerdict takes the first fenced block when multiple exist', () => {
  const second = JSON.stringify({
    version: 1,
    verdict: 'changes_requested',
    findings: [{ severity: 'block', path: 'x', message: 'no' }],
    host: 'codex',
  });
  const stdout = `\`\`\`json\n${validBlock}\n\`\`\`\nmiddle\n\`\`\`json\n${second}\n\`\`\``;
  const verdict = parseHarnessVerdict({ host: 'codex', stdout });
  assert.equal(verdict.verdict, 'pass');
});

test('parseHarnessVerdict synthesizes when no fenced block present', () => {
  const stdout = 'free-form review text with no JSON block';
  const verdict = parseHarnessVerdict({ host: 'codex', stdout });
  assert.equal(verdict.verdict, 'changes_requested');
  assert.equal(verdict.host, 'codex');
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0].severity, 'improvement');
  assert.match(verdict.findings[0].message, /free-form review text/);
});

test('parseHarnessVerdict synthesizes a no-stdout sentinel when stdout is empty', () => {
  const verdict = parseHarnessVerdict({ host: 'gemini', stdout: '' });
  assert.equal(verdict.host, 'gemini');
  assert.match(verdict.findings[0].message, /produced no stdout/);
});

test('parseHarnessVerdict throws INVALID_STDOUT on malformed JSON', () => {
  const stdout = '```json\n{not-valid-json}\n```';
  assert.throws(
    () => parseHarnessVerdict({ host: 'codex', stdout }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'INVALID_STDOUT' &&
      /failed to parse/.test(err.message),
  );
});

test('parseHarnessVerdict throws INVALID_STDOUT when schema-invalid', () => {
  const bad = JSON.stringify({ version: 1, verdict: 'pass' });
  const stdout = `\`\`\`json\n${bad}\n\`\`\``;
  assert.throws(
    () => parseHarnessVerdict({ host: 'codex', stdout }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'INVALID_STDOUT' &&
      /does not match ReviewVerdictSchema/.test(err.message),
  );
});

test('parseHarnessVerdict rejects verdict whose host disagrees with caller', () => {
  const stdout = `\`\`\`json\n${validBlock}\n\`\`\``;
  assert.throws(
    () => parseHarnessVerdict({ host: 'gemini', stdout }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'INVALID_STDOUT' &&
      /claiming host="codex"/.test(err.message),
  );
});

test('synthesizeVerdict truncates oversize messages at 2000 bytes', () => {
  const huge = 'x'.repeat(5000);
  const verdict = synthesizeVerdict('codex', huge);
  assert.equal(verdict.findings[0].message.length, 2000);
});
