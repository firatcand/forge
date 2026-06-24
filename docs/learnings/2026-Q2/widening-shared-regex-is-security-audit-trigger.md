# Widening a shared regex's input domain triggers a security audit of every consumer

> 2026-05-13 · FORGE-16 · tags: [security, regex, shared-helpers, defense-in-depth, refactoring, dry-cost]

## What we expected
Extracting `parseForgeFooters` / `serializeWithForgeFooters` from `github.ts` into a shared `footers.ts` for both `LinearTracker` and `GitHubTracker` to use was a straightforward DRY refactor. Widening the blocker-ID capture from `[\d,\s]*` (GitHub numeric IDs) to `[^>]*?` (so it accepts Linear UUIDs and identifiers like `FORGE-42`) felt like a no-brainer hygiene tweak. Adapter-side write-time validation (`/^\d+$/.test(blockerId)` for GitHub) was assumed to be sufficient defense.

## What happened
Security-auditor flagged that the widening opened an HTML-comment-injection vector. `serializeWithForgeFooters` concatenates caller-supplied values (`forgeTaskId`, `blockerIds[*]`, `ownerType`) directly into `<!-- forge:X=Y -->` comment strings with no metacharacter validation. A value containing `-->` terminates the comment and corrupts the footer round-trip. `assertNonEmpty` only checks for empty strings — it doesn't reject `-->` or `<!--`. GitHub's adapter-side numeric-only validation incidentally blocked this, but the new shared regex now flows through Linear, whose blocker IDs are arbitrary strings, and the per-adapter validation lock was lost in the extraction. Required two new validators in `footers.ts` (`assertFooterValueSafe` for bare values, `assertExtraFooterSafe` for pre-formed `<!-- ... -->` wrappers) plus regression tests against `forgeTaskId: "P2 --> <script>"` and `blockerId: "evil --> injection"`.

## Why
Shared helpers carry the **union of all consumers' input domains**, not any single consumer's. Adapter-local validation that incidentally blocked an attack on one adapter doesn't transfer when the helper is shared. Widening the regex without revisiting validators meant the adapter that wrote the original safety check (GitHub's numeric guard) no longer shielded the new adapter (Linear, where blocker IDs are UUIDs / human identifiers). This is the inverse of the DRY-cost-is-cheap argument: extracting *code* is cheap, but extracting *trust* requires re-auditing each consumer's input domain at the new boundary.

## Next time
When extracting a helper that touches strings flowing into a structured output format (HTML comments, JSON, SQL, shell args, log lines, URL components) — and **especially** when widening the helper's accepted input domain to accommodate a new consumer — treat it as a security-audit trigger:

1. List every input field the helper receives.
2. For each, identify the metacharacter set that could break the output format (`-->` and `<!--` for HTML comments; `"` and `\` for JSON strings; `;` and `--` for SQL; etc.).
3. Move the metacharacter check into the helper itself, not back into each adapter — that's what the extraction was for.

Generalizable cue: any diff that includes "widen regex" or "accept more input" in the helper-extraction commit message warrants a security-auditor pass before merge. Apply the same lens to FORGE-17 (Notion) when `forge_claimed_by` and footers cross another adapter.
