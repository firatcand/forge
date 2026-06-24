# Codex and code-reviewer look at different things — both are necessary
> 2026-05-11 · FD-7 · tags: [code-review, process, multi-model, foundation]

## What we expected
Ran code-reviewer on the FD-7 diff (zod schema for `.forge/settings.yaml`). It returned 0 blockers — types clean, tests adequate, conventions followed. Treated /codex as optional since the task didn't touch a CRITICAL.md path.

## What happened
Codex flagged that the schema was dead code in the published package: `src/index.ts` was still FD-6's `export {};` placeholder, so `dist/index.*` shipped empty and no consumer could `import { SettingsSchema } from '@firatcand/forge'`. The work passed every acceptance criterion but the public-API surface was unreachable. Second time in two foundation tasks Codex caught something code-reviewer cleared (FD-6 was the silent `--version` exit 0).

## Why
The two reviewers use non-substitutable lenses. code-reviewer examines the *diff against conventions* — does the code look right, are tests adequate, are types clean. Codex examines whether the *diff achieves the intent* — can users reach the new surface, is the integration complete, does the work do what the task said it should. A clean diff with a broken intent passes the first and fails the second.

## Next time
Always run /codex before /ship on foundation/public-API tasks even when the diff doesn't touch a CRITICAL.md path. Cost is ~$0.10; catch rate is now 2-for-2 on integration-completeness bugs that AC checklists and conventional review missed. Treat the two reviewers as complementary, not redundant.
