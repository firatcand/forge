// FORGE-208 / FORGE-160: shared symlink guards for forge's destructive
// filesystem operations.
//
// Forge writes/strips/deletes forge-managed files (agent root files, the cursor
// `.cursor/rules/forge-context.mdc`, .gitignore, .forge/settings.yaml). Every
// one of those paths can be a symlink — or live UNDER a symlinked parent
// directory — that an adopter created deliberately (e.g. CLAUDE.md → AGENTS.md
// for host parity, or `.cursor` symlinked into a dotfiles repo). A naive
// write/unlink follows the link and mutates files OUTSIDE the working tree.
//
// Two guards, one implementation, imported by scaffold.ts, upgrade.ts, and
// eject.ts so there is a SINGLE definition (previously copy-pasted into each).

import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * True when the path itself is a symbolic link (lstat — the link's own type,
 * never the target's). False when ABSENT (ENOENT). Catches a dangling symlink
 * too (lstat succeeds on those).
 *
 * FORGE-209: fail-closed error posture, unified with writeAtomic's preflight.
 * ONLY a genuinely absent target (ENOENT) is "not a symlink, fine to proceed".
 * ANY other lstat failure (EACCES, ELOOP, ENOTDIR on a parent component, …) is
 * a real preflight failure and MUST propagate — a path forge cannot lstat must
 * never be silently treated as "safe to write/delete through". Callers that
 * cannot tolerate a throw on their expected-skip paths (host-config.ts's
 * never-throw statusLine contract) wrap this and degrade to a skip; everywhere
 * else propagation is the intended safe-by-default behavior.
 */
export function isSymlinkAt(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * True when the path is a REGULAR FILE with more than one hard link
 * (`nlink > 1`). False when absent (ENOENT), or when the path is a symlink /
 * directory / single-link regular file. Mirrors {@link isSymlinkAt}'s
 * fail-closed posture: ENOENT → false; any other lstat failure → throw.
 *
 * FORGE-209: the hardlink analogue of the symlink guard. writeAtomic's rename
 * over a multiply-linked target detaches this path's link (the other link(s)
 * keep the old inode), so the precheck callers (upgrade, eject) use this to skip
 * a hardlinked managed file BEFORE writing — matching their existing isSymlinkAt
 * precheck shape. lstat (not stat) so a symlink is never mis-counted as a
 * hardlinked regular file.
 */
export function isHardlinkAt(absPath: string): boolean {
  let st;
  try {
    st = lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  return st.isFile() && st.nlink > 1;
}

/**
 * For a NESTED forge artifact like cursor's `.cursor/rules/forge-context.mdc`,
 * the leaf-path symlink check is not enough — a symlinked PARENT directory
 * (`.cursor` or `.cursor/rules`) is silently FOLLOWED by mkdirSync / writeAtomic
 * / unlinkSync, letting a forge-managed write OR DELETE escape the working tree.
 *
 * Walks each intermediate directory component of `relPath` (NOT the leaf — the
 * leaf has its own {@link isSymlinkAt} guard) and returns the FIRST existing
 * component that is a symlink, or null when every parent is a regular dir /
 * absent. lstat semantics: a dangling symlinked parent is caught too.
 */
export function firstSymlinkedParent(cwd: string, relPath: string): string | null {
  const parts = relPath.split('/');
  // Drop the leaf — only the intermediate directory components are parents.
  parts.pop();
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    if (isSymlinkAt(resolve(cwd, acc))) return acc;
  }
  return null;
}

/**
 * For a DIRECTORY that forge itself materializes / prunes — like the per-host
 * skill farm root `.agents/skills` or `.cursor/agents` — the leaf is NOT a
 * forge artifact with its own {@link isSymlinkAt} guard; it is a directory
 * forge will mkdir/write/rename/rmSync INTO. So unlike {@link firstSymlinkedParent}
 * (which deliberately drops the leaf), this walks EVERY component of `relPath`
 * INCLUDING the final one, and returns the FIRST that is a symlink, or null
 * when every component is a regular dir / absent.
 *
 * Example: for `.agents/skills` this checks `.agents` AND `.agents/skills`; a
 * symlinked `.agents` (dotfiles repo) OR a symlinked `.agents/skills` would let
 * a farm write/rename/delete escape the working tree, so both must be caught.
 * lstat semantics: a dangling symlinked component is caught too.
 */
export function firstSymlinkedComponent(cwd: string, relPath: string): string | null {
  let acc = '';
  for (const part of relPath.split('/')) {
    acc = acc === '' ? part : `${acc}/${part}`;
    if (isSymlinkAt(resolve(cwd, acc))) return acc;
  }
  return null;
}
