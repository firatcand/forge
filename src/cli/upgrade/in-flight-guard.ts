// FORGE-155: the `forge upgrade` exit-2 in-flight guard.
//
// Refuses an upgrade (so a methodology refresh can't clobber mid-flight work)
// when the working tree is dirty OR a non-expired worker lease exists. Both are
// overridden by `--force`; the whole guard is gated by settings
// `upgrade.guard_in_flight` (default true). See
// spec/decisions/2026-06-26-upgrade-exit-2-lease-semantics.md.
//
// Lease semantics (user-approved):
//   - "active" = non-expired, via the orchestrator's own classifyLeaseHealth.
//   - Leases live ONLY under the main checkout's .forge/orchestrator/tasks/, so
//     we resolve the main checkout (git-common-dir) even when invoked from a
//     worktree, and scan all task leases there.
//   - A malformed / unreadable / non-regular / oversized lease is FAIL-CLOSED
//     (treated as active → blocks), as is any git/scan ambiguity.
//
// This is a SAFETY guard over a hand-editable tree, so it is hardened against a
// hostile git environment (config / env injection) and hostile lease files
// (symlinks, FIFOs, huge files): every "can't tell" resolves to BLOCK.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execaSync } from 'execa';

import { tasksRootDir } from '../../orchestrator/questions/paths.ts';
import { classifyLeaseHealth } from '../../orchestrator/leases.ts';
import { LeaseSchema } from '../../schemas/lease.ts';

// A lease is ~400 bytes; anything larger is corrupt/hostile → fail-closed.
const MAX_LEASE_BYTES = 64 * 1024;
// The orchestrator's task-id contract (src/orchestrator/questions/paths.ts
// TASK_ID_RE): alphanumeric start, then letters/digits/._-, max 64. A task dir or
// lease task_id that does NOT match cannot be produced by the orchestrator path
// helpers → corrupt tree → fail-closed.
const ORCHESTRATOR_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface InFlightGuardInput {
  readonly cwd: string;
  readonly force: boolean;
  readonly guardEnabled: boolean;
  /** Injectable clock for tests; defaults to now. */
  readonly now?: Date;
}

export interface InFlightRefusal {
  readonly exitCode: 2;
  readonly stderr: string;
}

// Returns an exit-2 refusal when work is in flight, or null to proceed.
export function checkInFlight(input: InFlightGuardInput): InFlightRefusal | null {
  // Toggle off → never guard. --force → override BOTH conditions.
  if (!input.guardEnabled || input.force) return null;

  const reasons: string[] = [];

  // Defeat a repo-local `core.worktree` (or any config) that redirects git's view
  // of the working tree away from cwd: both the dirty probe and the lease
  // resolution would otherwise inspect the wrong directory and pass clean. Require
  // git's top-level to be EXACTLY cwd (so `forge upgrade` runs at the repo root,
  // and any child/ancestor redirect fails closed up front).
  const wt = verifyWorkTreeIsCwd(input.cwd);
  if (wt !== 'ok') {
    return {
      exitCode: 2,
      stderr: [
        'forge upgrade: refusing — the git working tree could not be verified ' +
          '(it may be redirected by repo configuration).',
        'Re-run with --force to override.',
      ].join('\n'),
    };
  }

  const dirty = assessDirtyTree(input.cwd);
  if (dirty === 'dirty') reasons.push('the working tree has uncommitted changes');
  else if (dirty === 'error') {
    reasons.push('the working tree state could not be determined (git status failed)');
  }

  const now = input.now ?? new Date();
  const scan = scanLeases(input.cwd, now);
  if (scan.scanError) reasons.push(scan.scanError);
  if (scan.blockingTasks.length > 0) {
    reasons.push(
      `an active worker lease exists (task${scan.blockingTasks.length > 1 ? 's' : ''}: ${scan.blockingTasks.join(', ')})`,
    );
  }

  if (reasons.length === 0) return null;

  return {
    exitCode: 2,
    stderr: [
      `forge upgrade: refusing — ${reasons.join('; ')}.`,
      'Commit your changes and let active tasks finish, or re-run with --force to override.',
    ].join('\n'),
  };
}

// ── git ─────────────────────────────────────────────────────────────────────

type GitRun = { stdout: string } | { notARepo: true } | { error: string };

// Run git with a HARDENED environment so a hostile caller cannot redirect or
// reshape the probe: strip the path-redirect vars (GIT_DIR / GIT_WORK_TREE / …)
// and ALL GIT_CONFIG* injection vars, and ignore user/system config
// (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null) so config like status.showUntrackedFiles
// cannot silence the check. GIT_OPTIONAL_LOCKS=0 keeps `status` from rewriting
// .git/index (exit-2 must mutate nothing). Distinguishes "not a git repo" from a
// genuine git error so the caller can fail-closed on the latter.
function runGit(cwd: string, args: readonly string[]): GitRun {
  let res;
  try {
    // `-c core.fsmonitor=false` neutralizes a repo-local core.fsmonitor (else
    // `git status` would EXECUTE that configured command). `-c core.excludesFile=
    // /dev/null` neutralizes the GLOBAL excludes file (default
    // $XDG_CONFIG_HOME/git/ignore, consulted even with global config disabled) so
    // a user-level `*` ignore cannot hide untracked changes from the probe; the
    // repo's own .gitignore still applies. The only "can't tell" that is inert is
    // a parsed Git "not a repository"; a spawn/maxBuffer/signal failure is
    // ambiguous and fails closed (handled by the caller as an error).
    res = execaSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', ...args], {
      cwd,
      reject: false,
      extendEnv: false,
      env: hardenedGitEnv(),
    });
  } catch (err) {
    return { error: `git could not be run (${errCode(err)})` };
  }
  if (res.exitCode === 0) return { stdout: res.stdout };
  const stderr = (res.stderr ?? '').toLowerCase();
  if (stderr.includes('not a git repository') || stderr.includes('not a working tree')) {
    return { notARepo: true };
  }
  return { error: res.stderr || `git exited ${res.exitCode}` };
}

function hardenedGitEnv(): NodeJS.ProcessEnv {
  // Strip EVERY GIT_* var (GIT_DIR / GIT_WORK_TREE redirects, GIT_CONFIG*
  // injection, and GIT_TRACE* / GIT_TRACE2_EVENT which would WRITE trace files —
  // potentially over a managed file — during status/rev-parse), then set back
  // only the known-safe knobs. A probe with an explicit cwd needs no GIT_* var.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Uppercase before matching: on Windows env names are case-insensitive, so
    // `git_dir` / `Git_Config_Count` would still be honored by git as GIT_*.
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

type DirtyState = 'clean' | 'dirty' | 'error' | 'inert';

// 'clean' | 'dirty' | 'error' | 'inert' (not a git repo — nothing to protect).
function assessDirtyTree(cwd: string): DirtyState {
  // (1) The user's source — everything EXCEPT `.forge`, including NEW untracked
  //     files. `.forge` is split out because it mixes upgrade-owned files with
  //     volatile generated state.
  const src = statusDirty(cwd, 'all', [':(exclude).forge']);
  if (src === 'inert' || src === 'error') return src;
  // (2) TRACKED `.forge` mutations only (`--untracked-files=no`): files the
  //     adopter committed and that upgrade may rewrite — settings.yaml, and any
  //     committed CONTEXT.md / .version / manifest.json — must block so an upgrade
  //     never clobbers an uncommitted edit. UNtracked/generated `.forge` state
  //     (the orchestrator tree, an expired lease, worktrees, loom.db) is NOT
  //     counted, so it never falsely registers as dirty.
  const forgeTracked = statusDirty(cwd, 'no', ['.forge']);
  if (forgeTracked === 'error') return 'error';
  // (3) settings.yaml specifically, INCLUDING when untracked: a fresh repo can
  //     have an uncommitted .forge/settings.yaml (init writes it) that upgrade may
  //     rewrite — pass (1) excludes it and pass (2) is -uno, so catch it here.
  const settings = statusDirty(cwd, 'all', ['.forge/settings.yaml']);
  if (settings === 'error') return 'error';
  return src === 'dirty' || forgeTracked === 'dirty' || settings === 'dirty' ? 'dirty' : 'clean';
}

// Run a scoped `git status --porcelain` over the given pathspecs. Hardened env +
// --no-optional-locks (no .git/index rewrite); the untracked mode is explicit so
// it overrides any status.showUntrackedFiles config.
function statusDirty(
  cwd: string,
  untracked: 'all' | 'no',
  pathspecs: readonly string[],
): DirtyState {
  const r = runGit(cwd, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    `--untracked-files=${untracked}`,
    '--',
    ...pathspecs,
  ]);
  if ('notARepo' in r) return 'inert';
  if ('error' in r) return 'error';
  return r.stdout.trim().length > 0 ? 'dirty' : 'clean';
}

// 'ok' when git's working-tree top-level is EXACTLY cwd (so status / lease scans
// inspect the directory being upgraded), otherwise fail-closed. Exact equality
// (not containment) is what defeats a `core.worktree` redirect to a CHILD or an
// ANCESTOR of cwd. A non-git dir is 'ok' (no redirect possible; the not-a-repo
// path is handled downstream).
function verifyWorkTreeIsCwd(cwd: string): 'ok' | 'mismatch' {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if ('notARepo' in top) return 'ok';
  if ('error' in top) return 'mismatch';
  const topPath = top.stdout.trim();
  if (!topPath) return 'mismatch';
  try {
    return realpathSync(topPath) === realpathSync(cwd) ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

// ── leases ──────────────────────────────────────────────────────────────────

interface LeaseScan {
  readonly blockingTasks: string[];
  readonly scanError: string | null;
}

// Resolve the MAIN checkout's .forge dir (leases live only there). Returns the
// path, OR an error string when resolution is ambiguous (a git error from inside
// a repo → fail-closed rather than silently scanning the wrong tree).
//
// No single git primitive is correct for every topology, so we branch on whether
// the CURRENT tree is the main checkout or a linked worktree:
//   - main checkout (current gitdir == common gitdir): `--show-toplevel` gives the
//     working tree, correct even for `git init --separate-git-dir` (where the git
//     dir lives outside the tree, so worktree-list / dirname(common-dir) lie).
//   - linked worktree (gitdir != common): the main is the FIRST `worktree` entry
//     of `git worktree list --porcelain`.
function resolveMainForgeDir(cwd: string): { forgeDir: string } | { error: string } {
  const gitDir = runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if ('notARepo' in gitDir) {
    // Not a git repo → no worktree indirection; leases (if any) live under cwd.
    return { forgeDir: join(resolve(cwd), '.forge') };
  }
  if ('error' in gitDir) {
    return { error: 'the main checkout could not be resolved (git rev-parse failed)' };
  }
  const commonDir = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!('stdout' in commonDir)) {
    return { error: 'the main checkout could not be resolved (git-common-dir failed)' };
  }

  if (gitDir.stdout.trim() === commonDir.stdout.trim()) {
    // Current tree IS the main checkout.
    const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
    const topPath = 'stdout' in top ? top.stdout.trim() : '';
    if (!topPath) return { error: 'the main checkout could not be resolved (show-toplevel failed)' };
    return { forgeDir: join(topPath, '.forge') };
  }

  // Linked worktree → main is the first worktree-list entry. Use NUL-delimited
  // porcelain (`-z`) so a checkout path containing a newline or trailing spaces is
  // not corrupted by line-splitting/trimming, then VERIFY the resolved path is a
  // real directory (fail-closed otherwise — a mis-resolved main would silently
  // scan an empty `.forge` and miss the real lease).
  const wl = runGit(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if ('stdout' in wl) {
    const first = wl.stdout.split('\0').find((rec) => rec.startsWith('worktree '));
    const mainPath = first?.slice('worktree '.length); // exact: NUL is the terminator
    if (mainPath) {
      try {
        if (lstatSync(mainPath).isDirectory()) return { forgeDir: join(mainPath, '.forge') };
      } catch {
        // fall through to the fail-closed error below
      }
    }
  }
  return { error: 'the main checkout could not be resolved (no verifiable main worktree)' };
}

function scanLeases(cwd: string, now: Date): LeaseScan {
  const resolved = resolveMainForgeDir(cwd);
  if ('error' in resolved) return { blockingTasks: [], scanError: resolved.error };

  // Verify the whole .forge → orchestrator → tasks chain is real directories (no
  // symlink at any level) BEFORE readdir follows it — a `tasks -> /elsewhere`
  // symlink would otherwise scan outside the main checkout and silently miss
  // leases. Missing chain → no tree (inert); symlink/non-dir → fail-closed.
  const chain = classifyTasksRootChain(resolved.forgeDir);
  if (chain === 'missing') return { blockingTasks: [], scanError: null };
  if (chain === 'unsafe') {
    return {
      blockingTasks: [],
      scanError: `the orchestrator task tree under ${resolved.forgeDir} is a symlink or non-directory`,
    };
  }

  const tasksRoot = tasksRootDir(resolved.forgeDir);
  let names: string[];
  try {
    names = readdirSync(tasksRoot);
  } catch (err) {
    if (isEnoent(err)) return { blockingTasks: [], scanError: null };
    return {
      blockingTasks: [],
      scanError: `the orchestrator task tree at ${tasksRoot} could not be read (${errCode(err)})`,
    };
  }

  const blockingTasks: string[] = [];
  for (const name of names) {
    // Classify each entry with an explicit lstat rather than trusting
    // Dirent.d_type: some filesystems report DT_UNKNOWN, which would make a real
    // task dir look like a non-directory and get skipped (a fail-OPEN gap).
    const entryPath = join(tasksRoot, name);
    let est;
    try {
      est = lstatSync(entryPath);
    } catch (err) {
      if (isEnoent(err)) continue; // raced away
      blockingTasks.push(reportableId(name)); // unreadable entry → fail-closed
      continue;
    }
    if (est.isSymbolicLink()) {
      // A symlinked task dir could hide a lease (or be an escape attempt) → block.
      blockingTasks.push(reportableId(name));
      continue;
    }
    if (!est.isDirectory()) continue; // stray non-dir entries are not task dirs

    const leasePath = join(entryPath, 'lease.json');
    if (!ORCHESTRATOR_TASK_ID.test(name)) {
      // A task-dir name the orchestrator cannot produce. If it actually holds a
      // lease file, the tree is corrupt → fail-closed; otherwise it's a stray dir.
      if (hasLeaseFile(leasePath)) blockingTasks.push(reportableId(name));
      continue;
    }
    if (leaseBlocks(leasePath, name, now)) blockingTasks.push(reportableId(name));
  }
  blockingTasks.sort();
  return { blockingTasks, scanError: null };
}

// Does a lease file exist at this path (any type, incl. unreadable)? Only a clean
// ENOENT counts as "no lease".
function hasLeaseFile(leasePath: string): boolean {
  try {
    lstatSync(leasePath);
    return true;
  } catch (err) {
    return !isEnoent(err);
  }
}

// Classify the orchestrator's in-progress lease temp files. The atomic writer
// (write-tmp → unlink → link) leaves a `lease.json.<pid>.<n>.<hex>.tmp` sibling
// present across the window where lease.json is momentarily absent. Each temp is
// classified by the SAME rules as a canonical lease (leaseBlocks): a live or
// malformed temp blocks; a valid-but-expired temp (e.g. a crashed writer's stale
// leftover) does NOT — so it cannot wedge upgrades forever. Returns true if any
// temp blocks. A dir that cannot be read (EACCES) fails closed.
function tmpLeaseBlocks(taskDir: string, dirTaskId: string, now: Date): boolean {
  let names: string[];
  try {
    names = readdirSync(taskDir);
  } catch (err) {
    return !isEnoent(err); // vanished → no lease; unreadable → fail-closed
  }
  for (const n of names) {
    if (n.startsWith('lease.json.') && n.endsWith('.tmp')) {
      if (leaseBlocks(join(taskDir, n), dirTaskId, now)) return true;
    }
  }
  return false;
}

// 'ok' (every component is a real directory), 'missing' (some component absent →
// no orchestrator tree), or 'unsafe' (a symlink or non-directory in the chain).
function classifyTasksRootChain(forgeDir: string): 'ok' | 'missing' | 'unsafe' {
  const chain = [forgeDir, join(forgeDir, 'orchestrator'), tasksRootDir(forgeDir)];
  for (const p of chain) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      return isEnoent(err) ? 'missing' : 'unsafe';
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'unsafe';
  }
  return 'ok';
}

// True when this lease should block the upgrade: non-expired (alive), OR
// non-regular (symlink/dir/FIFO/device), oversized, unreadable, unparseable,
// schema-invalid, OR its payload task_id does not match its directory (all
// fail-closed). A missing file (ENOENT) does not block.
function leaseBlocks(leasePath: string, dirTaskId: string, now: Date): boolean {
  let st;
  try {
    st = lstatSync(leasePath); // lstat: never follow a symlinked lease.json
  } catch (err) {
    if (!isEnoent(err)) return true; // unreadable → fail-closed
    // ENOENT is ambiguous: genuinely no lease, OR the heartbeat/steal writer's
    // torn window (overwriteAtomicLink does unlink(lease.json) → link(tmp)), during
    // which a fully-written `lease.json.<pid>.<n>.<hex>.tmp` sibling exists.
    // Classify any such temp like a canonical lease (alive/malformed → block;
    // valid-but-expired → do not) so a CRASHED writer's stale temp cannot wedge
    // upgrades forever.
    return tmpLeaseBlocks(dirname(leasePath), dirTaskId, now);
  }
  // Reject anything that is not a plain file (symlink, dir, FIFO, device, …) and
  // anything larger than a real lease — never read it.
  if (!st.isFile()) return true;
  if (st.size > MAX_LEASE_BYTES) return true;

  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch {
    // lstat already established the file EXISTED; if it cannot be read now (even
    // ENOENT), it vanished between lstat and read. That is the lease writer's
    // unlink-then-link heartbeat window, not a benign absence → fail-closed.
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true; // corrupt JSON → fail-closed
  }

  const result = LeaseSchema.safeParse(parsed);
  if (!result.success) return true; // schema-invalid → fail-closed

  // Orchestrator invariant: a lease's payload task_id matches its directory. A
  // mismatch is a corrupt/tampered lease → fail-closed (don't trust expires_at).
  if (result.data.task_id !== dirTaskId) return true;

  return classifyLeaseHealth(result.data.expires_at, now) === 'alive';
}

// Sanitize a task-dir name before echoing it into the refusal message (readdir
// never yields path separators, but a hand-created dir name can be arbitrary).
function reportableId(name: string): string {
  return ORCHESTRATOR_TASK_ID.test(name) ? name : '<unnamed>';
}

function isEnoent(err: unknown): boolean {
  return errCode(err) === 'ENOENT';
}

function errCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown error';
}
