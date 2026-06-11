import { test } from 'node:test';
import assert from 'node:assert/strict';

import { byteBoundedString, truncateUtf8 } from '../../../src/schemas/byte-bounded.ts';

// --- byteBoundedString --------------------------------------------------------

test('byteBoundedString — ASCII at exactly N bytes is accepted', () => {
  const schema = byteBoundedString(8);
  const s = 'abcdefgh'; // 8 ASCII chars = 8 bytes
  assert.equal(Buffer.byteLength(s, 'utf8'), 8);
  assert.equal(schema.safeParse(s).success, true);
});

test('byteBoundedString — ASCII at N+1 bytes is rejected', () => {
  const schema = byteBoundedString(8);
  assert.equal(schema.safeParse('abcdefghi').success, false);
});

test('byteBoundedString — all-emoji within char cap but over byte cap is REJECTED', () => {
  // 600 × '😀' = 1200 UTF-16 code units (<= 2048 .max pre-filter) but 2400 bytes
  // (> 2048) → must be rejected by the byte refine, not slip past the .max.
  const schema = byteBoundedString(2048);
  const s = '😀'.repeat(600);
  assert.equal(s.length, 1200); // UTF-16 code units
  assert.equal(Buffer.byteLength(s, 'utf8'), 2400); // bytes
  assert.equal(schema.safeParse(s).success, false);
});

test('byteBoundedString — CJK over byte cap is rejected', () => {
  const schema = byteBoundedString(2048);
  // '中' is 3 bytes; 800 × 3 = 2400 bytes > 2048.
  const s = '中'.repeat(800);
  assert.equal(Buffer.byteLength(s, 'utf8'), 2400);
  assert.equal(schema.safeParse(s).success, false);
});

test('byteBoundedString — CJK within byte cap is accepted', () => {
  const schema = byteBoundedString(2048);
  // 600 × 3 = 1800 bytes <= 2048.
  const s = '中'.repeat(600);
  assert.equal(schema.safeParse(s).success, true);
});

test('byteBoundedString — { min: 1 } rejects empty string', () => {
  const schema = byteBoundedString(100, { min: 1 });
  assert.equal(schema.safeParse('').success, false);
  assert.equal(schema.safeParse('x').success, true);
});

test('byteBoundedString — default min accepts empty string', () => {
  const schema = byteBoundedString(100);
  assert.equal(schema.safeParse('').success, true);
});

// --- truncateUtf8 -------------------------------------------------------------

test('truncateUtf8 — idempotent on a short string', () => {
  assert.equal(truncateUtf8('hello', 100), 'hello');
});

test('truncateUtf8 — result is always <= maxBytes', () => {
  for (const max of [1, 2, 3, 4, 5, 7, 11, 2048]) {
    const s = '😀a中b'.repeat(50);
    const out = truncateUtf8(s, max);
    assert.ok(Buffer.byteLength(out, 'utf8') <= max, `max=${max}`);
  }
});

test('truncateUtf8 — never splits a 4-byte emoji at the boundary', () => {
  // '😀' is 4 bytes. With a 4-byte budget the emoji fits exactly; with 3 bytes
  // it must be dropped wholesale (no half-surrogate, no replacement char).
  assert.equal(truncateUtf8('😀', 4), '😀');
  assert.equal(truncateUtf8('😀', 3), '');
  assert.equal(truncateUtf8('😀', 1), '');
  // emoji-at-boundary: 'ab😀' = 2 + 4 = 6 bytes. Budget 5 keeps 'ab' only.
  assert.equal(truncateUtf8('ab😀', 5), 'ab');
  assert.equal(truncateUtf8('ab😀', 6), 'ab😀');
});

test('truncateUtf8 — output never contains the U+FFFD replacement char', () => {
  const s = '😀'.repeat(100);
  for (let max = 0; max <= 12; max++) {
    const out = truncateUtf8(s, max);
    assert.ok(!out.includes('�'), `max=${max} produced a replacement char`);
    // Round-trips losslessly through UTF-8 (no lone surrogate).
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
  }
});

test('truncateUtf8 — drops a 3-byte CJK char wholesale at the boundary', () => {
  // '中' is 3 bytes. Budget 2 must drop it entirely.
  assert.equal(truncateUtf8('中', 2), '');
  assert.equal(truncateUtf8('中', 3), '中');
  assert.equal(truncateUtf8('a中', 3), 'a'); // 1 + 3 = 4 > 3 → keep 'a' only.
});

test('truncateUtf8 — combining mark at boundary truncates on a code-point edge', () => {
  // 'e' + combining acute (U+0301, 2 bytes) = 3 bytes total.
  const s = 'é';
  assert.equal(Buffer.byteLength(s, 'utf8'), 3);
  // Budget 1 keeps the base letter, drops the combining mark — still valid UTF-8.
  const out = truncateUtf8(s, 1);
  assert.equal(out, 'e');
  assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
  // Budget 2 still cannot fit the 2-byte combining mark on top of the base (3 > 2).
  assert.equal(truncateUtf8(s, 2), 'e');
  assert.equal(truncateUtf8(s, 3), s);
});

test('truncateUtf8 — maxBytes <= 0 returns empty string', () => {
  assert.equal(truncateUtf8('anything', 0), '');
  assert.equal(truncateUtf8('anything', -5), '');
});
