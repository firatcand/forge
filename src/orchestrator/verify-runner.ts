// FORGE-168: real verification runner.
//
// Runs the adopter-declared `settings.verify.commands` (each a shell command
// string) in the repo root and reports an aggregate pass/fail. This is the
// capability `complete.ts` deferred (it self-attests today) — consumed by the
// gc `reverify_verdict` executor (FORGE-148) and, later, by `complete.ts`.
//
// Contract decisions (see plans/tasks/FORGE-168.plan.md):
//   - Commands run via `shell: true` with the FULL process env (extendEnv).
//     These are the adopter's own trusted commands; real test suites need
//     NODE_ENV / DB creds. This is deliberately NOT src/harnesses/subprocess.ts,
//     whose SAFE_ENV_KEYS allowlist exists to stop secrets reaching an external
//     model API — the wrong posture for a local trusted command.
//   - Run-all (not fail-fast), sequential: every command runs so the result
//     carries all exit codes for diagnostics; sequential avoids port/db
//     contention between commands.
//   - Failure (non-zero exit, timeout, or spawn error) maps to a non-zero
//     exitCode; the runner never throws on a command outcome.

import { execa } from 'execa';
import type { Verify } from '../schemas/settings.ts';

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifyCommandResult {
  readonly command: string;
  /** Process exit code. Timeout / spawn failure / non-zero exit all → non-zero. */
  readonly exitCode: number;
}

export interface VerifyResult {
  /** false ⇒ skipped because no settings.verify was configured. */
  readonly ran: boolean;
  /** Meaningful only when ran === true: every command exited 0. */
  readonly passed: boolean;
  readonly results: readonly VerifyCommandResult[];
  /** Set only when ran === false. */
  readonly skippedReason?: string;
}

/**
 * Runs a single shell command and returns its exit code. Injectable so tests
 * can exercise runVerify() without spawning real processes.
 */
export type RunCommand = (
  command: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number }>;

export const defaultRunCommand: RunCommand = async (command, opts) => {
  const result = await execa(command, {
    shell: true,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    // reject:false → a non-zero exit comes back as a result, not a throw.
    reject: false,
    // Full environment — opposite of the AI-subprocess allowlist (see header).
    extendEnv: true,
    all: false,
    // No writer on the child's stdin; force an immediate EOF so a command
    // that reads stdin can't hang the runner (mirrors FORGE-135).
    stdin: 'ignore',
  });
  // On timeout / termination execa leaves exitCode undefined → treat as fail.
  // A spawn-level error (e.g. cwd missing) can still throw despite reject:false;
  // runVerify's loop owns the "never throw" guarantee and maps it to a failure.
  return { exitCode: result.exitCode ?? 1 };
};

export async function runVerify(
  verify: Verify | undefined,
  opts: { cwd: string; timeoutMs?: number; run?: RunCommand },
): Promise<VerifyResult> {
  if (!verify) {
    const skippedReason = 'no settings.verify configured';
    process.stderr.write(`verify: ${skippedReason} — skipping verification\n`);
    return { ran: false, passed: false, results: [], skippedReason };
  }

  const run = opts.run ?? defaultRunCommand;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const results: VerifyCommandResult[] = [];
  for (const command of verify.commands) {
    // The runner's contract is to ALWAYS return a VerifyResult — a command that
    // can't even run (spawn error, or an injected runner that rejects) is a
    // failure, not a crash. This guard owns the invariant for every RunCommand,
    // including the default (Codex 2nd-pass: review-impl).
    let exitCode: number;
    try {
      ({ exitCode } = await run(command, { cwd: opts.cwd, timeoutMs }));
    } catch {
      exitCode = 1;
    }
    results.push({ command, exitCode });
  }
  return { ran: true, passed: results.every((r) => r.exitCode === 0), results };
}
