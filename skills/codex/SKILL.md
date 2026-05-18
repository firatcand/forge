---
name: codex
description: Get a second opinion from Codex CLI on a plan, diff, or specific files. Codex reads the working tree directly, so it can reason about both the proposed change AND the surrounding production code (dependency graph, sibling adapters, recently-merged PRs). Required for changes touching CRITICAL.md paths.
tools: Bash(codex*), Bash(git*), Bash(ps*), Bash(kill*), Read, Edit, Write
---

# /codex

## Preconditions

- Codex CLI installed (`which codex`) — verified for codex-cli 0.129.0+
- Active Codex membership (Codex CLI handles auth)
- **Working tree is rebased onto current `main`.** Codex reads files from disk; if the worktree is stale, Codex reasons about old code and may miss recently-merged dependencies (sibling adapters, new abstractions, refactored APIs). Always `git fetch origin main && git rebase origin/main` in the worktree before invoking Codex.
- For framework projects using gitignored project meta (e.g., `spec/`, `plans/`, `docs/learnings/`): re-hydrate them in the worktree after rebase so Codex sees the canonical source-of-truth, not just the tracked source files.

## Why Codex (not just an in-CC agent)

Codex runs in a separate process with its own context, its own model, and its own training cutoff. It has no memory of this conversation. That makes it an honest second opinion: it can't be primed by what you've already concluded, and it'll catch type errors / mirror-faithfulness bugs that an agent inheriting context will rationalize away.

Two things to leverage:
- **Codebase reasoning.** Codex reads the working tree on demand (`rg`, `sed`, file reads). It can trace a tracker's dependency on a sibling adapter, check a refactor against recently-merged PRs, verify a plan's pseudocode against the actual type signatures it claims to mirror.
- **Plan + code together.** The strongest reviews compare a written plan against the production code it will modify. Brief Codex on both — point to the plan file AND the source files it touches AND the sibling/precedent files it mirrors.

## Invocation (codex-cli 0.129.0)

The real CLI surface (subcommand-based, no `--adversarial` or `consult` flags):

```bash
codex exec [PROMPT]              # non-interactive run; prompt as arg or via stdin
codex exec --color never [PROMPT]  # no ANSI codes (cleaner for file output)
codex exec review                # interactive code review (rarely needed)
codex review                     # top-level review subcommand
codex resume                     # resume previous session
codex --help                     # list current subcommands (the surface changes)
```

**Required: redirect stdin from `/dev/null`.** `codex exec` (verified on 0.130.0; per the `exec --help` text: *"If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block"*) performs a blocking stdin read before processing the prompt argument. Any caller that leaves stdin open hangs indefinitely at 0% CPU after printing `Reading additional input from stdin...`. Always pass `</dev/null` in shell or `stdin: 'ignore'` in a Node spawn. See `plans/tasks/FORGE-88.investigation.md` for the diagnosis. The reproduced hang was stdin-rooted; no separate hang specific to `--skip-git-repo-check` / `--sandbox read-only` was confirmed in this round, so the prior warning here was misleading more than it was actively wrong. If you observe a new 0% CPU hang with stdin already closed, log a fresh investigation rather than blaming this commit.

## Standard pattern (background + file redirect)

```bash
cd /path/to/worktree && codex exec --color never "$(cat <<'EOF'
<prompt body>
EOF
)" </dev/null > /tmp/codex-<task-id>-review.txt 2>&1 &
echo "Started codex PID $!"
disown
```

Then wait without polling:

```bash
until ! ps -p <PID> > /dev/null 2>&1; do sleep 5; done
echo "codex done"
```

Run the `until` loop with `run_in_background: true` so the harness notifies on completion. Do NOT pipe the foreground codex call through `tail -N` — that buffers everything until codex exits and produces zero visible progress. Always redirect to a file and tail the file after completion.

## Prompt construction (what produces useful reviews)

A good Codex prompt is a self-contained brief. Six pieces:

1. **Context.** What the project is. What changed recently (sibling PRs, refactors). Where to read files from — give absolute paths.
2. **Prior-round summary** (if it's a follow-up). What Codex already flagged. What you addressed. So it doesn't re-raise resolved findings.
3. **The artifact under review.** Absolute path to the plan file, diff, or source file. Tell Codex to read it.
4. **Reading list.** Specific files Codex should read to ground its review — the source files the plan touches, the sibling/precedent code it claims to mirror, the spec section it's bound by.
5. **Specific attack vectors.** Not "is this good?" — concrete questions. "Is the mirror faithful?" "What stale-state risks does this introduce?" "Walk through the type signatures and check the pseudocode actually compiles." Each one a separate numbered question.
6. **Force confidence ratings + word cap.** "Confidence 1-10 on each finding. Under 600 words. Be direct." Without this Codex hedges and pads.

The prior-round summary is what makes follow-up reviews land — Codex is honest that it doesn't remember the first round, but you can replay the key findings and resolutions so it focuses on new ground.

## Evaluation discipline

Not every Codex finding is right. After reading the output:

- **Type / code bugs** (the `.includes()`-on-object-array kind) → almost always real. Act.
- **Concurrency / race / ID-cache-coherence** → usually real and easy to miss. Act unless you can prove the constraint that prevents it.
- **Architectural concerns** → evaluate against project context. Sometimes there's a sibling-ticket precedent that resolves it (e.g., "deferred to FORGE-22"). Cite the resolution in your reply.
- **Scope / "you should also do X"** → defer unless it's actually blocking. Add to a follow-up ticket rather than ballooning the current task.
- **Style** → ignore unless it affects correctness or readability of the artifact.

When updating an artifact in response to Codex, cite the source explicitly ("Codex 2nd-pass: …") so the reasoning is traceable in git history.

## When to use

- **Required:** any change touching paths in `CRITICAL.md`
- **Required:** architecture decisions, new abstractions, schema changes, claim/lease/CAS logic
- **Strongly recommended:** plans for tasks marked P0, anything cross-cutting trackers/adapters/state-machine
- **Optional but valuable:** any time you want an outside engineer to verify your reasoning

## Integration with /ship

If `/ship` detects the diff touches CRITICAL.md paths, it runs Codex automatically. Critical findings (confidence ≥ 8) block PR creation until resolved or explicitly deferred.

## Output

A markdown summary written to `/tmp/codex-<task-id>-review.txt`. Findings should be ranked by confidence and tagged by severity. Pull the high-confidence findings into the main conversation; keep low-confidence ones in the file for reference.
