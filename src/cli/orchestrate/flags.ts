// Flag parsing helpers shared by every verb in src/cli/orchestrate/.
//
// Supports two surface forms:
//   --flag value       (separated)
//   --flag=value       (equals)
//
// All helpers operate on the slice AFTER the verb token. Positionals are anything
// not starting with `--` (and not consumed as the value of a separated flag).

export function parseFlag(rest: readonly string[], long: string): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a === `--${long}`) {
      return rest[i + 1];
    }
    if (a.startsWith(`--${long}=`)) {
      return a.slice(long.length + 3);
    }
  }
  return undefined;
}

export function hasFlag(rest: readonly string[], long: string): boolean {
  for (const a of rest) {
    if (a === `--${long}` || a.startsWith(`--${long}=`)) return true;
  }
  return false;
}

export function firstPositional(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      if (!a.includes('=') && i + 1 < rest.length && !rest[i + 1]?.startsWith('--')) {
        i += 1;
      }
      continue;
    }
    return a;
  }
  return undefined;
}

// Resolve --forge-dir flag with a sensible default rooted at the caller's cwd.
export function resolveForgeDir(rest: readonly string[], cwd: string): string {
  return parseFlag(rest, 'forge-dir') ?? `${cwd}/.forge`;
}
