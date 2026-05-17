import type { Source } from '../schemas/phases.ts';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SPEC_REVISION_DISPLAY_LEN = 7;

const MS_PER_MIN = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function formatRelativeAge(ageMs: number): string {
  if (ageMs < 0) return 'in the future';
  if (ageMs < MS_PER_MIN) return 'just now';
  if (ageMs < MS_PER_HOUR) return `${Math.floor(ageMs / MS_PER_MIN)}min`;
  if (ageMs < MS_PER_DAY) return `${Math.floor(ageMs / MS_PER_HOUR)}h`;
  return `${Math.floor(ageMs / MS_PER_DAY)}d`;
}

export function computeFreshnessLine(
  source: Source | undefined,
  now: Date = new Date(),
): string {
  if (!source) {
    return 'phases.yaml: no source metadata (run forge orchestrate reconcile --pull to sync)';
  }

  const syncedAtMs = Date.parse(source.synced_at);
  // Date.parse returns NaN for unparseable input. The schema validates ISO-8601
  // at the boundary, so this is defensive — a malformed value here means the
  // file was hand-edited past the parser.
  if (Number.isNaN(syncedAtMs)) {
    return `phases.yaml: source.synced_at is unparseable (${source.synced_at})`;
  }

  const ageMs = now.getTime() - syncedAtMs;
  const stale = ageMs > STALE_THRESHOLD_MS;
  const prefix = stale ? '⚠ STALE — ' : '';
  const age = formatRelativeAge(ageMs);
  const specDigest = source.spec_revision.slice(0, SPEC_REVISION_DISPLAY_LEN);
  return `phases.yaml: ${prefix}synced ${age} ago from ${source.tracker} (SPEC@${specDigest})`;
}
