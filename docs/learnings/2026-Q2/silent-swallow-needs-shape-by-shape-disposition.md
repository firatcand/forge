# Silent error-swallow requires per-shape disposition, not per-code swallow
> 2026-05-16 · FORGE-82 · tags: [testing, integration, trackers, gh-cli, external-api, error-classification]

## What we expected
`ensureLabelExists` swallowing HTTP 422 was a deliberate design: "label already exists" is the only realistic 422, so swallowing it lets `gh issue edit --add-label` auto-create the label if needed. `claim()` always returns a `ClaimResult`, never throws.

## What happened
A second 422 source appeared — GitHub's 50-char label-name cap. `ensureLabelExists` swallowed it identically. The downstream `gh issue edit --add-label` then failed with stderr `'forge:claimed-by:<uuid>' not found / failed to update 1 issue`. `classifyGitHubError` had no pattern for that stderr shape, returned `UNKNOWN`, and `claim()` threw — violating its own spec contract.

## Why
The swallow decision was made when only one 422 shape existed. Adding a new 422 source without extending the classifier turned a "benign swallow" into a "swallow + silent contract violation." Coarse error codes (HTTP 422, generic CLI exit 1, `ENOENT`) can carry multiple distinct semantics; swallowing at the code level without enumerating shapes is a latent contract-breaker waiting for a new code path.

## Next time
When you intentionally swallow a coarse error code, document in code the exhaustive list of stderr/message shapes that justify the swallow. When adding a new code path that can produce the same code, extend the classifier first — not after. See also [codex-caught-silent-no-op-placeholder.md](codex-caught-silent-no-op-placeholder.md) and [toctou-between-stat-and-read-leaks-raw-fs-errors.md](toctou-between-stat-and-read-leaks-raw-fs-errors.md) for related patterns where "handles it" turned out to mean "handles one case."
