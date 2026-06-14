// FORGE-197: the FIRST (and only) Forge writer into the user's GLOBAL
// `~/.claude/settings.json`. Writes a single display-only `statusLine` key so
// Claude Code shows the parked-decision badge (`forge statusline`).
//
// This touches a file OUTSIDE the working tree, so every safety lever is here:
//   - OPT-IN ONLY: the caller (upgrade.ts) gates this on
//     `settings.hosts.claude.status_line === true`. This module is never invoked
//     without that consent.
//   - NON-CLOBBER: an existing `statusLine` (the user's own custom status line)
//     is never overwritten — we skip with a notice.
//   - PLAIN-OBJECT GUARD (R1): a settings.json that parses to a non-object
//     (null / array / string / number) is NOT spread — we skip with a notice.
//   - SYMLINK GUARD (R2): a symlinked `.claude` / `.claude/settings.json`
//     component would redirect the write outside home — we skip with a notice.
//     This is a BEST-EFFORT default-deny against a PRE-EXISTING symlink (the
//     real case: a user who symlinked `~/.claude` into a dotfiles repo), checked
//     once before the read and AGAIN immediately before the write to shrink the
//     window. It is NOT a complete no-follow guarantee against an attacker
//     actively racing the check — that residual TOCTOU is the same one
//     writeAtomic documents (fs-atomic.ts), and it carries no privilege
//     escalation: forge writes the user's OWN home AS the user, so anyone able
//     to swap `~/.claude` mid-run could already edit settings.json directly.
//   - ATOMIC: the write goes through writeAtomic (tmp + rename; its own leaf
//     symlink preflight is belt-and-suspenders to the parent guard above).
//   - INJECTABLE homeDir (R3): tests pass a fake home so they never touch the
//     real ~/.claude.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { firstSymlinkedParent, isSymlinkAt } from '../../core/symlink-guard.ts';

/** The display-only status line Forge installs. NOT a behavioral hook — a status
 * line cannot intercept, block, or alter execution (see spec/SPEC.md:1096). */
const STATUS_LINE_VALUE = { type: 'command', command: 'forge statusline' } as const;

export interface WriteStatusLineOptions {
  /** Injectable home dir. Production leaves it undefined → os.homedir(). */
  readonly homeDir?: string;
  /** Preview only — compute the outcome without writing. */
  readonly dryRun?: boolean;
}

export type WriteStatusLineOutcome = 'written' | 'skipped' | 'dry-run';

export interface WriteStatusLineResult {
  readonly outcome: WriteStatusLineOutcome;
  /** Human-readable note for stderr (skip reason / what was written). */
  readonly notice: string;
}

/**
 * Best-effort symlink default-deny for `<home>/.claude/settings.json`. Returns a
 * `skipped` result (with a notice) when any parent component (`.claude`) or the
 * leaf itself is a symlink, else null. Called twice — before the read and again
 * immediately before the write — to shrink the TOCTOU window.
 */
function symlinkSkip(home: string, settingsPath: string): WriteStatusLineResult | null {
  const symlinkedParent = firstSymlinkedParent(home, '.claude/settings.json');
  if (symlinkedParent !== null) {
    return {
      outcome: 'skipped',
      notice: `forge: skipped writing statusLine — ${join(home, symlinkedParent)} is a symlink (refusing to write through a pre-existing symlinked path).`,
    };
  }
  if (isSymlinkAt(settingsPath)) {
    return {
      outcome: 'skipped',
      notice: `forge: skipped writing statusLine — ${settingsPath} is a symlink (refusing to write through a pre-existing symlinked path).`,
    };
  }
  return null;
}

/**
 * Write the display-only `statusLine` entry into `<homeDir>/.claude/settings.json`,
 * deep-merging over any existing keys (preserved). Returns a discriminated
 * result; never throws on the expected skip paths (corrupt JSON, non-object,
 * existing statusLine, symlinked component).
 */
export function writeStatusLineConfig(opts: WriteStatusLineOptions = {}): WriteStatusLineResult {
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, '.claude', 'settings.json');

  // R2: guard the PARENT components plus the leaf before any read or write.
  // writeAtomic only refuses a symlinked LEAF; a symlinked `.claude` dir would
  // redirect both the read and the write outside `home`. Walk `.claude` (the
  // only intermediate component of `.claude/settings.json`) plus the leaf. We
  // run this BOTH here (before the read) and again immediately before the write
  // to shrink the TOCTOU window to near-zero; see the header note for the
  // residual (a pre-existing-symlink default-deny, not an anti-race guarantee).
  const preReadSkip = symlinkSkip(home, settingsPath);
  if (preReadSkip !== null) return preReadSkip;

  // Read existing settings (absent → start from {}).
  let raw: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      raw = readFileSync(settingsPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: 'skipped',
        notice: `forge: skipped writing statusLine — could not read ${settingsPath} (${msg}).`,
      };
    }
  }

  let parsed: unknown = {};
  if (raw !== null && raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON — do NOT clobber the user's (possibly recoverable) file.
      return {
        outcome: 'skipped',
        notice: `forge: skipped writing statusLine — ${settingsPath} is not valid JSON (left untouched).`,
      };
    }
  }

  // R1: require a PLAIN OBJECT. A valid-but-non-object value (null / [] /
  // "str" / number) is not corrupt JSON, but spreading it would corrupt the
  // file — skip rather than write.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      outcome: 'skipped',
      notice: `forge: skipped writing statusLine — ${settingsPath} is not a JSON object (left untouched).`,
    };
  }

  const obj = parsed as Record<string, unknown>;

  // NON-CLOBBER: never overwrite a user's existing statusLine.
  if (Object.prototype.hasOwnProperty.call(obj, 'statusLine')) {
    return {
      outcome: 'skipped',
      notice: `forge: ${settingsPath} already defines statusLine — left untouched (forge does not overwrite a custom status line).`,
    };
  }

  if (opts.dryRun) {
    return {
      outcome: 'dry-run',
      notice: `forge: would write statusLine: { command: 'forge statusline' } into ${settingsPath}.`,
    };
  }

  // Re-check the symlink guard immediately before the write: this is the last
  // instant before writeAtomic touches the path, so it shrinks the window where
  // a `.claude` component could be swapped to a symlink between our first check
  // and the write. writeAtomic's own leaf preflight is the final backstop.
  const preWriteSkip = symlinkSkip(home, settingsPath);
  if (preWriteSkip !== null) return preWriteSkip;

  // Deep-merge: preserve all other keys, add only statusLine.
  const merged = { ...obj, statusLine: { ...STATUS_LINE_VALUE } };
  try {
    writeAtomic(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (err) {
    // writeAtomic's leaf-symlink preflight (or a real fs error) — never throw
    // out of the opt-in writer; report a skip.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'skipped',
      notice: `forge: skipped writing statusLine — ${msg}`,
    };
  }

  return {
    outcome: 'written',
    notice: `forge: wrote display-only statusLine (parked-decision badge) into ${settingsPath}.`,
  };
}
