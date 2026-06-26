// FORGE-227: strict flag-value parsing for the loom query/traverse verbs.
//
// The shared `parseFlag` (src/cli/orchestrate/flags.ts) returns the NEXT token
// for `--flag value`, even when that token is itself another flag — so
// `forge loom traverse --node --json` would silently bind node="--json". These
// helpers reject a missing, empty, or flag-like value (and `--flag=` with no
// value), returning an Error the dispatcher turns into INVALID_ARGS.

// undefined = flag absent · string = value · Error = present but invalid value.
export function parseValuedFlag(
  args: readonly string[],
  long: string,
): string | undefined | Error {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === `--${long}`) {
      const v = args[i + 1];
      if (v === undefined || v.length === 0 || v.startsWith('--')) {
        return new Error(`--${long} requires a value`);
      }
      return v;
    }
    if (a.startsWith(`--${long}=`)) {
      const v = a.slice(long.length + 3);
      if (v.length === 0) return new Error(`--${long} requires a non-empty value`);
      // Reject a flag-like value in equals form too (`--node=--json`): no node id /
      // kind / limit legitimately starts with `--`, and accepting it silently is
      // the same footgun as the separated form.
      if (v.startsWith('--')) return new Error(`--${long} requires a value (got flag-like '${v}')`);
      return v;
    }
  }
  return undefined;
}

// undefined = flag absent · number = positive int · Error = present but not a
// positive integer. Mirrors the recall --limit parser (fail loud, no fallback).
export function parsePositiveInt(
  args: readonly string[],
  long: string,
): number | undefined | Error {
  const raw = parseValuedFlag(args, long);
  if (raw === undefined) return undefined;
  if (raw instanceof Error) return raw;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return new Error(`--${long} must be a positive integer (got '${raw}')`);
  }
  return n;
}
