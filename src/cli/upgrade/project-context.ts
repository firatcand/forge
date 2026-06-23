// FORGE: shared "ensure the committed project-context stub exists" helper. The
// agent-root marker block references spec/CONTEXT.md (claude @imports it;
// codex/gemini/cursor point at it), so the import target must always resolve —
// on a fresh init, on `forge upgrade` of a repo that predates the import, AND
// after `--migrate-claudemd` (which also stamps the new marker block). Both the
// upgrade verb and the migration path call this so neither can leave a dangling
// import.
//
// CREATE-IF-MISSING only: a populated spec/CONTEXT.md (from /ingest-spec) is the
// user's project content and is never overwritten. Symlink-guarded like the rest
// of upgrade.ts — a symlinked spec/ parent could redirect the write outside the
// working tree, and a (dangling) leaf symlink must never be written through.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { firstSymlinkedParent, isSymlinkAt } from '../../core/symlink-guard.ts';
import { locateProjectContextStubTemplate } from './template-loader.ts';

const SPEC_CONTEXT_RELPATH = 'spec/CONTEXT.md';

export interface EnsureStubOptions {
  readonly cwd: string;
  readonly projectName: string;
  readonly dryRun?: boolean;
}

export interface EnsureStubResult {
  /** The stub was created (or, in dry-run, would be created). */
  readonly changed: boolean;
  /** A skip notice when a symlink hazard prevented the write (exit 0; nothing written). */
  readonly notice?: string;
}

/** Render the stub template with the project name substituted. */
export function renderProjectContextStub(projectName: string): string {
  return locateProjectContextStubTemplate().replace(/\{\{PROJECT_NAME\}\}/g, projectName);
}

export function ensureProjectContextStub(opts: EnsureStubOptions): EnsureStubResult {
  const specPath = resolve(opts.cwd, SPEC_CONTEXT_RELPATH);

  // A symlinked parent (spec/ itself) would redirect the write outside the tree.
  const symlinkedParent = firstSymlinkedParent(opts.cwd, SPEC_CONTEXT_RELPATH);
  if (symlinkedParent !== null) {
    return {
      changed: false,
      notice: `skipped: ${SPEC_CONTEXT_RELPATH} (parent ${symlinkedParent} is a symlink) — forge does not write the project-context stub through symlinked parent directories. The agent-root import may dangle until you create spec/CONTEXT.md (run /ingest-spec).`,
    };
  }

  // A leaf symlink (valid OR dangling) is never written through. A valid symlink
  // to a real file still satisfies the import (the create is simply skipped); a
  // dangling one is surfaced so the user knows the import won't resolve.
  if (isSymlinkAt(specPath)) {
    return {
      changed: false,
      notice: `skipped: ${SPEC_CONTEXT_RELPATH} (symlink) — forge does not write the project-context stub through a symlinked file. Replace it with a regular file (or run /ingest-spec) if the agent-root import does not resolve.`,
    };
  }

  // Already present as a regular file (populated by /ingest-spec or a prior run).
  if (existsSync(specPath)) return { changed: false };

  if (!opts.dryRun) {
    mkdirSync(dirname(specPath), { recursive: true });
    writeAtomic(specPath, renderProjectContextStub(opts.projectName));
  }
  return { changed: true };
}
