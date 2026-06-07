# Refactoring Audit Agent Prompt

> Purpose: a reusable prompt and rule set for asking Claude Code, Codex, or another coding agent to audit this repository for dead code, bloated code, unnecessary dependencies, duplicated logic, stale exports, and simplification opportunities without changing behavior. The agent must audit and propose first. Implementation happens only after explicit approval.

## Repo Context

- Repo: `@firatcand/forge`
- Stack: Node.js, TypeScript, ESM package, CLI/library distribution.
- Package manager: npm with `package-lock.json`.
- Build: `tsdown` emits ESM and CJS to `dist/`.
- Runtime support: Node `^22.18.0 || >=24.0.0`.
- Tests: Node built-in test runner through `tsx`.
- Lint: ESLint warnings surface unused variables and unreachable code but are intentionally non-blocking.
- CI surface: typecheck, lint, test helpers lint, tests, build, runtime smoke, pack test, gitleaks.

## Primary Prompt

Use this as the first message to the coding agent:

```markdown
You are auditing this repository for safe simplification. Do not edit code yet.

Goal: produce a repo-wide refactoring audit that identifies dead code, unused dependencies, duplicated logic, over-exported APIs, stale schemas/types, bloated implementations, and safe simplification opportunities while preserving all current features, public behavior, performance, security properties, package shape, and compatibility.

Hard constraints:
- Do not make code changes in this pass.
- Do not remove, rewrite, or merge anything unless you can prove it is behavior-preserving.
- Treat public CLI commands, package exports, installed templates, skills, agents, generated package contents, tracker adapters, schemas, migration paths, state files, and CI workflows as compatibility surfaces.
- Assume duplicated code may be intentional until proven otherwise.
- Preserve all security, atomic filesystem, concurrency, crash-recovery, schema-validation, and external-provider error-classification semantics.
- Prefer smaller, staged refactors over broad rewrites.
- Every recommendation must include evidence, risk level, validation gates, and rollback notes.
- If evidence is weak, mark the item as "investigate", not "safe".

Documentation and SOTA comparison:
- Before judging library-specific implementation details, fetch current docs with `ctx7`: first `npx ctx7@latest library <name> "<full question>"`, then `npx ctx7@latest docs <libraryId> "<full question>"`.
- For architecture or implementation comparison, inspect high-quality current docs and reputable open-source implementations only when they are directly relevant.
- Do not copy external code. Use external references to evaluate patterns, not to paste implementations.
- Record every external reference used and explain what it changes about the recommendation.

Repository investigation:
1. Read `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.github/workflows/*`, `README.md`, and existing `docs/audits/*`.
2. Map source directories, test directories, scripts, package files, templates, agents, skills, examples, and generated or ignored directories.
3. Build an export/import graph for `src`, tests, scripts, templates, and package entrypoints.
4. Identify runtime surfaces:
   - `bin` entries in `package.json`
   - package exports or public barrels
   - files included in the npm package
   - CLI commands and flags
   - templates, skills, agents, docs that users install or consume
   - schemas and state files used for persistence or interop
5. Identify validation gates from local scripts and CI.
6. Audit dead code and bloat in categories:
   - unused dependencies
   - unused source files
   - unused exports
   - unused types and schemas
   - stale re-exports
   - unreachable branches
   - duplicate helpers
   - repeated error-message or flag-parsing logic
   - test-only helpers that leaked into production
   - generated artifacts that should not be edited
   - docs/templates that refer to removed or renamed behavior
7. For each candidate, prove usage or non-usage with multiple signals:
   - static search with `rg`
   - import/export graph
   - package entrypoints
   - tests and fixtures
   - templates and docs
   - runtime string references
   - dynamic CLI behavior where relevant
8. Classify each candidate:
   - `delete-safe`: no live usage and no public contract
   - `de-export-safe`: used internally but exported unnecessarily
   - `simplify-safe`: behavior-preserving refactor with clear test coverage
   - `needs-tests-first`: likely improvement but coverage is insufficient
   - `risky`: touches public behavior, persistence, security, concurrency, or provider integration
   - `do-not-touch`: duplication or complexity appears intentional
9. Produce one Markdown audit file. Do not implement.

Required output file shape:
- Executive summary
- Repo and validation surface
- Protected surfaces
- Methodology
- Dead-code findings
- Dependency findings
- Simplification findings
- Performance findings
- Security findings
- Test coverage gaps
- Do-not-touch list
- Proposed implementation plan in small PR-sized batches
- Validation matrix
- Rollback plan
- Open questions

Quality bar:
- Every finding must cite file paths and line numbers.
- Every "safe" finding must explain why it is safe.
- Every proposed deletion must list all searches used to prove non-usage.
- Every proposed refactor must list tests to add or update before changing code.
- Do not optimize for LOC alone. Optimize for simpler behavior-preserving code.
- Prefer "no recommendation" over speculative cleanup.
```

## Implementation Prompt

Use this only after reviewing and approving specific audit items:

```markdown
Implement only the approved items from `<AUDIT_FILE>`.

Approved scope:
- `<paste exact section IDs here>`

Rules:
- Work in the smallest coherent batch.
- Do not touch unrelated files.
- Preserve public CLI behavior, package contents, schemas, state formats, template output, installed agent/skill behavior, security semantics, and concurrency semantics.
- Add or update tests before or with the change when behavior could regress.
- If an approved item becomes riskier than the audit claimed, stop and report instead of improvising.
- Keep generated `dist/` changes out of the patch unless release/package policy explicitly requires them.

Required validation:
- `npm run typecheck`
- `npm run lint`
- `npm run lint:test-helpers`
- `npm test`
- `npm run build`
- `node dist/bin/forge.cjs --version`
- `node dist/bin/forge.cjs --help`
- `npm run test:pack`

Final response:
- Summarize changed files.
- List approved items completed.
- List tests run and results.
- List anything deferred with reason.
```

## Protected Surfaces

Treat these as high-risk until proven otherwise:

- `package.json` `bin`, `files`, dependencies, engines, scripts, package name, and versioning behavior.
- `src/bin/*`, especially CLI command registration and flags.
- `src/index.ts` and any public barrels.
- `templates/`, `agents/`, `.claude/`, and installed skill/agent content.
- Tracker adapters for GitHub, Linear, and Notion.
- Orchestrator state, lease, question, answer, event, and verdict files.
- Atomic filesystem operations, lock/lease ownership checks, crash recovery, and idempotency logic.
- Schema definitions that validate persisted files or external API payloads.
- Error classification and retry behavior around external providers.
- CI workflows, packaging, smoke tests, and npm pack contents.
- Security-sensitive code: secrets, env parsing, redaction, path handling, command execution, and token handling.

Default stance: if a cleanup touches one of these, classify it as `risky` or `needs-tests-first` unless there is strong local test coverage and a narrow diff.

## Do-Not-Touch Defaults

These patterns often look bloated but should not be collapsed without specific evidence:

- Provider-specific error classifiers across GitHub, Linear, and Notion.
- Glob or path matching helpers with different boundary semantics.
- Atomic write flows that use different placement semantics: link-never-overwrite, rename-overwrite, unlink-link, or verify-after-write.
- Redundant-looking size caps around file reads when they defend against time-of-check/time-of-use races.
- Explicit secret redaction logic.
- Test seams that intentionally expose filesystem or subprocess behavior.
- Template text that appears duplicated because it targets different agent hosts.
- CJS/ESM entrypoint handling and built-artifact smoke coverage.

## Audit File Template

```markdown
# Repo-Wide Refactoring Audit

> Date:
> Branch:
> Commit:
> Auditor:
> Scope: audit only; no implementation

## Executive Summary

- Total findings:
- Safe deletions:
- Safe de-exports:
- Safe simplifications:
- Needs tests first:
- Risky or do-not-touch:
- Estimated LOC reduction:
- Primary risks:

## Repo And Validation Surface

Describe package entrypoints, CLI commands, installable assets, generated artifacts, tests, CI jobs, and runtime support.

## Methodology

List commands, graphing tools, searches, docs, SOTA references, and dynamic checks used.

## Protected Surfaces

List repo-specific files and contracts that must be preserved.

## Findings

### F1 - `<short title>`

- Classification: `delete-safe | de-export-safe | simplify-safe | needs-tests-first | risky | do-not-touch`
- Severity:
- Files:
- Evidence:
- Why this is safe or risky:
- Proposed change:
- Tests required:
- Validation commands:
- Rollback:

## Dependency Findings

For each dependency:

- Package:
- Direct or transitive:
- Current usage:
- Removal safety:
- Lockfile impact:
- Runtime/package impact:

## Performance Findings

Include only findings with a plausible measurable effect. Avoid claiming performance wins from style cleanup.

## Security Findings

Include simplifications that preserve or improve security. Flag changes that could weaken validation, redaction, path safety, command safety, or provider error handling.

## Test Coverage Gaps

List missing tests that block safe simplification.

## Do-Not-Touch List

List code that appears duplicated or complex but is intentionally divergent.

## Proposed Implementation Plan

### Batch 1 - Lowest-risk deletions

- Items:
- Files:
- Tests:
- Expected risk:

### Batch 2 - De-exports and internal cleanup

- Items:
- Files:
- Tests:
- Expected risk:

### Batch 3 - Helper extraction

- Items:
- Files:
- Tests:
- Expected risk:

### Deferred

- Items:
- Reason:
- Tests or research needed:

## Validation Matrix

| Gate | Command | Required before merge | Notes |
|---|---|---:|---|
| Typecheck | `npm run typecheck` | yes | |
| Lint | `npm run lint` | yes, warnings reviewed | lint is non-blocking in CI |
| Test helper lint | `npm run lint:test-helpers` | yes | |
| Unit/integration tests | `npm test` | yes | run outside restricted sandbox if IPC fails |
| Build | `npm run build` | yes | |
| CJS smoke version | `node dist/bin/forge.cjs --version` | yes | |
| CJS smoke help | `node dist/bin/forge.cjs --help` | yes | |
| Pack | `npm run test:pack` | yes | |
| Secrets | CI gitleaks | yes in CI | local run optional |

## Open Questions

- Question:
- Impact if unanswered:
- Recommended default:
```

## Recommended First Audit Passes

1. Public surface inventory: entrypoints, package files, templates, skills, agents, schemas, state files, and CI.
2. Dead-code inventory: unused dependencies, unused files, unused exports, stale schemas, and unreachable branches.
3. Duplication inventory: repeated helpers, flag parsing, error-message extraction, retry helpers, path helpers, and schema fragments.
4. Risk pass: mark anything touching persistence, concurrency, security, external APIs, or package output as protected.
5. Test-gap pass: identify which simplifications require failing-first tests before implementation.
6. Batch plan: group only low-coupling changes together.

## Recommended Agent Rules

- Audit first, patch later.
- Prefer evidence over confidence.
- Never infer unused status from TypeScript alone.
- Search source, tests, scripts, docs, templates, package metadata, and generated install assets.
- Treat non-blocking lint findings as signals, not proof.
- Do not simplify across intentionally different semantics.
- Do not remove dependencies until source, tests, scripts, templates, and package runtime all prove no usage.
- Do not claim performance improvements without a concrete mechanism.
- Do not touch generated `dist/` during audit.
- Stop when a recommendation depends on product intent the repo cannot reveal.
