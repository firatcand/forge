# When an ID appears in both the filesystem path and the file payload, the writer must enforce equality
> 2026-05-15 · FORGE-73 · tags: [orchestrator, filesystem, atomic-write, defense-in-depth, path-traversal]

## What we expected
Writers that accept an ID for path construction and an ID embedded in the payload content are treated as a single value by callers — no mismatch possible.

## What happened
`writer.ts` accepted `opts.taskId` (used to build the destination path) and `question.task_id` (embedded in the JSON payload) as separate inputs with no equality check. A caller could pass different values. The path-based consumer (gc reconciliation, which scans directories) and the payload-based consumer (decision_key deduplication, which reads JSON) would then disagree on which task a question belongs to — silently, with no error at write time.

## Why
This is a general hazard whenever a single logical identifier is duplicated across two representations that travel together: the directory/filename and the file contents. If the writer does not assert they are equal, the two representations can drift. Each consumer then picks whichever source of truth matches its own access pattern, and the two consumers give inconsistent answers about the same artifact.

The same pattern appears in: manifest files keyed by directory name, config files in directories named after the config's `id` field, database row files where the filename encodes the primary key.

## Next time
Any writer that uses an ID to construct a path AND embeds that same ID inside the payload must assert equality before doing any I/O:

```ts
if (opts.taskId !== question.task_id) {
  throw new ForgeError('INVALID_ID', `taskId mismatch: path=${opts.taskId} payload=${question.task_id}`);
}
```

Make this the first line of the writer function. The check is O(1) and eliminates an entire class of silent data corruption that is very hard to debug after the fact.
