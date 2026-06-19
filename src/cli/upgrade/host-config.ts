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
  // FORGE-209 (B1): isSymlinkAt / firstSymlinkedParent now FAIL CLOSED — a
  // non-ENOENT lstat failure (EACCES on `~/.claude`, ELOOP, …) THROWS rather
  // than swallowing to false. This module documents a NEVER-THROW skip contract
  // (statusLine is a noise-free, best-effort opt-in path that must never abort
  // the upgrade), so we catch any guard throw here and DEGRADE to a skip —
  // failing closed (do not write) while preserving the contract. We do not
  // swallow blindly: the reason is surfaced in the skip notice.
  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'skipped',
      notice: `forge: skipped writing statusLine — could not verify ${settingsPath} is symlink-free (${msg}); refusing to write.`,
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

// ── FORGE-202 follow-on: Tripwire PostToolUse hook ──────────────────────────
//
// The SECOND thing Forge can write into the user's GLOBAL ~/.claude/settings.json
// (also opt-in, also OUTSIDE the working tree), so the full safety contract from
// writeStatusLineConfig is mirrored here: opt-in gated by the caller, plain-
// object guard, double symlink guard (pre-read + pre-write via symlinkSkip),
// atomic write, injectable homeDir, never-throw skip contract.
//
// DIFFERENCE: `hooks.PostToolUse` is an ARRAY of entries, so the merge is more
// careful than a single key — see writeTripwireHookConfig.

/** The hook command(s) Forge installs. A LIST so a future rename stays dedupe/
 * eject-safe: any nested hook whose `command` is in this set is "ours". */
export const TRIPWIRE_HOOK_COMMANDS: readonly string[] = ['forge tripwire-hook'];

/** The PostToolUse entry Forge appends. Matcher scopes to external-content tools
 * (the real untrusted external→agent path); Read/Edit/Write of the owner's repo
 * are trusted per spec/THREAT-MODEL.md. */
const TRIPWIRE_HOOK_ENTRY = {
  matcher: 'WebFetch|WebSearch|mcp__.*',
  hooks: [{ type: 'command', command: 'forge tripwire-hook', timeout: 10 }],
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True if a PostToolUse array already contains one of our nested hook commands. */
function hasTripwireEntry(postToolUse: readonly unknown[]): boolean {
  for (const entry of postToolUse) {
    if (!isPlainObject(entry)) continue;
    const nested = entry.hooks;
    if (!Array.isArray(nested)) continue;
    for (const h of nested) {
      if (
        isPlainObject(h) &&
        typeof h.command === 'string' &&
        TRIPWIRE_HOOK_COMMANDS.includes(h.command)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read + parse ~/.claude/settings.json with the same guards as the statusLine
 * writer. Returns the parsed plain object, or a skip result (never throws on the
 * expected skip paths). `verb` tunes the notice wording (write vs remove).
 */
function loadSettingsObject(
  settingsPath: string,
  verb: string,
): { obj: Record<string, unknown> } | WriteStatusLineResult {
  let raw: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      raw = readFileSync(settingsPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'skipped', notice: `forge: skipped ${verb} — could not read ${settingsPath} (${msg}).` };
    }
  }
  let parsed: unknown = {};
  if (raw !== null && raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { outcome: 'skipped', notice: `forge: skipped ${verb} — ${settingsPath} is not valid JSON (left untouched).` };
    }
  }
  if (!isPlainObject(parsed)) {
    return { outcome: 'skipped', notice: `forge: skipped ${verb} — ${settingsPath} is not a JSON object (left untouched).` };
  }
  return { obj: parsed };
}

/**
 * Install the Tripwire PostToolUse hook into `<homeDir>/.claude/settings.json`.
 * Idempotent (dedup by nested command), non-clobbering (preserves all other
 * hooks/entries + a user-edited matcher/timeout), skip-not-clobber on a
 * non-object `hooks` or non-array `hooks.PostToolUse`. Never throws on the
 * expected skip paths.
 */
export function writeTripwireHookConfig(opts: WriteStatusLineOptions = {}): WriteStatusLineResult {
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, '.claude', 'settings.json');

  const preReadSkip = symlinkSkip(home, settingsPath);
  if (preReadSkip !== null) {
    return { outcome: 'skipped', notice: preReadSkip.notice.replace('statusLine', 'tripwire-hook') };
  }

  const loaded = loadSettingsObject(settingsPath, 'writing tripwire-hook');
  if ('outcome' in loaded) return loaded;
  const obj = loaded.obj;

  // SKIP-not-clobber: never repair/overwrite a structure we don't understand.
  const hooksVal = obj.hooks;
  if (hooksVal !== undefined && !isPlainObject(hooksVal)) {
    return { outcome: 'skipped', notice: `forge: skipped writing tripwire-hook — ${settingsPath} hooks is not a JSON object (left untouched).` };
  }
  const hooks = isPlainObject(hooksVal) ? hooksVal : {};
  const postVal = hooks.PostToolUse;
  if (postVal !== undefined && !Array.isArray(postVal)) {
    return { outcome: 'skipped', notice: `forge: skipped writing tripwire-hook — ${settingsPath} hooks.PostToolUse is not an array (left untouched).` };
  }
  const postToolUse: unknown[] = Array.isArray(postVal) ? postVal : [];

  // IDEMPOTENT: already installed (or user kept our command under a custom
  // matcher/timeout) → leave untouched.
  if (hasTripwireEntry(postToolUse)) {
    return { outcome: 'skipped', notice: `forge: ${settingsPath} already installs the tripwire-hook PostToolUse hook — left untouched.` };
  }

  if (opts.dryRun) {
    return { outcome: 'dry-run', notice: `forge: would install the tripwire-hook PostToolUse hook into ${settingsPath}.` };
  }

  const preWriteSkip = symlinkSkip(home, settingsPath);
  if (preWriteSkip !== null) {
    return { outcome: 'skipped', notice: preWriteSkip.notice.replace('statusLine', 'tripwire-hook') };
  }

  const merged = {
    ...obj,
    hooks: {
      ...hooks,
      PostToolUse: [...postToolUse, { ...TRIPWIRE_HOOK_ENTRY, hooks: [...TRIPWIRE_HOOK_ENTRY.hooks] }],
    },
  };
  try {
    writeAtomic(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: 'skipped', notice: `forge: skipped writing tripwire-hook — ${msg}` };
  }
  return { outcome: 'written', notice: `forge: installed the tripwire-hook PostToolUse hook into ${settingsPath}.` };
}

/**
 * Remove the Tripwire PostToolUse hook from `<homeDir>/.claude/settings.json` on
 * eject. Removes ONLY entries whose nested hook command is in
 * TRIPWIRE_HOOK_COMMANDS, preserving sibling entries + other nested hooks.
 * Drops now-empty PostToolUse / hooks structures cleanly. Same never-throw +
 * symlink-guard contract as the writer; a no-op (nothing ours present) is a skip.
 */
export function removeTripwireHookConfig(opts: WriteStatusLineOptions = {}): WriteStatusLineResult {
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    return { outcome: 'skipped', notice: `forge: ${settingsPath} does not exist — no tripwire-hook to remove.` };
  }

  const preReadSkip = symlinkSkip(home, settingsPath);
  if (preReadSkip !== null) {
    return { outcome: 'skipped', notice: preReadSkip.notice.replace('statusLine', 'tripwire-hook') };
  }

  const loaded = loadSettingsObject(settingsPath, 'removing tripwire-hook');
  if ('outcome' in loaded) return loaded;
  const obj = loaded.obj;

  const hooksVal = obj.hooks;
  if (!isPlainObject(hooksVal)) {
    return { outcome: 'skipped', notice: `forge: ${settingsPath} has no hooks object — nothing to remove.` };
  }
  const postVal = hooksVal.PostToolUse;
  if (!Array.isArray(postVal)) {
    return { outcome: 'skipped', notice: `forge: ${settingsPath} has no hooks.PostToolUse array — nothing to remove.` };
  }

  // Strip our nested hooks from each entry; drop entries left with no hooks.
  let removedAny = false;
  const rebuilt: unknown[] = [];
  for (const entry of postVal) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      rebuilt.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter((h) => {
      const isOurs =
        isPlainObject(h) && typeof h.command === 'string' && TRIPWIRE_HOOK_COMMANDS.includes(h.command);
      if (isOurs) removedAny = true;
      return !isOurs;
    });
    if (keptHooks.length === 0) {
      // Entire entry was ours → drop it (only if it had nested hooks to begin
      // with; an originally-empty user entry is preserved above via length check).
      if (entry.hooks.length > 0) continue;
      rebuilt.push(entry);
      continue;
    }
    rebuilt.push({ ...entry, hooks: keptHooks });
  }

  if (!removedAny) {
    return { outcome: 'skipped', notice: `forge: ${settingsPath} has no tripwire-hook entry — nothing to remove.` };
  }

  if (opts.dryRun) {
    return { outcome: 'dry-run', notice: `forge: would remove the tripwire-hook PostToolUse hook from ${settingsPath}.` };
  }

  // Rebuild hooks, dropping now-empty PostToolUse and then a now-empty hooks.
  const newHooks: Record<string, unknown> = { ...hooksVal };
  if (rebuilt.length === 0) {
    delete newHooks.PostToolUse;
  } else {
    newHooks.PostToolUse = rebuilt;
  }
  const newObj: Record<string, unknown> = { ...obj };
  if (Object.keys(newHooks).length === 0) {
    delete newObj.hooks;
  } else {
    newObj.hooks = newHooks;
  }

  const preWriteSkip = symlinkSkip(home, settingsPath);
  if (preWriteSkip !== null) {
    return { outcome: 'skipped', notice: preWriteSkip.notice.replace('statusLine', 'tripwire-hook') };
  }

  try {
    writeAtomic(settingsPath, `${JSON.stringify(newObj, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: 'skipped', notice: `forge: skipped removing tripwire-hook — ${msg}` };
  }
  return { outcome: 'written', notice: `forge: removed the tripwire-hook PostToolUse hook from ${settingsPath}.` };
}
