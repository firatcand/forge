import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtraForgeFooters,
  serializeWithForgeFooters,
  splitTrailingFooterRegion,
  upsertClaimFooter,
  parseForgeFooters,
  parseClaimFooter,
} from '../../../src/trackers/footers.ts';
import type { ClaimFenceData } from '../../../src/trackers/claim-fence.ts';

// ─── FORGE-118 item 2: footer dedup last-wins ──────────────────────────────

test('parseExtraForgeFooters dedups by KEY keeping the LAST occurrence', () => {
  const body =
    'prose\n\n<!-- forge:task=T-1 -->\n' +
    '<!-- forge:ownerType=old -->\n' +
    '<!-- forge:ownerType=new -->\n';
  const extras = parseExtraForgeFooters(body);
  const ownerTypeFooters = extras.filter((f) => f.includes('forge:ownerType='));
  assert.equal(ownerTypeFooters.length, 1, 'single ownerType footer emitted');
  assert.ok(
    ownerTypeFooters[0].includes('forge:ownerType=new'),
    'last occurrence wins',
  );
});

test('round-trip with a seeded duplicate footer asserts single emission', () => {
  // A body the adapter might re-read with an accidental duplicate extra footer.
  const body =
    'desc\n\n<!-- forge:task=T-7 -->\n' +
    '<!-- forge:ownerType=a -->\n' +
    '<!-- forge:ownerType=b -->\n';
  const { forgeTaskId, blockerIds } = parseForgeFooters(body);
  const extras = parseExtraForgeFooters(body);
  const out = serializeWithForgeFooters(
    'desc',
    forgeTaskId!,
    blockerIds,
    extras,
  );
  assert.equal(
    (out.match(/forge:ownerType=/g) ?? []).length,
    1,
    'serialized output emits ownerType exactly once',
  );
  assert.ok(out.includes('forge:ownerType=b'), 'keeps the last value');
});

// ─── FORGE-118 item 3: trailing-footer-block-only parsing ──────────────────

test('fenced-code-block forge comment is a FALSE positive: stays in body, no footer emitted', () => {
  const body =
    'Here is an example footer:\n\n' +
    '```\n<!-- forge:ownerType=example -->\n```\n\n' +
    '<!-- forge:task=T-1 -->\n';
  const extras = parseExtraForgeFooters(body);
  assert.equal(
    extras.length,
    0,
    'the fenced-block forge comment must NOT be promoted',
  );
  // And it must remain in the body after a serialize round-trip.
  const { head } = splitTrailingFooterRegion(body);
  assert.ok(
    head.includes('```\n<!-- forge:ownerType=example -->\n```'),
    'fenced comment preserved verbatim in the head/body',
  );
});

test('legacy mid-body real forge comment is preserved in place (neither promoted nor stripped)', () => {
  const body =
    'intro\n<!-- forge:ownerType=legacy -->\nmore prose\n\n' +
    '<!-- forge:task=T-1 -->\n<!-- forge:ownerType=trailing -->\n';
  const extras = parseExtraForgeFooters(body);
  // Only the TRAILING ownerType is promoted; the mid-body one is not.
  assert.equal(extras.length, 1);
  assert.ok(extras[0].includes('forge:ownerType=trailing'));

  // Serialize with the trailing extras: the mid-body legacy comment survives.
  const out = serializeWithForgeFooters('intro\n<!-- forge:ownerType=legacy -->\nmore prose', 'T-1', [], extras);
  assert.ok(
    out.includes('intro\n<!-- forge:ownerType=legacy -->\nmore prose'),
    'mid-body legacy comment kept verbatim in prose',
  );
  // Exactly one trailing ownerType (the legacy mid-body one is in prose, not a footer line).
  const trailingPart = out.slice(out.indexOf('forge:task='));
  assert.equal(
    (trailingPart.match(/forge:ownerType=trailing/g) ?? []).length,
    1,
  );
});

test('trailing footers are still parsed normally', () => {
  const body =
    'desc\n\n<!-- forge:task=T-1 -->\n' +
    '<!-- forge:blockedBy=T-2 -->\n' +
    '<!-- forge:ownerType=backend -->\n';
  assert.equal(parseForgeFooters(body).forgeTaskId, 'T-1');
  assert.deepEqual(parseForgeFooters(body).blockerIds, ['T-2']);
  const extras = parseExtraForgeFooters(body);
  assert.ok(extras.some((f) => f.includes('forge:ownerType=backend')));
  assert.ok(!extras.some((f) => f.includes('forge:task')));
  assert.ok(!extras.some((f) => f.includes('forge:blockedBy')));
});

test('upsertClaimFooter round-trip unchanged for a standard trailing-footer body', () => {
  const DATA: ClaimFenceData = {
    claimId: 'c-1',
    generation: 2,
    ownerRunId: 'r-1',
  };
  const body = 'Desc\n\n<!-- forge:task=T-1 -->\n<!-- forge:blockedBy=T-2 -->\n';
  const out = upsertClaimFooter(body, DATA);
  assert.deepEqual(parseClaimFooter(out), DATA);
  assert.equal(parseForgeFooters(out).forgeTaskId, 'T-1');
  assert.deepEqual(parseForgeFooters(out).blockerIds, ['T-2']);
  assert.ok(out.includes('Desc'));
  // No duplication.
  assert.equal((out.match(/forge:task=/g) ?? []).length, 1);
  assert.equal((out.match(/forge:claim=/g) ?? []).length, 1);
});

// ─── splitTrailingFooterRegion unit behavior ───────────────────────────────

test('splitTrailingFooterRegion peels the full contiguous trailing block', () => {
  const body =
    'prose body\n\n<!-- forge:task=T-1 -->\n' +
    '<!-- forge:blockedBy=T-2 -->\n' +
    '<!-- forge:claim={"claim_id":"c","generation":1,"owner_run_id":"r"} -->\n';
  const { head, trailing } = splitTrailingFooterRegion(body);
  assert.equal(head.trimEnd(), 'prose body');
  assert.equal(trailing.length, 3);
  assert.ok(trailing[0].includes('forge:task=T-1'));
  assert.ok(trailing[2].includes('forge:claim='));
});

test('splitTrailingFooterRegion: a comment followed by prose is NOT trailing', () => {
  const body = '<!-- forge:task=T-1 -->\nprose after the comment\n';
  const { head, trailing } = splitTrailingFooterRegion(body);
  assert.equal(trailing.length, 0);
  assert.equal(head, body);
});

test('splitTrailingFooterRegion: empty / no-footer body', () => {
  assert.deepEqual(splitTrailingFooterRegion(''), { head: '', trailing: [] });
  assert.deepEqual(splitTrailingFooterRegion('just prose'), {
    head: 'just prose',
    trailing: [],
  });
  assert.deepEqual(splitTrailingFooterRegion(null), { head: '', trailing: [] });
});

// ─── FORGE-118 finding 1: parseForgeFooters / parseClaimFooter trailing-scoped ─

test('parseForgeFooters: a fenced-example forge:task mid-body does NOT satisfy preconditions', () => {
  // forge:task only inside a fenced code example; no real trailing footer.
  const body =
    'Docs:\n\n```\n<!-- forge:task=EXAMPLE -->\n```\n\nplain prose tail\n';
  const { forgeTaskId, blockerIds } = parseForgeFooters(body);
  assert.equal(
    forgeTaskId,
    undefined,
    'mid-body example forge:task must not be read as a managed footer',
  );
  assert.deepEqual(blockerIds, []);
});

test('parseForgeFooters: a fenced-example forge:blockedBy mid-body is ignored', () => {
  const body =
    'Intro\n\n```md\n<!-- forge:blockedBy=FAKE-1,FAKE-2 -->\n```\n\n' +
    '<!-- forge:task=T-9 -->\n';
  const { forgeTaskId, blockerIds } = parseForgeFooters(body);
  assert.equal(forgeTaskId, 'T-9', 'real trailing task footer still parsed');
  assert.deepEqual(
    blockerIds,
    [],
    'example blockedBy in a fenced block must NOT promote into blockerIds',
  );
});

test('parseClaimFooter: a fenced-example forge:claim mid-body does NOT trigger a claim read (no false CLAIM_MISMATCH)', () => {
  // A prose/fenced example of a claim footer plus a DIFFERENT real trailing claim.
  const real: ClaimFenceData = { claimId: 'real', generation: 3, ownerRunId: 'r' };
  const body = upsertClaimFooter(
    'Example body showing a claim footer:\n\n' +
      '```\n<!-- forge:claim={"claim_id":"EXAMPLE","generation":99,"owner_run_id":"x"} -->\n```\n\n' +
      '<!-- forge:task=T-1 -->\n',
    real,
  );
  const parsed = parseClaimFooter(body);
  assert.deepEqual(
    parsed,
    real,
    'only the real trailing claim is read; the fenced example is ignored',
  );
});

test('parseClaimFooter: a claim footer ONLY inside a fenced block reads as no claim', () => {
  const body =
    'Doc\n\n```\n<!-- forge:claim={"claim_id":"EX","generation":1,"owner_run_id":"r"} -->\n```\n\n' +
    '<!-- forge:task=T-1 -->\n';
  assert.equal(
    parseClaimFooter(body),
    null,
    'a forge:claim that lives only in a fenced example is not the live claim',
  );
});

// ─── FORGE-118 finding 2: fence-aware peeler (unclosed fence) ───────────────

test('splitTrailingFooterRegion: unclosed-fence body with EOF forge comment is NOT peeled', () => {
  // Body ends inside an OPEN fenced code block — the EOF forge comment is
  // literal example content, not a managed footer. Must not be peeled.
  const body =
    'Example (note the fence is never closed):\n\n' +
    '```\n<!-- forge:task=INSIDE-FENCE -->\n';
  const { head, trailing } = splitTrailingFooterRegion(body);
  assert.deepEqual(trailing, [], 'no peel inside an unclosed fence');
  assert.equal(head, body, 'body returned untouched');
  // And parse/promote see nothing.
  assert.equal(parseForgeFooters(body).forgeTaskId, undefined);
  assert.equal(parseExtraForgeFooters(body).length, 0);
});

test('splitTrailingFooterRegion: a CLOSED fence followed by real trailing footers still peels normally', () => {
  const body =
    'Doc with an example:\n\n' +
    '```\n<!-- forge:task=EXAMPLE -->\n```\n\n' +
    '<!-- forge:task=T-5 -->\n<!-- forge:blockedBy=T-6 -->\n';
  const { head, trailing } = splitTrailingFooterRegion(body);
  assert.equal(trailing.length, 2, 'the two REAL trailing footers are peeled');
  assert.ok(trailing[0].includes('forge:task=T-5'));
  assert.ok(trailing[1].includes('forge:blockedBy=T-6'));
  assert.ok(
    head.includes('```\n<!-- forge:task=EXAMPLE -->\n```'),
    'the closed-fence example stays in the head verbatim',
  );
  // parseForgeFooters reads the REAL task, not the example.
  assert.equal(parseForgeFooters(body).forgeTaskId, 'T-5');
  assert.deepEqual(parseForgeFooters(body).blockerIds, ['T-6']);
});
