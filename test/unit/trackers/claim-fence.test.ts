import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaimFence,
  stripClaimFence,
  upsertClaimFence,
  type ClaimFenceData,
} from '../../../src/trackers/claim-fence.ts';

const DATA: ClaimFenceData = {
  claimId: 'claim-abc',
  generation: 3,
  ownerRunId: 'run-xyz',
};

test('parseClaimFence: round-trips a fence written by upsertClaimFence', () => {
  const body = upsertClaimFence('Some issue description.', DATA);
  const parsed = parseClaimFence(body);
  assert.deepEqual(parsed, DATA);
});

test('parseClaimFence: returns null when no fence present', () => {
  assert.equal(parseClaimFence('plain body, no fence'), null);
  assert.equal(parseClaimFence(''), null);
  assert.equal(parseClaimFence(null), null);
  assert.equal(parseClaimFence(undefined), null);
});

test('parseClaimFence: malformed JSON => null (never throws)', () => {
  assert.equal(parseClaimFence('<!-- forge:claim:{not json} -->'), null);
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":} -->'), null);
});

test('parseClaimFence: missing/typed fields => null', () => {
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":"c","generation":1} -->'), null);
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":"c","generation":"1","owner_run_id":"r"} -->'), null);
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":"","generation":1,"owner_run_id":"r"} -->'), null);
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":"c","generation":-1,"owner_run_id":"r"} -->'), null);
  assert.equal(parseClaimFence('<!-- forge:claim:{"claim_id":"c","generation":1.5,"owner_run_id":"r"} -->'), null);
});

test('upsertClaimFence: preserves existing non-fence body content', () => {
  const original = '# Title\n\nBody paragraph.\n';
  const out = upsertClaimFence(original, DATA);
  assert.ok(out.includes('# Title'));
  assert.ok(out.includes('Body paragraph.'));
  assert.deepEqual(parseClaimFence(out), DATA);
});

test('upsertClaimFence: replacing an existing fence does not duplicate it', () => {
  const first = upsertClaimFence('desc', DATA);
  const second = upsertClaimFence(first, { ...DATA, generation: 4 });
  // Only one fence remains, with the new generation.
  const matches = second.match(/forge:claim:/g) ?? [];
  assert.equal(matches.length, 1);
  assert.equal(parseClaimFence(second)?.generation, 4);
  assert.ok(second.startsWith('desc'));
});

test('upsertClaimFence: empty base yields just the fence', () => {
  const out = upsertClaimFence('', DATA);
  assert.deepEqual(parseClaimFence(out), DATA);
});

test('stripClaimFence: removes the fence, leaves the rest', () => {
  const body = upsertClaimFence('keep this', DATA);
  const stripped = stripClaimFence(body);
  assert.equal(parseClaimFence(stripped), null);
  assert.ok(stripped.includes('keep this'));
  assert.ok(!stripped.includes('forge:claim'));
});

test('stripClaimFence: nullish => empty string', () => {
  assert.equal(stripClaimFence(null), '');
  assert.equal(stripClaimFence(undefined), '');
  assert.equal(stripClaimFence(''), '');
});
