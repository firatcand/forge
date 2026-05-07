---
name: review
description: Run code-reviewer, security-auditor (if CRITICAL.md path touched), and design-reviewer (if UI task) on current diff.
tools: Read, Bash(git*)
---

# /review

## Process

1. Run `git diff dev...HEAD` to get current diff
2. Always invoke `code-reviewer` subagent
3. If diff touches paths in CRITICAL.md, invoke `security-auditor`
4. If task type is "design" or "frontend", invoke `design-reviewer`
5. Aggregate findings; categorize by severity (block / improvement / nit)
6. Print summary; ask user to address blocks before /ship

## Output

Markdown summary of findings per reviewer, with file:line references.
