import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFreshnessLine,
  formatRelativeAge,
} from '../../../src/core/freshness.ts';
import type { Source } from '../../../src/schemas/phases.ts';

const baseSource = (): Source => ({
  tracker: 'linear',
  project_id: 'proj_abc',
  synced_at: '2026-05-17T22:00:00Z',
  spec_revision: '8fa22260dfb272c0ba61a6b78288942fc1d0f418',
});

test('formatRelativeAge — boundary cases', () => {
  assert.equal(formatRelativeAge(-1), 'in the future');
  assert.equal(formatRelativeAge(0), 'just now');
  assert.equal(formatRelativeAge(59 * 1000), 'just now');
  assert.equal(formatRelativeAge(60 * 1000), '1min');
  assert.equal(formatRelativeAge(47 * 60 * 1000), '47min');
  assert.equal(formatRelativeAge(59 * 60 * 1000), '59min');
  assert.equal(formatRelativeAge(60 * 60 * 1000), '1h');
  assert.equal(formatRelativeAge(3 * 60 * 60 * 1000), '3h');
  assert.equal(formatRelativeAge(23 * 60 * 60 * 1000), '23h');
  assert.equal(formatRelativeAge(24 * 60 * 60 * 1000), '1d');
  assert.equal(formatRelativeAge(30 * 24 * 60 * 60 * 1000), '30d');
});

test('computeFreshnessLine — fresh sync (47min ago) prints standard format', () => {
  const source = baseSource();
  const now = new Date(Date.parse(source.synced_at) + 47 * 60 * 1000);
  const line = computeFreshnessLine(source, now);
  assert.equal(
    line,
    'phases.yaml: synced 47min ago from linear (SPEC@8fa2226)',
  );
});

test('computeFreshnessLine — stale (>24h) prepends ⚠ STALE marker', () => {
  const source = baseSource();
  const now = new Date(Date.parse(source.synced_at) + 25 * 60 * 60 * 1000);
  const line = computeFreshnessLine(source, now);
  assert.ok(line.startsWith('phases.yaml: ⚠ STALE — synced 1d ago from linear'));
  assert.match(line, /\(SPEC@8fa2226\)$/);
});

test('computeFreshnessLine — exactly at 24h boundary is NOT stale', () => {
  const source = baseSource();
  const now = new Date(Date.parse(source.synced_at) + 24 * 60 * 60 * 1000);
  const line = computeFreshnessLine(source, now);
  assert.ok(!line.includes('STALE'));
});

test('computeFreshnessLine — 24h + 1ms IS stale', () => {
  const source = baseSource();
  const now = new Date(Date.parse(source.synced_at) + 24 * 60 * 60 * 1000 + 1);
  const line = computeFreshnessLine(source, now);
  assert.ok(line.includes('⚠ STALE'));
});

test('computeFreshnessLine — missing source uses the documented fallback', () => {
  const line = computeFreshnessLine(undefined);
  assert.equal(
    line,
    'phases.yaml: no source metadata (run forge orchestrate reconcile --pull to sync)',
  );
});

test('computeFreshnessLine — defends against unparseable synced_at past schema', () => {
  const source = { ...baseSource(), synced_at: 'garbage' } as Source;
  const line = computeFreshnessLine(source);
  assert.match(line, /unparseable/);
});

test('computeFreshnessLine — different tracker types appear in output verbatim', () => {
  const linear = computeFreshnessLine(
    { ...baseSource(), tracker: 'linear' },
    new Date(Date.parse(baseSource().synced_at) + 60 * 1000),
  );
  const github = computeFreshnessLine(
    { ...baseSource(), tracker: 'github' },
    new Date(Date.parse(baseSource().synced_at) + 60 * 1000),
  );
  const notion = computeFreshnessLine(
    { ...baseSource(), tracker: 'notion' },
    new Date(Date.parse(baseSource().synced_at) + 60 * 1000),
  );
  assert.ok(linear.includes('from linear'));
  assert.ok(github.includes('from github'));
  assert.ok(notion.includes('from notion'));
});

test('computeFreshnessLine — short spec_revision is sliced cleanly', () => {
  const source = { ...baseSource(), spec_revision: 'abc' };
  const line = computeFreshnessLine(
    source,
    new Date(Date.parse(source.synced_at) + 60 * 1000),
  );
  assert.match(line, /\(SPEC@abc\)$/);
});
