import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeClaimValue,
  decodeClaimValue,
  type ClaimFenceData,
} from '../../../src/trackers/claim-fence.ts';
import {
  parseClaimFooter,
  upsertClaimFooter,
  parseForgeFooters,
  parseExtraForgeFooters,
} from '../../../src/trackers/footers.ts';
import { TrackerError } from '../../../src/trackers/errors.ts';

const DATA: ClaimFenceData = {
  claimId: 'claim-abc',
  generation: 3,
  ownerRunId: 'run-xyz',
};

// ── value schema (claim-fence.ts) ──

test('encode/decode claim value round-trips', () => {
  assert.deepEqual(decodeClaimValue(encodeClaimValue(DATA)), DATA);
});

test('decodeClaimValue: nullish / malformed / missing / typed => null', () => {
  assert.equal(decodeClaimValue(null), null);
  assert.equal(decodeClaimValue(undefined), null);
  assert.equal(decodeClaimValue('not json'), null);
  assert.equal(decodeClaimValue('{"claim_id":}'), null);
  assert.equal(decodeClaimValue('{"claim_id":"c","generation":1}'), null);
  assert.equal(decodeClaimValue('{"claim_id":"c","generation":"1","owner_run_id":"r"}'), null);
  assert.equal(decodeClaimValue('{"claim_id":"","generation":1,"owner_run_id":"r"}'), null);
  assert.equal(decodeClaimValue('{"claim_id":"c","generation":-1,"owner_run_id":"r"}'), null);
  assert.equal(decodeClaimValue('{"claim_id":"c","generation":1.5,"owner_run_id":"r"}'), null);
});

// ── footer integration (footers.ts) ──

const TASK_BODY = 'Issue description.\n\n<!-- forge:task=FORGE-1 -->\n';

test('upsertClaimFooter adds a claim footer that parseClaimFooter reads back', () => {
  const out = upsertClaimFooter(TASK_BODY, DATA);
  assert.deepEqual(parseClaimFooter(out), DATA);
  assert.ok(out.includes('Issue description.'));
  // forge:task footer is preserved.
  assert.equal(parseForgeFooters(out).forgeTaskId, 'FORGE-1');
});

test('parseClaimFooter: absent / malformed => null', () => {
  assert.equal(parseClaimFooter(TASK_BODY), null);
  assert.equal(parseClaimFooter('<!-- forge:claim=not json -->'), null);
  assert.equal(parseClaimFooter(null), null);
});

test('upsertClaimFooter replacing does not duplicate the claim footer', () => {
  const first = upsertClaimFooter(TASK_BODY, DATA);
  const second = upsertClaimFooter(first, { ...DATA, generation: 4 });
  assert.equal((second.match(/forge:claim=/g) ?? []).length, 1);
  assert.equal(parseClaimFooter(second)?.generation, 4);
});

test('upsertClaimFooter(null) removes the claim footer, keeps task/blockedBy', () => {
  const withClaim = upsertClaimFooter(
    'Desc\n\n<!-- forge:task=FORGE-1 -->\n<!-- forge:blockedBy=FORGE-2 -->\n',
    DATA,
  );
  const cleared = upsertClaimFooter(withClaim, null);
  assert.equal(parseClaimFooter(cleared), null);
  assert.equal(parseForgeFooters(cleared).forgeTaskId, 'FORGE-1');
  assert.deepEqual(parseForgeFooters(cleared).blockerIds, ['FORGE-2']);
});

test('upsertClaimFooter preserves other extra footers (e.g. ownerType)', () => {
  const body =
    'Desc\n\n<!-- forge:task=FORGE-1 -->\n<!-- forge:ownerType=backend -->\n';
  const out = upsertClaimFooter(body, DATA);
  const extras = parseExtraForgeFooters(out);
  assert.ok(extras.some((f) => f.includes('forge:ownerType=backend')));
  assert.ok(extras.some((f) => f.includes('forge:claim=')));
  assert.deepEqual(parseClaimFooter(out), DATA);
});

test('upsertClaimFooter throws when the body has no forge:task footer', () => {
  assert.throws(
    () => upsertClaimFooter('plain body, no footer', DATA),
    (err: unknown) => err instanceof TrackerError && err.code === 'PRECONDITION_FAILED',
  );
});
