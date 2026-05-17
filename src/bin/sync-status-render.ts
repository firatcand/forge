#!/usr/bin/env node

// Internal helper invoked by skills/sync-status/SKILL.md.
// Reads issues JSON from stdin, phases.yaml path from argv, prints diagnostic.

import { loadPhases } from '../core/index.ts';
import { buildDiagnostic, renderReport } from '../sync-status/index.ts';
import type { Issue } from '../trackers/types.ts';
import type { RenderMode } from '../sync-status/index.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fail(msg: string, exit = 1): never {
  process.stderr.write(`forge-sync-status-render: ${msg}\n`);
  process.exit(exit);
}

async function main(): Promise<void> {
  const [, , phasesPath, ...rest] = process.argv;
  if (!phasesPath) {
    fail('usage: forge-sync-status-render <phases.yaml> [--json] < issues.json');
  }
  const mode: RenderMode = rest.includes('--json') ? 'json' : 'human';

  const loaded = loadPhases(phasesPath);
  const phases = loaded.phases;
  process.stderr.write(loaded.freshnessLine + '\n');

  const raw = await readStdin();
  if (!raw.trim()) fail('stdin is empty; expected JSON array of Issue objects');

  let issues: Issue[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      fail('stdin must be a JSON array of Issue objects');
    }
    issues = parsed as Issue[];
  } catch (err) {
    fail(`stdin JSON parse failed: ${(err as Error).message}`);
  }

  const report = buildDiagnostic(phases, issues);
  process.stdout.write(renderReport(report, mode));
}

main().catch((err) => {
  fail(`unexpected error: ${(err as Error).stack ?? err}`);
});
