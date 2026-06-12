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
// settings.yaml, plus the per-host skill + agent farm dirs that
// `forge init` / `forge upgrade` materialize from the bundled npm package
// (FORGE-156). Keep this list narrow: every line here is a contract with
// every adopter repo, and changes force a `forge upgrade` cycle.
//
// Why blanket-ignore `.claude/skills/` etc. rather than enumerate forge's
// own skill names? The farm targets are per-machine pointers (symlinks
// into the local node_modules, or copies of bundled content). Committing
// them would break any teammate whose npm layout differs, and rotate on
// every `forge upgrade`. Adopters who want to track their own non-forge
// skills in these dirs can add a `!` override line BELOW the marker block.
const BLOCK_BODY = [
  '/.forge/*',
  '!/.forge/settings.yaml',
  // FORGE-158: transient eject backup snapshots (sibling of .forge/, so not
  // covered by /.forge/*). Local-only rollback artifact — never committed.
  '/.forge.eject-backup-*/',
  '/.claude/skills/',
  '/.claude/agents/',
  '/.codex/skills/',
  '/.codex/agents/',
  '/.gemini/skills/',
  '/.gemini/agents/',
  // FORGE-160: cursor host. `.agents/skills/` is the canonical cross-tool skill
  // farm root; `.cursor/agents/` holds subagent defs; the `.mdc` rule inlines
  // the methodology and is regenerated per machine (same rationale as
  // .forge/CONTEXT.md), so all three are forge-managed + gitignored.
  '/.agents/skills/',
  '/.cursor/agents/',
  '/.cursor/rules/forge-context.mdc',
].join('\n');

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

// FORGE-158: inverse of applyGitignoreBlock's append path, for `forge eject`.
//
// applyGitignoreBlock(prior) === prior + sep + FULL_BLOCK, where
//   sep = prior.endsWith('\n') ? '\n' : '\n\n'   (only when prior is non-empty)
// Removing just the marker-to-marker span leaves that inserted `sep` behind as
// orphaned blank lines — and worse, two different priors collapse to the same
// post-install bytes ("X\n" and "X" both yield "X\n\nBLOCK"), so the inverse is
// genuinely ambiguous without knowing the prior's trailing-newline state.
// `priorEndedWithNewline` (recorded in the manifest at write time) resolves it.
//
// Returns the pre-install content byte-exactly when `contents` still ends with
// forge's exact appended suffix. If the user edited around the block since
// install (suffix no longer matches), falls back to a block-strip + collapse of
// any run of blank lines the removal would leave at EOF — best-effort, since a
// byte-exact reversal is no longer defined.
export function removeGitignoreBlock(
  contents: string,
  opts: { priorEndedWithNewline: boolean },
): string {
  const sep = opts.priorEndedWithNewline ? '\n' : '\n\n';
  const appended = `${sep}${FULL_BLOCK}`;
  if (contents.endsWith(appended)) {
    return contents.slice(0, contents.length - appended.length);
  }
  if (contents === FULL_BLOCK) return '';
  return contents.replace(blockRegex, '').replace(/\n{2,}$/, '\n');
}
