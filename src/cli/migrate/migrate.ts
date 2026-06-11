// `forge migrate [--dry-run] [--yes] [--help]` — v0.2.x → v0.4 project
// migration (FORGE-109). Detect drift signatures, preview the exact planned
// edits (chalk diff), confirm (interactive y/N in a TTY; --yes for CI;
// --dry-run previews only), back up every to-be-modified file pristine to
// .forge/backup-<timestamp>/, apply via writeAtomic, report.
//
// Confirmation contract (user-decided 2026-06-11):
//   TTY            → @inquirer/prompts confirm (default No); Ctrl-C = reject.
//   non-TTY        → refuses without --yes (exit 1, no writes, no backup).
//   --dry-run      → preview + exit 0, never writes (wins over --yes).
// Reject leaves ZERO new filesystem state (the backup dir is only created on
// an accepted apply) — "aborts cleanly on user reject; no partial state".

import chalkImport from 'chalk';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeAtomic } from '../../core/fs-atomic.ts';
import { validateUnderRoot } from '../../core/workspace.ts';
import { locatePackageRoot } from '../upgrade/skill-farm.ts';
import {
  detectDrift,
  type DriftFinding,
  type DriftReport,
} from './drift-detect.ts';

// tsdown/rolldown's CJS interop double-wraps chalk v5 (pure ESM) — same
// unwrap as src/core/logger.ts.
const chalk = ((chalkImport as unknown as { default?: typeof chalkImport }).default ?? chalkImport);

export interface MigrateOptions {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Test seam: replaces the lazy @inquirer/prompts confirm. Return value =
  // user's answer; a throw = cancellation (Ctrl-C), treated as reject.
  readonly confirmOverride?: (message: string) => Promise<boolean>;
  // Test seam: force the TTY decision (defaults to process.stdin.isTTY).
  readonly isTTYOverride?: boolean;
}

export interface MigrateResult {
  readonly exitCode: number;
  readonly backupDir?: string;
}

const USAGE = [
  'Usage: forge migrate [--dry-run] [--yes]',
  '',
  'Migrate a v0.2.x forge project to v0.4 conventions.',
  '',
  '  --dry-run   Preview the planned changes; write nothing.',
  '  --yes       Apply without the interactive confirmation (CI).',
  '  --help      Show this help.',
  '',
  'Detects: missing/stale .forge/settings.yaml blocks, @inherit lines in',
  'spec/DESIGN.md, /push-to-linear references, renamed/dropped orchestrate',
  'verbs in skill files, a missing templates/adr.template.md, and legacy v1',
  'orchestrator state. Modified files are backed up pristine to',
  '.forge/backup-<timestamp>/ before any write.',
].join('\n');

// Windows-safe, collision-suffixed backup dir under .forge/ (Codex
// pre-opinion: raw ISO timestamps contain ':').
export function chooseBackupDir(cwd: string, nowIso: string): string {
  const stamp = nowIso.replace(/[:.]/g, '-');
  const base = join(cwd, '.forge', `backup-${stamp}`);
  if (!existsSync(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`forge migrate: could not choose a free backup dir near ${base}`);
}

// Minimal line diff for the preview: lines removed from `before` in red,
// lines added in `after` in green (set-difference per side, order preserved,
// capped). Not a real LCS — migrate's rewrites are line-local, so this reads
// correctly for every signature we produce.
const DIFF_PREVIEW_CAP = 20;

function previewDiff(before: string, after: string, out: NodeJS.WritableStream): void {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const afterSet = new Set(afterLines);
  const beforeSet = new Set(beforeLines);
  let shown = 0;
  for (const line of beforeLines) {
    if (!afterSet.has(line)) {
      out.write(chalk.red(`  - ${line}\n`));
      if (++shown >= DIFF_PREVIEW_CAP) break;
    }
  }
  for (const line of afterLines) {
    if (shown >= DIFF_PREVIEW_CAP * 2) break;
    if (!beforeSet.has(line)) {
      out.write(chalk.green(`  + ${line}\n`));
      shown++;
    }
  }
  if (shown >= DIFF_PREVIEW_CAP) out.write(chalk.dim('  … (diff truncated)\n'));
}

function printReport(report: DriftReport, out: NodeJS.WritableStream): {
  actionable: DriftFinding[];
  warnings: DriftFinding[];
  followups: DriftFinding[];
} {
  const actionable = report.findings.filter((f) => f.class === 'actionable');
  const warnings = report.findings.filter((f) => f.class === 'warning');
  const followups = report.findings.filter((f) => f.class === 'followup');

  if (actionable.length > 0) {
    out.write(chalk.bold(`\nPlanned changes (${actionable.length}):\n`));
    for (const f of actionable) {
      out.write(`${chalk.cyan(f.relPath ?? '')} — ${f.detail}\n`);
      if (f.edit) previewDiff(f.edit.before, f.edit.after, out);
      if (f.copyToRel) out.write(chalk.green(`  + ${f.copyToRel} (copied from the forge package)\n`));
    }
  }
  if (warnings.length > 0) {
    out.write(chalk.bold(`\nWarnings — manual fixes needed (${warnings.length}):\n`));
    for (const f of warnings) out.write(chalk.yellow(`  ⚠ ${f.relPath ?? ''}: ${f.detail}\n`));
  }
  if (followups.length > 0) {
    out.write(chalk.bold(`\nFollow-ups owned by other commands (${followups.length}):\n`));
    for (const f of followups) out.write(`  → ${f.detail}\n`);
  }
  if (report.skipped.length > 0) {
    out.write(chalk.dim(`\nSkipped: ${report.skipped.map((s) => `${s.relPath} (${s.reason})`).join(', ')}\n`));
  }
  if (report.scanTruncated) {
    out.write(
      chalk.yellow(
        '\n⚠ scan budget exceeded (file count / total bytes / depth) — detection is INCOMPLETE. Prune the tree or migrate the remainder manually.\n',
      ),
    );
  }
  return { actionable, warnings, followups };
}

async function askConfirm(
  message: string,
  override?: (message: string) => Promise<boolean>,
): Promise<boolean> {
  if (override) {
    try {
      return await override(message);
    } catch {
      return false; // cancellation = reject
    }
  }
  try {
    const mod = await import('@inquirer/prompts');
    return await mod.confirm({ message, default: false });
  } catch {
    // Ctrl-C (ExitPromptError) or prompt failure — reject, never apply.
    return false;
  }
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  // Flags: reject unknowns loudly (Codex pre-opinion — top-level routers
  // historically swallowed unknown flags).
  let dryRun = false;
  let yes = false;
  for (const arg of opts.argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--yes') yes = true;
    else if (arg === '--help' || arg === '-h') {
      out.write(`${USAGE}\n`);
      return { exitCode: 0 };
    } else {
      err.write(`forge migrate: unknown argument '${arg}'\n\n${USAGE}\n`);
      return { exitCode: 1 };
    }
  }

  // Not a forge project at all (no .forge/ AND no spec/) → nothing to
  // migrate; don't scaffold artifacts into arbitrary directories.
  if (!existsSync(join(opts.cwd, '.forge')) && !existsSync(join(opts.cwd, 'spec'))) {
    out.write('forge migrate: no .forge/ or spec/ here — not a forge project; nothing to migrate. (Starting fresh? Run `forge init`.)\n');
    return { exitCode: 0 };
  }

  let report: DriftReport;
  try {
    report = detectDrift(opts.cwd);
  } catch (e) {
    err.write(`forge migrate: detection failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  const { actionable, warnings, followups } = printReport(report, out);

  if (actionable.length === 0) {
    if (warnings.length === 0 && followups.length === 0) {
      out.write(chalk.green('✓ no v0.2.x drift detected — project is at v0.4 conventions.\n'));
    } else {
      out.write(chalk.green('\n✓ nothing for forge migrate to write — only the items above remain.\n'));
    }
    return { exitCode: 0 };
  }

  if (dryRun) {
    out.write(chalk.dim('\n--dry-run: nothing written.\n'));
    return { exitCode: 0 };
  }

  if (!yes) {
    const isTTY = opts.isTTYOverride ?? process.stdin.isTTY === true;
    if (!isTTY) {
      err.write('forge migrate: refusing to apply without confirmation in a non-interactive session — re-run with --yes (or preview with --dry-run).\n');
      return { exitCode: 1 };
    }
    const accepted = await askConfirm(
      `Apply ${actionable.length} change(s)? (originals backed up to .forge/backup-<timestamp>/)`,
      opts.confirmOverride,
    );
    if (!accepted) {
      out.write('aborted — nothing written.\n');
      return { exitCode: 1 };
    }
  }

  // ── Pre-apply verification (Codex impl-review: TOCTOU + write-path safety) ─
  // Files may have changed between detection/preview and the user's accept.
  // Re-validate EVERY target before any backup or write: path stays under the
  // repo root (validateUnderRoot resolves symlinked ancestors), the target is
  // a regular file (never a symlink), and its bytes still equal the previewed
  // `before`. Any drift aborts the whole apply with zero new state.
  try {
    for (const f of actionable) {
      if (f.edit) {
        // lstat the UNRESOLVED path first: validateUnderRoot resolves
        // symlinks, so checking its return value would inspect the link's
        // target instead of catching the swap itself.
        const rawAbs = join(opts.cwd, f.edit.relPath);
        const st = lstatSync(rawAbs);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error(`${f.edit.relPath} is no longer a regular file`);
        }
        validateUnderRoot(rawAbs, opts.cwd); // symlinked-ancestor escape guard
        const current = readFileSync(rawAbs, 'utf8');
        if (current !== f.edit.before) {
          throw new Error(`${f.edit.relPath} changed since the preview`);
        }
      } else if (f.copyToRel) {
        const rawAbs = join(opts.cwd, f.copyToRel);
        // lstat-existence (not existsSync, which follows symlinks): any entry
        // at the target — file, dir, or dangling symlink — means we must not
        // create over it.
        let occupied = true;
        try {
          lstatSync(rawAbs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') occupied = false;
          else throw e;
        }
        if (occupied) {
          throw new Error(`${f.copyToRel} appeared since the preview`);
        }
        validateUnderRoot(rawAbs, opts.cwd);
      }
    }
  } catch (e) {
    err.write(
      `forge migrate: aborting before any write — ${e instanceof Error ? e.message : String(e)}. Re-run to re-detect.\n`,
    );
    return { exitCode: 1 };
  }

  // ── Backup destination discipline ──────────────────────────────────────────
  // .forge must be a real directory (a symlinked .forge would redirect the
  // backup tree outside the repo) and the chosen dir must sit under the root.
  let backupDir: string;
  try {
    const forgeSt = lstatSync(join(opts.cwd, '.forge'));
    if (forgeSt.isSymbolicLink() || !forgeSt.isDirectory()) {
      throw new Error('.forge is not a real directory — refusing to write backups through it');
    }
    backupDir = chooseBackupDir(opts.cwd, new Date().toISOString());
    validateUnderRoot(backupDir, opts.cwd);
  } catch (e) {
    err.write(`forge migrate: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  // ── Apply: per-file verify → backup → write, in one tight sequence ────────
  // The upfront pass above caught drift during the (arbitrarily long) confirm
  // prompt; this re-verify immediately before each write shrinks the residual
  // window to microseconds. The write itself is rename()-based (writeAtomic):
  // rename replaces the PATH ENTRY and never follows a symlink swapped in at
  // the destination, so a swap cannot redirect bytes into the link's target —
  // the worst remaining case is overwriting a concurrent same-instant edit
  // whose pre-image is preserved in the backup. Kernel-grade closure would
  // need O_NOFOLLOW fd-writes + per-file locks; out of scope for a
  // single-host CLI (same posture as the FORGE-87 flock follow-up).
  let applied = 0;
  const verifyBeforeWrite = (f: (typeof actionable)[number]): void => {
    if (f.edit) {
      const rawAbs = join(opts.cwd, f.edit.relPath);
      const st = lstatSync(rawAbs);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`${f.edit.relPath} is no longer a regular file`);
      }
      if (readFileSync(rawAbs, 'utf8') !== f.edit.before) {
        throw new Error(`${f.edit.relPath} changed since the preview`);
      }
    } else if (f.copyToRel) {
      // The copy target must STILL be absent right before the write — a
      // file created during the apply loop must not be clobbered (Codex
      // impl-review round 3). lstat: even a dangling symlink counts.
      try {
        lstatSync(join(opts.cwd, f.copyToRel));
        throw new Error(`${f.copyToRel} appeared since the preview`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  };
  for (const f of actionable) {
    try {
      verifyBeforeWrite(f);
    } catch (e) {
      err.write(
        `forge migrate: stopping — ${e instanceof Error ? e.message : String(e)}. ` +
          `${applied} file(s) already migrated (originals in ${backupDir}); re-run to migrate the rest.\n`,
      );
      return { exitCode: 1, backupDir };
    }
    if (f.edit) {
      const dst = join(backupDir, f.edit.relPath);
      mkdirSync(dirname(dst), { recursive: true });
      // Backup the VERIFIED bytes (no re-read — no second race).
      writeFileSync(dst, f.edit.before, 'utf8');
      writeAtomic(join(opts.cwd, f.edit.relPath), f.edit.after);
      applied++;
      out.write(chalk.green(`✓ ${f.edit.relPath}\n`));
    } else if (f.copyToRel) {
      const bundled = join(locatePackageRoot(), 'templates', 'adr.template.md');
      // Target verified absent in the upfront pass; rename-based write means
      // a racing creation surfaces as an overwrite of a file that did not
      // exist at preview time — acceptable for a template scaffold.
      writeAtomic(join(opts.cwd, f.copyToRel), readFileSync(bundled, 'utf8'));
      applied++;
      out.write(chalk.green(`✓ ${f.copyToRel} (scaffold copied)\n`));
    }
  }

  // Copy-only runs (e.g. just the ADR template) take no backups — don't
  // report a backup directory that was never created (Codex final review).
  const tookBackups = actionable.some((f) => f.edit !== undefined);
  out.write(
    chalk.bold(
      `\n✓ forge migrate: ${applied} file(s) migrated.${tookBackups ? ` Originals: ${backupDir}` : ''}\n`,
    ),
  );
  if (warnings.length + followups.length > 0) {
    out.write(`${warnings.length + followups.length} item(s) above still need manual follow-up.\n`);
  }
  return { exitCode: 0, ...(tookBackups ? { backupDir } : {}) };
}
