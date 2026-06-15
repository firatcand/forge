// FORGE-200 (Loom I1): node:sqlite access for the local memory backend.
//
// CRITICAL (Codex B1 — lazy import): `node:sqlite` is EXPERIMENTAL and emits an
// ExperimentalWarning on stderr the moment the module is loaded. The statusline /
// --version paths must be noise-free, and src/bin/forge.ts statically imports its
// subcommand modules at load time. So `node:sqlite` is imported LAZILY via
// `await import('node:sqlite')` INSIDE openDb() — never a top-level import. Even
// importing the loom dispatcher/handlers (tests, --help) therefore loads zero
// sqlite until a verb actually opens the DB. (Belt-and-suspenders: forge.ts also
// dynamic-imports the loom dispatcher only inside the `command === 'loom'` branch.)

import { mkdirSync } from 'node:fs';
import path from 'node:path';

// node:sqlite has no bundled @types; describe only the surface we use. The real
// module is loaded at runtime via the lazy import in openDb().
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface OpenDb {
  readonly db: SqliteDatabase;
  readonly dbPath: string;
}

// Open (creating if absent) the loom DB at dbPath, apply the concurrency pragmas,
// and ensure the schema exists. Async because the sqlite import is lazy.
//
// Pragmas (mandatory per the ticket): WAL journaling + a 5s busy_timeout so
// concurrent writers retry-then-block instead of failing fast with SQLITE_BUSY.
export async function openDb(dbPath: string): Promise<OpenDb> {
  // Ensure the parent dir (e.g. <root>/.forge) exists before sqlite touches the
  // file — sqlite will not create intermediate directories.
  mkdirSync(path.dirname(dbPath), { recursive: true });

  // Lazy import — keeps the ExperimentalWarning off every non-loom invocation.
  const sqlite = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  };
  const db = new sqlite.DatabaseSync(dbPath);

  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = OFF;');
    createSchema(db);
  } catch (err) {
    // Fail loudly: a DB we cannot initialize is unusable. Close the handle so we
    // do not leak the file lock on the way out.
    try {
      db.close();
    } catch {
      // best-effort close; surface the original error below.
    }
    throw new Error(
      `loom: failed to initialize SQLite database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { db, dbPath };
}

// Create the graph tables + the FTS5 index over node title+body. `IF NOT EXISTS`
// keeps openDb idempotent; reset() (DELETE-all) keeps these stable across rebuilds.
function createSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id    TEXT PRIMARY KEY,
      kind  TEXT NOT NULL,
      title TEXT NOT NULL,
      body  TEXT NOT NULL,
      attrs TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      src  TEXT NOT NULL,
      dst  TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (src, dst, kind)
    );
  `);
  // Standalone FTS5 table (not external-content) keyed by node id (UNINDEXED) so
  // we can keep it in sync with a delete+insert per node on upsert.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      title,
      body
    );
  `);
  // Index the edge endpoints for BFS traversal.
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, kind);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, kind);');
}
