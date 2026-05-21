// FORGE-152: shared writer for the forge-managed block inside .gitignore.
//
// The block ignores everything under .forge/ EXCEPT settings.yaml. Reads:
//   /.forge/*           → ignore all top-level files/dirs in .forge/
//   !/.forge/settings.yaml → un-ignore settings.yaml (tracked, project config)
//
// Anything outside the markers — user-curated ignore rules, custom .forge/
// exception lines — is preserved exactly. Marker-delimited replacement is
// the only invariant that lets us run this on every init and every Phase B
// `forge upgrade` without trampling the rest of the file.
//
// Shared (this module, not duplicated in src/cli/init/scaffold.ts) so init
// and upgrade produce byte-identical output for the block — Phase B's
// strict edit-detection depends on that.

const MARKER_OPEN = '# >>> forge-managed (do not edit between markers) >>>';
const MARKER_CLOSE = '# <<< forge-managed <<<';

// The body is `.forge/*` (ignore-all) plus the single un-ignore for
// settings.yaml. Keep this list narrow: every line here is a contract with
// every adopter repo, and changes force a `forge upgrade` cycle.
const BLOCK_BODY = ['/.forge/*', '!/.forge/settings.yaml'].join('\n');

const FULL_BLOCK = `${MARKER_OPEN}\n${BLOCK_BODY}\n${MARKER_CLOSE}\n`;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const blockRegex = new RegExp(
  `${escapeRegex(MARKER_OPEN)}[\\s\\S]*?${escapeRegex(MARKER_CLOSE)}\\n?`,
  'm',
);

// Insert or replace the forge-managed block in `.gitignore` contents.
// - If a block already exists between markers → replace in place.
// - If no block exists → append at end. A blank-line separator is inserted
//   only when the user's file doesn't already end in a newline (avoids
//   double blank lines on idempotent re-runs).
// - User content outside the markers is preserved exactly.
export function applyGitignoreBlock(contents: string): string {
  if (blockRegex.test(contents)) {
    return contents.replace(blockRegex, FULL_BLOCK);
  }
  if (contents.length === 0) return FULL_BLOCK;
  const sep = contents.endsWith('\n') ? '\n' : '\n\n';
  return `${contents}${sep}${FULL_BLOCK}`;
}

export function hasGitignoreBlock(contents: string): boolean {
  return blockRegex.test(contents);
}
