---
name: codex
description: Get a second opinion from Codex CLI on the current diff or specific files. Required for changes touching CRITICAL.md paths.
tools: Bash(codex*), Bash(git*), Read
---

# /codex

## Preconditions

- Codex CLI installed (`which codex`)
- Active Codex membership (handled by Codex CLI's own auth)

## Modes

### review (default)

```bash
git diff HEAD | codex --stdin
```

### adversarial

```bash
codex --adversarial --diff
```

Prompts Codex to actively try to find ways to break the code.

### consult

```bash
codex consult --file [path]
```

Open a session with Codex on a specific file or topic.

## When to use

- Always for files matching paths in CRITICAL.md
- Architecture decisions
- Anything where you'd want a second engineer to look at it

## Integration with /ship

If `/ship` detects the diff touches CRITICAL.md paths, it runs `/codex review` automatically and blocks PR creation if critical findings.

## Output

Codex CLI's review output, formatted for readability. Findings categorized by severity.
