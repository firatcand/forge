# Reviewer claims need verification against actual code
> 2026-05-18 · FORGE-99 · tags: [code-review, ai-tools, multi-reviewer]

## What we expected
The code-reviewer subagent flagged bare `catch {}` blocks in `drift.ts` as violating CLAUDE.md's "always handle errors explicitly" rule, citing `guardrail-check.ts` and `claim.ts` as sibling files with bound catches (`catch (err) { if (err.code !== 'ENOENT')...}`). Expected: applying the fix would align with repo idiom.

## What happened
Grepping the repo showed bare `catch {}` is pervasive: 5 instances in `guardrail-check.ts` alone (the sibling the reviewer cited as a "good example"), 3 each in cancel/attach/question-write, and a bare catch with an intent comment in `claim.ts:140`. The reviewer's premise was factually wrong. Applying the suggested fix would have diverged from repo idiom, not aligned with it. The same reviewer also correctly caught a real idiom mismatch (regex path resolver vs `path.dirname` sibling pattern) — noise and signal were mixed.

## Why
CLAUDE.md states a principle ("no silent catches"). The repo's de facto interpretation is "no silent undocumented catches" — comments revealing intent count. Reviewers (human or AI) can read principles literally without checking how the codebase has resolved them in practice.

## Next time
Before applying a reviewer-suggested idiom/convention change, grep the codebase to verify the claimed sibling pattern actually holds. AI reviewers are inputs to thinking, not answers — this applies equally to cold-context reviewers (Codex) and in-context reviewers (sonnet code-reviewer). See also: [[re-derive-why-before-accepting-second-opinion-polish]] — same principle applied to option framing; both cases require first-principles grounding before accepting a reviewer's frame.
