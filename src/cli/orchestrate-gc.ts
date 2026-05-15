import {
  linkSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  isNodeFsError,
  legacyAnswersDir,
  legacyArchiveSession,
  legacyQuestionsDir,
  QuestionChannelError,
} from '../orchestrator/questions/index.ts';

// `forge orchestrate gc` is the deterministic reconciler defined by
// spec/ORCHESTRATOR.md §"gc reconciliation rules". The full divergence table
// (state vs tracker, lease expiry, worktree pruning, etc.) is FORGE-20 work.
//
// FORGE-73 lands only the legacy-migration row: any v1-style flat
// .forge/{questions,answers}/<id>.json tree from before the v2 task-keyed
// rewrite is moved under .forge/orchestrator/legacy/<utc-timestamp>/ on first
// invocation. Files are MOVED via link+unlink (the same atomic technique used
// by writeQuestionAtomic) — never deleted in place — so a single failure
// during migration leaves the originals intact for retry. .tmp residue from
// crashed v1 writers is left where it lies.
//
// The CLI verb shape (`forge orchestrate gc [--dry-run]`) is final. FORGE-20
// adds rows to the planner; the surface stays the same.

export interface OrchestrateGcOptions {
  readonly forgeDir: string;
  readonly dryRun?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injectable clock — tests use a fixed timestamp so the archive directory
  // path is deterministic.
  readonly now?: () => Date;
}

export interface OrchestrateGcResult {
  readonly exitCode: number;
  // Sibling files moved (or planned to move under --dry-run). One entry per
  // source path, ordered as discovered.
  readonly migrated: readonly { from: string; to: string }[];
}

interface PlannedMove {
  readonly from: string;
  readonly to: string;
}

function listLegacyFiles(dir: string): readonly string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return [];
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to read legacy directory ${dir}`,
      { path: dir, cause: err },
    );
  }
  // Only canonical .json regular files migrate. Subdirectories (none expected
  // in v1 layout, including any pathological `something.json` directory that
  // would otherwise trip linkSync mid-pass and abort the whole gc) are
  // skipped silently. .tmp residue from crashed v1 writers is left in place —
  // not data. Codex flagged the previous name-only filter in review.
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.includes('.tmp'))
    .map((e) => e.name);
}

function planMigration(
  forgeDir: string,
  archiveDir: string,
): readonly PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const file of listLegacyFiles(legacyQuestionsDir(forgeDir))) {
    moves.push({
      from: join(legacyQuestionsDir(forgeDir), file),
      to: join(archiveDir, 'questions', file),
    });
  }
  for (const file of listLegacyFiles(legacyAnswersDir(forgeDir))) {
    moves.push({
      from: join(legacyAnswersDir(forgeDir), file),
      to: join(archiveDir, 'answers', file),
    });
  }
  return moves;
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to create archive directory ${dir}`,
      { path: dir, cause: err },
    );
  }
}

function moveFile(from: string, to: string): void {
  // link+unlink: same never-overwrite atomic technique as writer.ts. EEXIST on
  // the target indicates either a name collision (shouldn't happen — archive
  // session is timestamp-scoped) or a re-run that already migrated this file.
  // Either way: do not silently overwrite an existing archive entry. Surface
  // it so the operator can investigate.
  ensureDir(join(to, '..'));
  try {
    linkSync(from, to);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'EEXIST') {
      throw new QuestionChannelError(
        'DUPLICATE_ID',
        `Archive target already exists (refusing to overwrite): ${to}`,
        { path: to, cause: err },
      );
    }
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to link ${from} → ${to}`,
      { path: to, cause: err },
    );
  }
  try {
    unlinkSync(from);
  } catch (err) {
    // Source unlink failed AFTER successful link: target is the canonical
    // archive entry, source is now an orphan duplicate. Surface as IO_ERROR;
    // the operator can manually unlink the source. Do NOT roll back the link
    // — the archive entry is the safer state to preserve.
    throw new QuestionChannelError(
      'IO_ERROR',
      `Linked to archive but failed to unlink source ${from}`,
      { path: from, cause: err },
    );
  }
}

export function runOrchestrateGc(
  opts: OrchestrateGcOptions,
): OrchestrateGcResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? (() => new Date());

  const archiveDir = legacyArchiveSession(opts.forgeDir, now().toISOString());
  let moves: readonly PlannedMove[];
  try {
    moves = planMigration(opts.forgeDir, archiveDir);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate gc: ${e.code}: ${e.message}\n`);
      return { exitCode: 1, migrated: [] };
    }
    err.write(
      `forge orchestrate gc: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1, migrated: [] };
  }

  if (moves.length === 0) {
    out.write('No legacy files to migrate.\n');
    return { exitCode: 0, migrated: [] };
  }

  if (dryRun) {
    out.write(`gc plan (no changes will be made):\n\n`);
    for (const m of moves) {
      out.write(`  ${m.from}\n    → ${m.to}\n`);
    }
    out.write(`\n${moves.length} file(s) would be migrated. Re-run without --dry-run to apply.\n`);
    return { exitCode: 0, migrated: moves };
  }

  const completed: PlannedMove[] = [];
  for (const m of moves) {
    try {
      moveFile(m.from, m.to);
      completed.push(m);
    } catch (e) {
      // Abort on first failure. Already-completed moves are left in place —
      // re-running gc is idempotent for the remainder (the source files for
      // completed moves no longer exist; planMigration skips them next pass).
      const msg =
        e instanceof QuestionChannelError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      err.write(`forge orchestrate gc: aborted after ${completed.length}/${moves.length} moves: ${msg}\n`);
      return { exitCode: 1, migrated: completed };
    }
  }

  out.write(`Migrated ${completed.length} legacy file(s) to ${archiveDir}.\n`);
  return { exitCode: 0, migrated: completed };
}
