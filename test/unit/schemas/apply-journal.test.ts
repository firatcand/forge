import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApplyJournalSchema,
  MarkdownSectionEntrySchema,
  PhasesTaskEntrySchema,
  TrackerIssueEntrySchema,
  FinalizeStateSchema,
} from '../../../src/schemas/apply-journal.ts';

const ISO = '2026-05-30T00:00:00.000Z';

function minimalJournal() {
  return {
    version: 1 as const,
    slug: 'switch-tracker-transport',
    started_at: ISO,
  };
}

test('ApplyJournalSchema accepts a minimal journal and defaults the lists/finalize', () => {
  const parsed = ApplyJournalSchema.safeParse(minimalJournal());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.spec_sections, []);
    assert.deepEqual(parsed.data.prd_sections, []);
    assert.deepEqual(parsed.data.phases_tasks, []);
    assert.deepEqual(parsed.data.tracker_issues, []);
    assert.deepEqual(parsed.data.finalize, {
      commit_msg_written: false,
      index_appended: false,
      adr_deleted: false,
      archived: false,
    });
  }
});

test('ApplyJournalSchema rejects a wrong version literal', () => {
  assert.equal(ApplyJournalSchema.safeParse({ ...minimalJournal(), version: 2 }).success, false);
});

test('ApplyJournalSchema rejects a non-kebab slug', () => {
  assert.equal(ApplyJournalSchema.safeParse({ ...minimalJournal(), slug: 'Switch_Tracker' }).success, false);
});

test('ApplyJournalSchema accepts a fully-populated, payload-complete journal', () => {
  const journal = {
    ...minimalJournal(),
    spec_sections: [
      { ref: 'spec/SPEC.md#cli-surface', new_body: '## CLI surface\nnew text', status: 'pending' as const },
    ],
    prd_sections: [
      { ref: 'spec/PRD.md#feature-2', new_body: '## Feature 2\nnew', status: 'applied' as const, applied_at: ISO },
    ],
    phases_tasks: [
      { id: 'P2.5-T04', field: 'acceptance' as const, value: ['a', 'b'], status: 'pending' as const },
    ],
    tracker_issues: [
      { id: 'FORGE-95', new_body: 'updated body', retries: 1, status: 'failed' as const, error: 'timeout' },
    ],
    finalize: { commit_msg_written: true, index_appended: false, adr_deleted: false, archived: false },
    completed_at: ISO,
  };
  const parsed = ApplyJournalSchema.safeParse(journal);
  assert.equal(parsed.success, true);
});

test('MarkdownSectionEntrySchema requires ref + new_body', () => {
  assert.equal(MarkdownSectionEntrySchema.safeParse({ status: 'pending' }).success, false);
  assert.equal(
    MarkdownSectionEntrySchema.safeParse({ ref: 'spec/SPEC.md#x', new_body: 'y', status: 'pending' }).success,
    true,
  );
});

test('PhasesTaskEntrySchema enforces field↔value type pairing + task-id shape', () => {
  // acceptance requires string[]
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'P1-T1', field: 'acceptance', value: 'x', status: 'pending' }).success,
    false,
  );
  // description requires string
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'P1-T1', field: 'description', value: ['x'], status: 'pending' }).success,
    false,
  );
  // unknown field rejected
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'P1-T1', field: 'title', value: 'x', status: 'pending' }).success,
    false,
  );
  // malformed task id rejected
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'nope', field: 'description', value: 'x', status: 'pending' }).success,
    false,
  );
  // happy paths
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'P2.5-T04', field: 'acceptance', value: ['x'], status: 'pending' }).success,
    true,
  );
  assert.equal(
    PhasesTaskEntrySchema.safeParse({ id: 'P1-T1', field: 'description', value: 'new desc', status: 'pending' }).success,
    true,
  );
});

test('TrackerIssueEntrySchema defaults retries to 0', () => {
  const parsed = TrackerIssueEntrySchema.safeParse({ id: 'FORGE-1', new_body: 'b', status: 'pending' });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.retries, 0);
});

test('FinalizeStateSchema defaults all flags to false', () => {
  const parsed = FinalizeStateSchema.safeParse({});
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.commit_msg_written, false);
    assert.equal(parsed.data.archived, false);
  }
});
