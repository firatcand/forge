import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FsWriteError } from './errors.ts';

export function writeAtomic(absPath: string, contents: string): void {
  // FORGE-208: default-deny when the target is a symbolic link. The rename
  // below replaces the LINK itself — not the file it points to — which would
  // silently destroy e.g. a CLAUDE.md → AGENTS.md parity link and materialize
  // a divergent regular file in its place. lstat (not stat) so we see the
  // link's own type; an absent target is fine (fresh create).
  //
  // Preflight error handling: only a genuinely ABSENT target (ENOENT) is a
  // fresh create and may proceed. Any other lstat failure (EACCES, ELOOP,
  // ENOTDIR on a parent, …) is a real preflight failure and MUST propagate so
  // the caller sees it rather than blindly attempting the write.
  //
  // TOCTOU caveat: there is an unavoidable window between this lstat and the
  // renameSync below — a symlink swapped in during that window is still
  // replaced. Acceptable for a local CLI (matches migrate.ts's
  // verifyBeforeWrite posture); do NOT read this preflight as a complete
  // no-follow guarantee.
  let st;
  try {
    st = lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT — absent, fine: we'll create it.
  }
  if (st?.isSymbolicLink()) {
    throw new FsWriteError(
      'SYMLINK_TARGET_REFUSED',
      `refusing to write ${absPath}: target is a symbolic link — renaming over it would destroy the link and materialize a divergent regular file`,
      { path: absPath },
    );
  }

  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.forge-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, contents, 'utf8');
  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may already be gone; ignore
    }
    throw err;
  }
}
