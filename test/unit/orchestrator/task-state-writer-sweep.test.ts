import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// FORGE-231 sweep (R6 CRIT-2 / R8): EVERY task-state write must flow through
// the casGuardedWrite protocol. The only modules allowed to place bytes at a
// state.json path are:
//   - src/orchestrator/state-machine.ts  (writeTaskState — reimplemented ON
//     casGuardedWrite; the single choke point for all verbs)
//   - src/orchestrator/leases.ts         (steal's §C4 commit under the
//     RESERVED state marker via commitUnderCasMarker)
// Everything else may READ state files but never write them. This test walks
// the production source tree and fails if any other module both resolves a
// state-file path and performs a write-capable fs operation, or reintroduces
// a direct writer (the pre-FORGE-231 writeStateUnclaimed pattern).

const SRC_ROOT = join(process.cwd(), 'src');
const ALLOWED_WRITERS = new Set([
  join('orchestrator', 'state-machine.ts'),
  join('orchestrator', 'leases.ts'),
]);

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      yield* walk(join(dir, ent.name));
    } else if (ent.isFile() && ent.name.endsWith('.ts')) {
      yield join(dir, ent.name);
    }
  }
}

const WRITE_OPS = /\b(renameSync|writeFileSync|linkSync|writeSync|writeAtomic|writeAtomicDurable|casGuardedWrite|commitUnderCasMarker)\b/;

test('task-state writer sweep: only the CAS protocol modules write state.json', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1);
    if (ALLOWED_WRITERS.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    if (!src.includes('stateFilePath')) continue;
    // paths.ts only DEFINES the helper; readers resolve the path without any
    // write-capable op in the same module.
    if (WRITE_OPS.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `modules that resolve a state-file path AND contain write-capable fs ops (route them through writeTaskState): ${offenders.join(', ')}`,
  );
});

test('task-state writer sweep: the pre-FORGE-231 direct writer stays deleted', () => {
  const leases = readFileSync(join(SRC_ROOT, 'orchestrator', 'leases.ts'), 'utf8');
  assert.ok(
    !leases.includes('writeStateUnclaimed'),
    'writeStateUnclaimed (direct rename-based state writer) must not return',
  );
  assert.ok(
    !leases.includes('overwriteAtomicLink'),
    'the non-atomic unlink→link lease replacement helper must not return',
  );
  const stateMachine = readFileSync(join(SRC_ROOT, 'orchestrator', 'state-machine.ts'), 'utf8');
  assert.ok(
    stateMachine.includes('casGuardedWrite'),
    'writeTaskState must be implemented on casGuardedWrite',
  );
});
