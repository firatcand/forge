---
name: investigate
description: Iron Law of Investigation — required before /fix. Trace data flow, test hypotheses, identify root cause.
tools: Read, Bash(*)
---

# /investigate

## Process

1. Reproduce the bug — write the minimal repro steps
2. Identify the data flow involved
3. Form hypothesis: "I think the bug is caused by X because Y"
4. Test the hypothesis — instrument code, check logs, run debugger
5. Either confirm or rule out; if ruled out, form next hypothesis
6. Document the root cause: "Root cause: X. Evidence: Y. Affected paths: Z"

## Output

Write `plans/tasks/{LINEAR-ID}.investigation.md` with:
- Repro steps
- Hypotheses tested
- Root cause identified
- Proposed fix approach (high-level)

This file is required by /fix.
