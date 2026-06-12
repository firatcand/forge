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
 * never the target's). False when absent or a regular file/dir. Catches a
 * dangling symlink too (lstat succeeds on those).
 */
export function isSymlinkAt(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
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
