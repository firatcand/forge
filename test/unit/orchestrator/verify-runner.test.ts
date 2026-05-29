import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runVerify,
  type RunCommand,
} from '../../../src/orchestrator/verify-runner.ts';

const CWD = process.cwd();

// ── Injected-fake path: deterministic, no real spawn ────────────────────────

test('FORGE-168 — all commands exit 0 → ran + passed, every result captured', async () => {
  const calls: string[] = [];
  const run: RunCommand = async (command) => {
    calls.push(command);
    return { exitCode: 0 };
  };
  const result = await runVerify({ commands: ['a', 'b'] }, { cwd: CWD, run });
  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(
    result.results.map((r) => r.exitCode),
    [0, 0],
  );
});

test('FORGE-168 — one non-zero exit → passed:false AND every command still ran (run-all, not fail-fast)', async () => {
  const calls: string[] = [];
  const run: RunCommand = async (command) => {
    calls.push(command);
    return { exitCode: command === 'fails' ? 3 : 0 };
  };
  const result = await runVerify(
    { commands: ['ok', 'fails', 'after'] },
    { cwd: CWD, run },
  );
  assert.equal(result.passed, false);
  // The command AFTER the failure still ran — proves run-all semantics.
  assert.deepEqual(calls, ['ok', 'fails', 'after']);
  assert.equal(result.results.length, 3);
  const failing = result.results.find((r) => r.command === 'fails');
  assert.equal(failing?.exitCode, 3);
});

test('FORGE-168 — an injected run that REJECTS is recorded as exitCode:1, run continues (Codex 2nd-pass)', async () => {
  const calls: string[] = [];
  const run: RunCommand = async (command) => {
    calls.push(command);
    if (command === 'boom') throw new Error('runner blew up');
    return { exitCode: 0 };
  };
  // Must resolve to a VerifyResult, never reject — that's the runner's contract.
  const result = await runVerify(
    { commands: ['ok', 'boom', 'after'] },
    { cwd: CWD, run },
  );
  assert.equal(result.ran, true);
  assert.equal(result.passed, false);
  assert.deepEqual(calls, ['ok', 'boom', 'after']); // failure didn't abort the loop
  assert.equal(result.results.find((r) => r.command === 'boom')?.exitCode, 1);
  assert.equal(result.results.find((r) => r.command === 'after')?.exitCode, 0);
});

test('FORGE-168 — unset verify → skipped, runner not invoked, warning emitted', async () => {
  let invoked = false;
  const spy: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  // Capture the skip warning written to stderr.
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    warned += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  let result;
  try {
    result = await runVerify(undefined, { cwd: CWD, run: spy });
  } finally {
    process.stderr.write = origWrite;
  }

  assert.equal(result.ran, false);
  assert.equal(result.passed, false);
  assert.ok(result.skippedReason && result.skippedReason.length > 0);
  assert.equal(invoked, false, 'run callback must not be called when verify is unset');
  assert.match(warned, /no settings\.verify configured/);
});

// ── Real-shell smoke (Codex 2nd-pass, REQUIRED): exercise the DEFAULT runner ─
// so execa({ shell: true }) behavior is verified, not only the injected fake.
// `exit N` is a POSIX shell builtin → no external tool dependency. Short
// timeout so a hang fails the test instead of stalling CI.

test('FORGE-168 [real shell] — all exit 0 → passed:true via default execa runner', async () => {
  const result = await runVerify(
    { commands: ['exit 0', 'exit 0'] },
    { cwd: CWD, timeoutMs: 30_000 },
  );
  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.results.map((r) => r.exitCode),
    [0, 0],
  );
});

test('FORGE-168 [real shell] — non-zero exit is captured (not thrown) and fails the run', async () => {
  const result = await runVerify(
    { commands: ['exit 0', 'exit 3'] },
    { cwd: CWD, timeoutMs: 30_000 },
  );
  assert.equal(result.passed, false);
  assert.equal(result.results[0]?.exitCode, 0);
  // Full shell string ran AND the non-zero code surfaced through reject:false.
  assert.equal(result.results[1]?.exitCode, 3);
});

test('FORGE-168 [real shell] — missing binary → non-zero, no crash', async () => {
  const result = await runVerify(
    { commands: ['forge-no-such-binary-xyz'] },
    { cwd: CWD, timeoutMs: 30_000 },
  );
  assert.equal(result.passed, false);
  assert.notEqual(result.results[0]?.exitCode, 0);
});
