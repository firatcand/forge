// Forge claim-metadata value schema (FORGE-145).
//
// The claim identity (which run holds the local lease) is mirrored onto the
// tracker issue as a forge FOOTER: `<!-- forge:claim=<json> -->` — see
// src/trackers/footers.ts for the comment placement + body read-modify-write,
// which rides the same machinery as forge:task / forge:blockedBy (so it is
// auto-preserved across body rewrites + `reconcile --push`).
//
// This module owns only the VALUE schema — the JSON payload inside the footer:
// encode + decode/validate. Keys mirror lease.json (claim_id / generation /
// owner_run_id) so the value maps directly to a lease identity.
//
// Authority note: advisory metadata only. The authority for lease ownership is
// always the generation-fenced local lease; gc never resurrects ownership from
// this footer.

export interface ClaimFenceData {
  readonly claimId: string;
  readonly generation: number;
  readonly ownerRunId: string;
}

// Serialize to the footer value (compact JSON). The output never contains HTML
// comment metacharacters (`-->` / `<!--`), so it is safe inside a footer.
export function encodeClaimValue(data: ClaimFenceData): string {
  return JSON.stringify({
    claim_id: data.claimId,
    generation: data.generation,
    owner_run_id: data.ownerRunId,
  });
}

// Parse + validate a footer value. Malformed JSON, missing/wrong-typed fields,
// or nullish input all return null ("no claim") — never throws. A hand-edited
// or corrupted value is therefore treated as no-claim, not an error.
export function decodeClaimValue(
  raw: string | null | undefined,
): ClaimFenceData | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
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
