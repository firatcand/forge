---
name: second-opinion
description: Get a second opinion on a plan, diff, or specific files from Codex or Gemini (whichever is configured as `settings.agents.review_host_cli`). The reviewer reads the working tree directly, so it can reason about both the proposed change AND surrounding production code (dependency graph, sibling adapters, recently-merged PRs). Required for changes touching CRITICAL.md paths.
tools: Bash(forge*), Bash(git*), Read, Edit, Write
---

# /second-opinion

## Preconditions

- `.forge/settings.yaml` exists and `agents.review_host_cli` is set to `codex` or `gemini` (not `null`, not `claude`).
- The configured reviewer CLI is installed (`which codex` / `which gemini`).
- **Working tree is rebased onto current `main`.** The reviewer reads files from disk; if the worktree is stale, the reviewer reasons about old code and may miss recently-merged dependencies (sibling adapters, new abstractions, refactored APIs). Always `git fetch origin main && git rebase origin/main` in the worktree before invoking.
- For framework projects using gitignored project meta (e.g., `spec/`, `plans/`, `docs/learnings/`): re-hydrate them in the worktree after rebase so the reviewer sees the canonical source-of-truth, not just the tracked source files.

## Why a second opinion (not just an in-CC agent)

The reviewer runs in a separate process with its own context, its own model, and its own training cutoff. It has no memory of this conversation. That makes it an honest second opinion: it can't be primed by what you've already concluded, and it'll catch type errors / mirror-faithfulness bugs that an agent inheriting context will rationalize away.

Two things to leverage:

- **Codebase reasoning.** The reviewer reads the working tree on demand (`rg`, `sed`, file reads). It can trace a tracker's dependency on a sibling adapter, check a refactor against recently-merged PRs, verify a plan's pseudocode against the actual type signatures it claims to mirror.
- **Plan + code together.** The strongest reviews compare a written plan against the production code it will modify. Brief the reviewer on both — point to the plan file AND the source files it touches AND the sibling/precedent files it mirrors.

## Invocation (via `forge orchestrate second-opinion`)

The skill never spawns `codex exec` or `gemini` directly. Dispatch goes through the CLI verb, which is the sole boundary that knows about `settings.agents.review_host_cli` (codex vs gemini). The verb internally calls `IHarness.runReview` on the chosen adapter; `spawnSubprocess` inside the adapter already sets `stdin: 'ignore'` (FORGE-135), so the stdin-hang failure mode that bit `/codex` in v0.3.x can't recur.

### Standard pattern

1. Build the diff (`git diff origin/main...HEAD` or a narrower range).
2. Build a six-piece review prompt (see below).
3. Write both to temp files, call the verb, parse the envelope.

```bash
TASK=FORGE-XX   # current task ID
# mktemp generates unguessable filenames (mode 0600 by default on macOS/Linux)
# so the diff/prompt content isn't readable by other local users while the
# review runs. Skip /tmp/forge-${TASK}-*.txt — that's a predictable name that
# any local process can race for.
DIFF=$(mktemp -t "forge-${TASK}-diff.XXXXXXXXXX")
PROMPT=$(mktemp -t "forge-${TASK}-prompt.XXXXXXXXXX")
VERDICT=$(mktemp -t "forge-${TASK}-verdict.XXXXXXXXXX")

git diff origin/main...HEAD > "$DIFF"

cat > "$PROMPT" <<'EOF'
<six-piece prompt body — see "Prompt construction" below>
EOF

forge orchestrate second-opinion \
  --task "$TASK" \
  --diff "$DIFF" \
  --prompt "$PROMPT" \
  --json \
  > "$VERDICT"

# Clean up after reading the verdict — diff/prompt may contain committed
# secrets or local file paths you don't want sitting in /tmp.
rm -f "$DIFF" "$PROMPT" "$VERDICT"
```

The verb emits a JSON envelope on stdout:

```json
{
  "ok": true,
  "data": {
    "host": "codex",
    "task_id": "FORGE-XX",
    "attempt_id": "<uuidv7>",
    "verdict": {
      "version": 1,
      "verdict": "pass" | "changes_requested",
      "findings": [{ "severity": "block" | "improvement", "path": "...", "line": 1, "message": "..." }],
      "host": "codex" | "gemini"
    }
  }
}
```

Common error envelopes (`ok: false`): `REVIEW_DISABLED` (`review_host_cli: null`), `SETTINGS_NOT_FOUND`, `INVALID_SETTINGS`, `MISSING_INPUT`, `BINARY_NOT_FOUND`, `TIMEOUT`, `INVALID_STDOUT`, `REVIEW_FAILED`. The `code` field is stable across reviewers.

## Prompt construction (what produces useful reviews)

A good prompt is a self-contained brief. Six pieces:

1. **Context.** What the project is. What changed recently (sibling PRs, refactors). Where to read files from — give absolute paths.
2. **Prior-round summary** (if it's a follow-up). What the reviewer already flagged. What you addressed. So it doesn't re-raise resolved findings.
3. **The artifact under review.** Absolute path to the plan file, diff, or source file. Tell the reviewer to read it.
4. **Reading list.** Specific files the reviewer should read to ground its review — the source files the plan touches, the sibling/precedent code it claims to mirror, the spec section it's bound by.
5. **Specific attack vectors.** Not "is this good?" — concrete questions. "Is the mirror faithful?" "What stale-state risks does this introduce?" "Walk through the type signatures and check the pseudocode actually compiles." Each one a separate numbered question.
6. **Force confidence ratings + word cap + structured verdict.** "Confidence 1-10 on each finding. Under 600 words. Be direct. End with a fenced ```json block matching this shape: ..." (paste the ReviewVerdict schema). Without this the reviewer hedges and pads, and the verb cannot parse a structured verdict.

The prior-round summary is what makes follow-up reviews land — the reviewer is honest that it doesn't remember the first round, but you can replay the key findings and resolutions so it focuses on new ground.

## Evaluation discipline

Not every finding is right. After reading the verdict:

- **Type / code bugs** (the `.includes()`-on-object-array kind) → almost always real. Act.
- **Concurrency / race / ID-cache-coherence** → usually real and easy to miss. Act unless you can prove the constraint that prevents it.
- **Architectural concerns** → evaluate against project context. Sometimes there's a sibling-ticket precedent that resolves it (e.g., "deferred to FORGE-22"). Cite the resolution in your reply.
- **Scope / "you should also do X"** → defer unless it's actually blocking. Add to a follow-up ticket rather than ballooning the current task.
- **Style** → ignore unless it affects correctness or readability of the artifact.

When updating an artifact in response to a finding, cite the source explicitly ("Codex 2nd-pass: …" or "Gemini 2nd-pass: …") so the reasoning is traceable in git history.

## When to use

- **Required:** any change touching paths in `CRITICAL.md`
- **Required:** architecture decisions, new abstractions, schema changes, claim/lease/CAS logic
- **Strongly recommended:** plans for tasks marked P0, anything cross-cutting trackers/adapters/state-machine
- **Optional but valuable:** any time you want an outside engineer to verify your reasoning

## Integration with /ship and /review

- `/ship` runs `/second-opinion review-impl` automatically if the diff touches CRITICAL.md paths. Findings with `severity: block` halt PR creation until resolved or explicitly deferred.
- `/review` runs `/second-opinion review-impl` when the diff touches CRITICAL.md paths AND `settings.agents.review_host_cli !== null`. The verdict is folded into the same severity bucketing as the in-process subagents.

## Output

A `ReviewVerdict` JSON envelope at the path the caller redirected to (the verb writes the envelope to stdout). Pull `findings[*]` with `severity: block` into the main conversation; keep `improvement` findings in the file for reference.
