import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { CasError, DurableWriteError, FsWriteError } from './errors.ts';

// FORGE-208/209: default-deny when the target is a symbolic link or a
// multiply-linked regular file. rename(2) over either silently breaks the link
// relationship (see the per-check comments). Shared by writeAtomic and
// writeAtomicDurable.
//
// Preflight error handling: only a genuinely ABSENT target (ENOENT) is a fresh
// create and may proceed. Any other lstat failure (EACCES, ELOOP, ENOTDIR on a
// parent, …) is a real preflight failure and MUST propagate.
//
// TOCTOU caveat: there is an unavoidable window between this lstat and the
// rename — a symlink swapped in during that window is still replaced.
// Acceptable for a local CLI; do NOT read this as a complete no-follow
// guarantee.
function preflightNoLinkTarget(absPath: string): void {
  let st;
  try {
    st = lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return; // ENOENT — absent, fine: we'll create it.
  }
  if (st.isSymbolicLink()) {
    throw new FsWriteError(
      'SYMLINK_TARGET_REFUSED',
      `refusing to write ${absPath}: target is a symbolic link — renaming over it would destroy the link and materialize a divergent regular file`,
      { path: absPath },
    );
  }
  if (st.isFile() && st.nlink > 1) {
    throw new FsWriteError(
      'HARDLINK_TARGET_REFUSED',
      `refusing to write ${absPath}: target is a hard link (nlink=${st.nlink}) — renaming over it would detach this link and leave the other link(s) pointing at the old content`,
      { path: absPath, nlink: st.nlink },
    );
  }
}

export function writeAtomic(absPath: string, contents: string): void {
  preflightNoLinkTarget(absPath);

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

// FORGE-231: durability-hardened variant of writeAtomic for write-ahead
// records (ship record, task state, lease). writeAtomic's rename-only
// semantics are not enough when the file's presence is a proof consumed by
// external side effects — a crash before the data reaches disk could roll the
// record back. This variant fsyncs the temp file before rename and the
// directory after, and classifies every failure by phase (DurableWriteError)
// so casGuardedWrite knows whether its exclusivity marker may be released:
// every failure BEFORE rename is attempted (open/write/fsync/close of the
// temp file) provably left the target unchanged.
export function writeAtomicDurable(absPath: string, contents: string): void {
  // Preflight and directory creation happen before any byte is written — a
  // failure here is proven pre-placement. FsWriteError (symlink/hardlink
  // refusal) keeps its typed identity for direct callers; casGuardedWrite
  // classifies it as pre-placement too.
  try {
    preflightNoLinkTarget(absPath);
    mkdirSync(dirname(absPath), { recursive: true });
  } catch (err) {
    if (err instanceof FsWriteError) throw err;
    throw new DurableWriteError(
      'pre_placement',
      `durable write of ${absPath} failed in preflight: ${(err as Error).message}`,
      { path: absPath },
      { cause: err },
    );
  }
  const tmpPath = `${absPath}.forge-tmp-${process.pid}-${Date.now()}`;

  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeSync(fd, contents, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close on the failure path
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may not exist; ignore
    }
    throw new DurableWriteError(
      'pre_placement',
      `durable write of ${absPath} failed before placement: ${(err as Error).message}`,
      { path: absPath },
      { cause: err },
    );
  }

  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may already be gone; ignore
    }
    throw new DurableWriteError(
      'placement_ambiguous',
      `durable write of ${absPath} failed at rename: ${(err as Error).message}`,
      { path: absPath },
      { cause: err },
    );
  }

  try {
    const dirFd = openSync(dirname(absPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    // Content landed but the directory entry's durability is unproven.
    throw new DurableWriteError(
      'placement_ambiguous',
      `durable write of ${absPath} failed at directory fsync: ${(err as Error).message}`,
      { path: absPath },
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// FORGE-231: casGuardedWrite — single-committer version transitions on local
// files (task state, ship record, lease). See spec/ORCHESTRATOR.md §Ship
// record / §Leases for the protocol contract.
//
// Exclusivity comes from O_EXCL creation of a version marker next to the
// guarded file: `<file>.cas-<N>` guards the N→N+1 transition, `<file>.cas-create`
// guards initial creation ('create' is a DISTINCT domain — version 0 is a real
// version, so `.cas-0` means 0→1, never "create"). Correctness of the written
// content comes from the MANDATORY post-acquire re-read: the RMW input is read
// under marker ownership, so a stale pre-acquire read can never be committed.
//
// Recovery is conservative (no takeover): a marker whose transition is
// incomplete is NEVER removed by an automated path — only its own creator (on
// a pre-placement abort) or a human following the gc report's remediation may
// remove it. A marker whose transition provably completed (numeric marker
// version < current file version; create marker with the file present) may be
// unlinked by anyone.
// ---------------------------------------------------------------------------

const CAS_READ_MAX_BYTES_DEFAULT = 1024 * 1024;

export interface CasHolderIdentity {
  run_id: string;
  claim_id: string;
  generation: number;
}

export interface CasMarkerContent extends CasHolderIdentity {
  pid: number;
  token: string;
  created_at: string;
}

export interface CasGuardedWriteOptions {
  filePath: string;
  /** number = guard the N→N+1 transition; 'create' = guard initial creation. */
  expectedVersion: number | 'create';
  holder: CasHolderIdentity;
  /** Extract the monotonic version from the guarded file's raw content. */
  readVersion: (raw: string) => number;
  /**
   * Build the new serialized content. Receives the POST-ACQUIRE read (null on
   * the create path) — this is the only content a mutation may derive from.
   */
  buildContent: (currentRaw: string | null) => string;
  /**
   * Operation-specific fence predicate, run after marker acquisition and
   * before buildContent. Each caller supplies its own semantics (active
   * unexpired lease for state/ship-record commits; identity-even-expired for
   * release; predecessor-expired for steal; none for never-leased acquire).
   * Throw CasError to abort; the marker is released (pre-placement).
   */
  fence?: () => void;
  maxBytes?: number;
}

export function casMarkerPath(filePath: string, expectedVersion: number | 'create'): string {
  return `${filePath}.cas-${expectedVersion}`;
}

// A held CAS marker: the exclusive right to commit one version transition.
// Produced by acquireCasMarker; consumed by commitUnderCasMarker or released
// by releaseCasMarker. Exported so multi-file protocols (lease steal) can hold
// a marker on one file across a guarded write to another.
export interface HeldCasMarker {
  filePath: string;
  markerPath: string;
  expectedVersion: number | 'create';
  /** The post-acquire read of the guarded file (null on the create path). */
  raw: string | null;
}

// Steps 1-3 of the protocol: pre-check, wx acquire, mandatory post-acquire
// revalidation. On any failure the marker (if created) is released. The
// returned `raw` is the ONLY content a mutation may derive from.
export function acquireCasMarker(
  filePath: string,
  expectedVersion: number | 'create',
  holder: CasHolderIdentity,
  readVersion: (raw: string) => number,
  maxBytes: number = CAS_READ_MAX_BYTES_DEFAULT,
): HeldCasMarker {
  // 1. Fast-fail pre-check (optimization — the authoritative check is step 3).
  const preRaw = readGuardedRaw(filePath, maxBytes);
  const preVersion = versionAt(filePath, preRaw, readVersion);
  if (expectedVersion === 'create') {
    if (preRaw !== null) {
      throw new CasError('version_conflict', `${filePath} already exists (expected create)`, {
        path: filePath,
        current_version: preVersion,
      });
    }
  } else if (preVersion !== expectedVersion) {
    throw new CasError(
      'version_conflict',
      `${filePath} is at version ${preVersion ?? '<absent>'}, expected ${expectedVersion}`,
      { path: filePath, current_version: preVersion, expected_version: expectedVersion },
    );
  }

  // 2. CAS acquire: wx-create of the marker.
  const markerPath = casMarkerPath(filePath, expectedVersion);
  const marker: CasMarkerContent = {
    ...holder,
    pid: process.pid,
    token: uuidv7(),
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CasError('cas_conflict', `transition marker ${markerPath} is held`, {
        path: filePath,
        marker_path: markerPath,
      });
    }
    throw new CasError(
      'io',
      `cannot create transition marker ${markerPath}: ${(err as Error).message}`,
      { path: filePath, marker_path: markerPath },
      { cause: err },
    );
  }

  // 3. POST-ACQUIRE REVALIDATION (mandatory, load-bearing).
  try {
    const raw = readGuardedRaw(filePath, maxBytes);
    const version = versionAt(filePath, raw, readVersion);
    if (expectedVersion === 'create') {
      if (raw !== null) {
        throw new CasError('version_conflict', `${filePath} appeared during create (now at version ${version})`, {
          path: filePath,
          current_version: version,
        });
      }
    } else if (version !== expectedVersion) {
      throw new CasError(
        'version_conflict',
        `${filePath} moved to version ${version ?? '<absent>'} before acquisition (expected ${expectedVersion})`,
        { path: filePath, current_version: version, expected_version: expectedVersion },
      );
    }
    return { filePath, markerPath, expectedVersion, raw };
  } catch (err) {
    releaseCasMarker({ filePath, markerPath, expectedVersion, raw: null });
    throw err;
  }
}

// Abort path: release a marker whose transition never began placement. Safe:
// while the guarded file is unadvanced the marker is provably still ours (the
// completed-cleanup rule requires advancement); in the advanced case only a
// junk marker of an aborting writer can occupy the path.
export function releaseCasMarker(held: HeldCasMarker): void {
  try {
    unlinkSync(held.markerPath);
  } catch {
    // already gone — harmless
  }
}

// Step 6: durable placement under a held marker. On a proven pre-placement
// failure the marker is released and the error is retriable; on an ambiguous
// failure the marker is RETAINED and surfaced for recovery.
export function commitUnderCasMarker(held: HeldCasMarker, contents: string): void {
  try {
    writeAtomicDurable(held.filePath, contents);
  } catch (err) {
    const provenPrePlacement =
      (err instanceof DurableWriteError && err.phase === 'pre_placement') ||
      err instanceof FsWriteError; // preflight refusal — nothing was written
    if (provenPrePlacement) {
      releaseCasMarker(held);
      throw new CasError(
        'io',
        `durable write failed before placement: ${(err as Error).message}`,
        { path: held.filePath, retriable: true },
        { cause: err },
      );
    }
    throw new CasError(
      'io',
      `durable write failed ambiguously (marker retained): ${(err as Error).message}`,
      { path: held.filePath, retriable: false, marker_path: held.markerPath },
      { cause: err },
    );
  }
}

// Capped, no-symlink read of the guarded file. Returns null when absent.
function readGuardedRaw(filePath: string, maxBytes: number): string | null {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CasError('io', `cannot stat ${filePath}: ${(err as Error).message}`, { path: filePath }, { cause: err });
  }
  if (!st.isFile()) {
    throw new CasError('io', `refusing to read ${filePath}: not a regular file`, { path: filePath });
  }
  if (st.size > maxBytes) {
    throw new CasError('io', `refusing to read ${filePath}: ${st.size} bytes exceeds cap ${maxBytes}`, {
      path: filePath,
      size: st.size,
    });
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new CasError('io', `cannot read ${filePath}: ${(err as Error).message}`, { path: filePath }, { cause: err });
  }
}

function versionAt(
  filePath: string,
  raw: string | null,
  readVersion: (raw: string) => number,
): number | null {
  if (raw === null) return null;
  try {
    return readVersion(raw);
  } catch (err) {
    throw new CasError(
      'io',
      `cannot extract version from ${filePath}: ${(err as Error).message}`,
      { path: filePath },
      { cause: err },
    );
  }
}

export function casGuardedWrite(opts: CasGuardedWriteOptions): void {
  const maxBytes = opts.maxBytes ?? CAS_READ_MAX_BYTES_DEFAULT;
  const { filePath, expectedVersion, readVersion } = opts;

  // Steps 1-3: pre-check, wx acquire, post-acquire revalidation.
  const held = acquireCasMarker(filePath, expectedVersion, opts.holder, readVersion, maxBytes);

  // Steps 4-6 run under an exception-safe guard: ANY exit before durable
  // placement begins (typed abort or thrown fence/mutator/schema exception)
  // releases the marker — only process death between acquire and placement, or
  // an ambiguous placement failure, leaves a stuck marker.
  let commitStarted = false;
  try {
    // 4. Operation-specific fence (advisory defense-in-depth — exclusivity
    //    never depends on it).
    opts.fence?.();

    // 5. Build the new content from the post-acquire read.
    const next = opts.buildContent(held.raw);

    // 6. Durable placement (commitUnderCasMarker owns the marker policy from
    //    here: released on proven pre-placement failure, retained on ambiguity).
    commitStarted = true;
    commitUnderCasMarker(held, next);
  } catch (err) {
    // Every exit BEFORE placement began releases the marker — including
    // caller-thrown CasErrors of any code. Once commit started, the marker
    // policy was already applied by commitUnderCasMarker.
    if (!commitStarted) releaseCasMarker(held);
    if (err instanceof CasError) throw err;
    throw new CasError(
      'io',
      `casGuardedWrite on ${filePath} failed: ${(err as Error).message}`,
      { path: filePath },
      { cause: err },
    );
  }

  // 7. Success. Our marker's transition is now provably complete (file version
  //    advanced past it), so it — and any other completed markers — may be
  //    cleaned opportunistically. Best-effort; gc also runs this rule.
  try {
    const raw = readGuardedRaw(filePath, maxBytes);
    const version = raw === null ? null : readVersion(raw);
    cleanupCompletedCasMarkers(filePath, version);
  } catch {
    // Cleanup is opportunistic; gc will catch up.
  }
}

export interface CasMarkerInfo {
  markerPath: string;
  /** Which transition the marker guards. */
  domain: number | 'create';
  /** Parsed marker content, or null when unreadable/corrupt. */
  content: CasMarkerContent | null;
  /**
   * Whether the guarded transition provably completed (numeric marker version
   * < current file version; create marker with the file present). Completed
   * markers are safe to unlink; incomplete ones must never be auto-removed.
   */
  completed: boolean;
}

// Enumerate CAS markers next to a guarded file. `currentVersion` is the
// guarded file's current version, or null when the file is absent.
export function listCasMarkers(filePath: string, currentVersion: number | null): CasMarkerInfo[] {
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.cas-`;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CasMarkerInfo[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.startsWith(prefix)) continue;
    const suffix = ent.name.slice(prefix.length);
    let domain: number | 'create';
    if (suffix === 'create') {
      domain = 'create';
    } else if (/^\d+$/.test(suffix)) {
      domain = Number(suffix);
    } else {
      continue; // not one of ours
    }
    const markerPath = join(dir, ent.name);
    let content: CasMarkerContent | null = null;
    try {
      const st = lstatSync(markerPath);
      if (st.isFile() && st.size <= 64 * 1024) {
        content = JSON.parse(readFileSync(markerPath, 'utf8')) as CasMarkerContent;
      }
    } catch {
      content = null;
    }
    const completed =
      domain === 'create' ? currentVersion !== null : currentVersion !== null && domain < currentVersion;
    out.push({ markerPath, domain, content, completed });
  }
  return out;
}

// Remove markers whose transition provably completed. Incomplete markers are
// left untouched — conservative no-takeover recovery (gc REPORTS them; removal
// of an incomplete marker is a documented manual operation).
export function cleanupCompletedCasMarkers(filePath: string, currentVersion: number | null): void {
  for (const info of listCasMarkers(filePath, currentVersion)) {
    if (!info.completed) continue;
    try {
      unlinkSync(info.markerPath);
    } catch {
      // already gone or unremovable — gc will report if it persists
    }
  }
}
