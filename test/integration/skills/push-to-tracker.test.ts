// Contract-level E2E for /push-to-tracker against a real tracker.
//
// /push-to-tracker is a Claude-followed skill — there's no programmatic
// entrypoint to invoke from Node. The closest faithful E2E is to exercise
// the underlying Tracker adapter contract over a real fixture, since that
// IS what the skill calls into. This test does NOT verify that Claude
// follows the SKILL.md instructions; that is covered by the markdown
// contract test at test/unit/skills/push-to-tracker.contract.test.ts.
//
// Mirrors the GitHubTracker E2E pattern (test/integration/trackers/github.test.ts).
//
// Gated by FORGE_E2E_GITHUB=1 + FORGE_E2E_REPO=<throwaway-owner/repo>.
// Skipped by default in CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { execa } from 'execa';

import { GitHubTracker, type Logger } from '../../../src/trackers/index.ts';
import {
  SettingsSchema,
  type GithubTrackerConfig,
} from '../../../src/schemas/settings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', '..', 'fixtures');

const E2E_ENABLED = process.env.FORGE_E2E_GITHUB === '1';
const REPO = process.env.FORGE_E2E_REPO ?? '';
const skip = !E2E_ENABLED || REPO.length === 0;

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

async function ghDeleteIssue(number: number): Promise<void> {
  try {
    await execa('gh', [
      'api',
      `repos/${REPO}/issues/${number}`,
      '--method',
      'DELETE',
    ]);
  } catch {
    // Best-effort cleanup
  }
}

test('fixture: tracker-github.yaml parses against SettingsSchema', () => {
  // Cheap, runs always — guards the fixture shape so the gated E2E
  // doesn't blow up on a malformed fixture file.
  const raw = readFileSync(
    resolve(fixturesDir, 'settings', 'tracker-github.yaml'),
    'utf8',
  );
  const data = parseYaml(raw);
  const result = SettingsSchema.safeParse(data);
  assert.equal(
    result.success,
    true,
    result.success ? '' : JSON.stringify(result.error.issues, null, 2),
  );
  if (!result.success) return;
  assert.equal(result.data.tracker.type, 'github');
});

test('fixture: tracker-notion.yaml parses against SettingsSchema', () => {
  const raw = readFileSync(
    resolve(fixturesDir, 'settings', 'tracker-notion.yaml'),
    'utf8',
  );
  const data = parseYaml(raw);
  const result = SettingsSchema.safeParse(data);
  assert.equal(
    result.success,
    true,
    result.success ? '' : JSON.stringify(result.error.issues, null, 2),
  );
  if (!result.success) return;
  assert.equal(result.data.tracker.type, 'notion');
});

test(
  'integration: /push-to-tracker contract — GitHub adapter createProject → createIssue (loop) → setBlockedBy',
  {
    skip: skip
      ? 'FORGE_E2E_GITHUB!=1 or FORGE_E2E_REPO unset'
      : false,
  },
  async () => {
    // Load the GitHub tracker fixture, but override repo with the
    // throwaway one from env (the fixture's repo is a placeholder).
    const settings = SettingsSchema.parse(
      parseYaml(
        readFileSync(
          resolve(fixturesDir, 'settings', 'tracker-github.yaml'),
          'utf8',
        ),
      ),
    );
    assert.equal(settings.tracker.type, 'github');

    const config: GithubTrackerConfig = {
      type: 'github',
      config: { repo: REPO },
    };
    const tracker = new GitHubTracker(config, noopLogger());

    const health = await tracker.healthCheck();
    assert.equal(health.ok, true, `gh auth not healthy: ${health.detail}`);

    // Mimic phases.yaml — two phases, dependency from P2-T01 → P1-T01.
    const projectName = `forge-e2e-skill-${Date.now()}`;
    const project = await tracker.createProject(projectName, 'e2e for /push-to-tracker');
    assert.ok(project.id);
    assert.ok(project.url);

    type StagedTask = { forgeTaskId: string; issueId: string; dependsOn: string[] };
    const tasks: StagedTask[] = [];

    const phasesYaml = [
      {
        forgeTaskId: 'P1-T01',
        title: '[skill-e2e] bootstrap',
        ownerType: 'backend-dev',
        acceptance: ['boots'],
        dependsOn: [] as string[],
      },
      {
        forgeTaskId: 'P2-T01',
        title: '[skill-e2e] real feature',
        ownerType: 'backend-dev',
        acceptance: ['works end-to-end'],
        dependsOn: ['P1-T01'],
      },
    ];

    const created: number[] = [];
    try {
      // Pass 1 — createIssue per task, deferring depends_on
      for (const task of phasesYaml) {
        const issue = await tracker.createIssue({
          title: task.title,
          body: 'integration test body',
          forgeTaskId: task.forgeTaskId,
          ownerType: task.ownerType,
          acceptance: task.acceptance,
          dependsOn: [],
        });
        created.push(Number(issue.id));
        tasks.push({
          forgeTaskId: task.forgeTaskId,
          issueId: issue.id,
          dependsOn: task.dependsOn,
        });
      }

      // Pass 2 — setBlockedBy for all depends_on edges
      const byTaskId = new Map(tasks.map((t) => [t.forgeTaskId, t.issueId]));
      for (const t of tasks) {
        for (const blockerTaskId of t.dependsOn) {
          const blockerIssueId = byTaskId.get(blockerTaskId);
          assert.ok(
            blockerIssueId,
            `blocker task ${blockerTaskId} should have been created in pass 1`,
          );
          await tracker.setBlockedBy(t.issueId, blockerIssueId);
        }
      }

      // Verify: list active issues, confirm blockerIds populated on the
      // dependent task's body footer.
      const listed = await tracker.listActiveIssues();
      const child = listed.find((i) => i.forgeTaskId === 'P2-T01');
      const parent = listed.find((i) => i.forgeTaskId === 'P1-T01');
      assert.ok(child, 'P2-T01 should be listed');
      assert.ok(parent, 'P1-T01 should be listed');
      assert.deepEqual(child?.blockerIds, [parent!.id]);
    } finally {
      for (const n of created) await ghDeleteIssue(n);
    }
  },
);
