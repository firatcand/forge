# Re-derive the WHY before accepting a multi-model second opinion's polish
> 2026-05-18 · FORGE-113 · tags: [process, multi-model-review, architecture, yagni]

## What we expected
Codex would return the best choice from the option set we gave it (how to compute `tracker_revision`), and we'd ship whichever it ranked highest.

## What happened
Codex delivered a sharp, well-grounded recommendation — refined Option A' (canonical projection hash) with concrete sleeper-bug fixes. Excellent within the frame. The user pushed back: "you didn't answer why we're building this." Re-deriving from first principles surfaced a 4th option the prompt never offered: drop the field entirely. `tracker_revision` would have been either a forensic ID with no v0.4 consumer (YAGNI) or a real cheap-drift-detector requiring per-adapter methods (deferred). The "honest staleness" promise was already fully carried by `synced_at` + the freshness display line.

## Why
Second-opinion tools optimise within the frame you give them. They cannot question whether the option set is the right frame — that requires re-deriving intent from first principles.

## Next time
Before accepting any second-opinion recommendation, ask: "Is this the right option set, or just the best answer to the question I asked?" Force a first-principles re-derivation of the WHY. The 4th option (drop / defer / eliminate) only surfaces from that exercise, not from ranking within the existing list. See also: [[strict-schema-as-deliberate-exclusion-guard]] — the field drop had a schema consequence.
