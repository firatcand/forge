# time-logger — SPEC

## Stack

- Runtime: Node.js 20+ (LTS)
- Frontend: N/A (CLI only)
- Backend: TypeScript on Node — single binary CLI, no server
- Database: SQLite via `better-sqlite3` (synchronous, single-file, embedded)
- Hosting: N/A (local install via `npm install -g time-logger` or `pnpm dlx time-logger`)
- Auth: N/A (single-user, single-machine)
- CLI framework: `commander` (lightweight, no plugin system needed)

## Data model

```sql
CREATE TABLE projects (
  name        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL  -- unix epoch seconds
);

CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL REFERENCES projects(name) ON DELETE RESTRICT,
  note        TEXT,
  started_at  INTEGER NOT NULL,                       -- unix epoch seconds
  ended_at    INTEGER                                 -- nullable: open entries
);

CREATE INDEX idx_entries_project_started ON entries (project, started_at DESC);
CREATE INDEX idx_entries_open            ON entries (ended_at) WHERE ended_at IS NULL;
```

Migrations live in `migrations/` numbered `0001_init.sql`, `0002_*.sql`. Applied on first run via better-sqlite3's `prepare`/`run` API; tracked in a `migrations_applied` table.

## Key flows

### Flow 1: `tl <project> [note]`
1. Parse argv via `commander`
2. Open SQLite connection at `${TL_HOME:-~/.tl}/data.db` (create directory + file if missing)
3. Apply pending migrations
4. In a transaction:
   - Find any open entry (`ended_at IS NULL`); set its `ended_at = now`
   - Insert new entry: `(project, note, now, NULL)`
5. Print confirmation
6. Edge cases:
   - Project not registered → suggest `tl init <project>` and exit non-zero
   - Open entry from >12 hours ago → confirm before closing (might be forgotten overnight)
   - Database locked → retry once after 100ms; fail with clear message if still locked

### Flow 2: `tl report [--week N]`
1. Compute date range (last 7 days, or N*7 days back)
2. Query: `SELECT project, SUM(ended_at - started_at) AS seconds FROM entries WHERE started_at >= ? GROUP BY project`
3. Format as a table with hours, percentages, and last note per project
4. Open entries (no `ended_at`) count as `now - started_at`

### Flow 3: `tl status`
1. Query the single open entry (if any)
2. Print: `Working on <project>: "<note>" (started 14:32, elapsed 1h18m)`
3. Exit 0 if open, exit 1 if no open entry (useful for shell prompt integration)

## Integration points

- None in v1. No external services, no network calls.

## Security model

- AuthN: N/A (local file)
- AuthZ: filesystem permissions (database file mode `0600`, parent dir `0700`)
- Sensitive data: no PII stored; notes are user-controlled free text and never leave the machine
- Rate limiting: N/A
- Threat model: untrusted user on the same machine reading the database. Mitigation: standard POSIX permissions. No additional encryption — this is a personal tool, not a vault.

## Environment variables

- `TL_HOME` — directory for database (default `~/.tl`). Useful for tests and CI.
- `TL_NOW` — override "now" for tests (unix epoch seconds). Production code reads `Date.now()`.
- `NO_COLOR` — standard convention; disables ANSI output when set.

## Performance targets

- p95 command latency: <50ms (cold start on M1, includes Node startup, SQLite open, query, format)
- p99 command latency: <100ms even with 10,000 entries
- `tl report` over 1 year of data (~2,000 entries): <80ms

## Observability

- Logs: none in normal operation. With `TL_DEBUG=1`, log SQL queries and timings to stderr.
- Metrics: none.
- Errors: caught at the top level; print user-friendly message + suggested action; exit non-zero. Stack traces only when `TL_DEBUG=1`.
