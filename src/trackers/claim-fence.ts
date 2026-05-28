// Forge claim-metadata fence (FORGE-145).
//
// A hidden HTML comment embedded in a tracker issue body that records which run
// currently holds the local lease, so `forge orchestrate gc` can answer
// "is this task claimed in the tracker, and by whom?" across hosts/machines.
//
// Public, adopter-visible convention — a single comment, invisible when the
// body is rendered:
//   <!-- forge:claim:{"claim_id":"...","generation":1,"owner_run_id":"..."} -->
//
// Authority note: this is ADVISORY metadata only. The authority for lease
// ownership is always the generation-fenced local lease (lease.json); gc never
// resurrects ownership from this fence.
//
// Concurrency note: tracker bodies expose no etag/CAS to our adapters, so
// writes are read-modify-write — callers read the LATEST body, then call
// `upsertClaimFence`, which preserves all non-fence content and replaces only
// the fence region. A residual race between two concurrent fence writers can
// still lose an update; in normal flow the claim state machine is the single
// logical writer (and `reconcile --push` is fence-preserving).

export interface ClaimFenceData {
  readonly claimId: string;
  readonly generation: number;
  readonly ownerRunId: string;
}

// Matches a single forge:claim comment. Non-greedy JSON capture; tolerant of
// surrounding whitespace inside the comment. Global flag used for strip().
const FENCE_RE = /<!--\s*forge:claim:(\{.*?\})\s*-->/;
const FENCE_RE_GLOBAL = /[ \t]*<!--\s*forge:claim:\{.*?\}\s*-->[ \t]*\n?/g;

// Parse the first valid claim fence from a body. Malformed JSON, missing/typed
// fields, or absent fence all return null ("no claim") — never throws. A
// hand-edited or corrupted fence is therefore treated as no-claim, not an error.
export function parseClaimFence(
  body: string | null | undefined,
): ClaimFenceData | null {
  if (!body) return null;
  const m = FENCE_RE.exec(body);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const claimId = o.claim_id;
  const generation = o.generation;
  const ownerRunId = o.owner_run_id;
  if (typeof claimId !== 'string' || claimId.length === 0) return null;
  if (
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 0
  ) {
    return null;
  }
  if (typeof ownerRunId !== 'string' || ownerRunId.length === 0) return null;
  return { claimId, generation, ownerRunId };
}

// Remove every claim fence (and its trailing newline) from a body, leaving all
// other content intact. Returns '' for empty/nullish input.
export function stripClaimFence(body: string | null | undefined): string {
  if (!body) return '';
  return body.replace(FENCE_RE_GLOBAL, '');
}

// Read-modify-write helper: given the LATEST body, strip any existing fence and
// append a fresh one on its own trailing line. Preserves all non-fence content.
export function upsertClaimFence(
  body: string | null | undefined,
  data: ClaimFenceData,
): string {
  const base = stripClaimFence(body).replace(/\s+$/, '');
  const fence = `<!-- forge:claim:${JSON.stringify({
    claim_id: data.claimId,
    generation: data.generation,
    owner_run_id: data.ownerRunId,
  })} -->`;
  return base.length > 0 ? `${base}\n\n${fence}\n` : `${fence}\n`;
}
