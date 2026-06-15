# Audit principles — read-only safe-simplification guardrails

> Injected verbatim into every audit subagent prompt. These are GENERIC to any
> codebase. They describe protected surfaces as CLASSES, never as concrete paths.

## Prime directive

**Same features. Same observable behavior. Fewer lines.** When equivalence is
uncertain, do NOT propose the change — a non-recommendation is free; a silent
behavior change is not. You are AUDITING, not editing: analyze and propose only.

## Read-only mandate

- Do NOT edit, create, move, rename, or delete any file.
- Do NOT run commands that mutate the working tree or external state.
- Your deliverable is a list of findings. Nothing else.

## Classification rubric (assign exactly one)

- **delete-safe** — no live usage and no public contract. REQUIRES **≥2
  independent signals** of non-usage (e.g. text search across source + tests +
  scripts + docs + templates, the import graph, dynamic/registry dispatch keys,
  package entrypoints). Never infer "unused" from a type-checker or a single
  tool alone.
- **de-export-safe** — used internally but exported unnecessarily; an importer
  search shows no external consumer.
- **simplify-safe** — behavior-preserving refactor WITH existing pinning test
  coverage.
- **needs-tests-first** — likely improvement, but coverage is insufficient;
  characterization tests must come before any edit.
- **risky** — touches public behavior, persistence, security, concurrency, or a
  provider/external integration.
- **do-not-touch** — the duplication or complexity is intentional; leave it and
  record why.

Default when evidence is weak: **needs-tests-first** or **risky**, never
delete-safe / simplify-safe.

## Protected-surface CLASSES (treat as risky until proven otherwise)

Do NOT propose changes to code that falls into any of these classes, regardless
of how it looks:

- **Public entrypoints & barrels** — CLI command/flag registration, package
  bin/exports, and re-export barrels that form the consumable API.
- **Persisted-file & external-API schemas** — validators for on-disk files or
  payloads exchanged with external services (changing them breaks compat).
- **Tracker / provider adapters** — per-provider error classifiers and retry
  behavior map genuinely different surfaces; branch order is load-bearing.
- **Orchestrator state / lease / question files** — atomic-write placement,
  lock/lease ownership checks, crash-recovery, and idempotency logic.
- **Security / path / secret / command-execution code** — argv/env allowlists,
  secret redaction, path-containment guards, subprocess env handling, token
  handling.
- **CI / packaging** — build configuration, workflow files, smoke tests, and the
  published-package payload.

## Look-alikes that are intentionally divergent (do NOT collapse)

- Path/glob matchers with different boundary semantics.
- Atomic-write flows with different placement semantics (link-never-overwrite vs
  rename-overwrite vs unlink-then-link vs verify-after-write).
- Provider-specific error classifiers.
- Redundant-looking size caps that defend against time-of-check/time-of-use races.
- Template text duplicated because it targets different host integrations.

## Every finding must carry

- A repo-relative `file` path (and `line` when applicable). NEVER an absolute
  path; NEVER a `../` traversal — findings outside scope or protected surfaces
  are discarded.
- `evidence` — the concrete observation (searches run, consumers found/absent).
- `why_safe` — why the proposed change preserves behavior.
- `proposed_change` — the smallest coherent edit.
- `blast_radius` — every consumer the change would touch.
- `tests_required` — for any change that could regress, the tests to add first.

## Audit + gate are a pair

An audit finding is a HYPOTHESIS, not a fact. Without a verification gate (the
adopter's own test/build commands) a finding is UNVERIFIABLE. Treat every
finding as something to prove with a gate before any human acts on it.
