# Codex catches git env path-trust bugs
> 2026-05-18 · FORGE-105 · tags: [security, codex-second-opinion, path-trust]

## What we expected
`git rev-parse --git-common-dir` would resolve relative to cwd, treating cwd as authoritative for path-anchoring.

## What happened
Codex review flagged (F1, confidence 8) that git honors `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` env vars, redirecting common-dir lookup to an attacker-chosen repo. Anything trusting that result for path-anchoring inherits the trust gap. Real bug — fixed in 5 lines (sanitize env before invoking git).

## Why
It is intuitive to treat `cwd` + child-process call as a path-bounded operation. Git's environment-driven repository-discovery model is documented and respected even when cwd is set. Codex's separate context (no priming from this session) caught what an in-conversation reviewer might rationalize away.

## Next time
Any `git rev-parse` (or any git command) used for path-trust purposes must strip Git env vars first. Audit all `core/workspace.ts` execa calls for the same pattern.
