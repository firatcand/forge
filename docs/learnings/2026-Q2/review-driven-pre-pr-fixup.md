# Fix review findings before /ship, not after — especially security items
> 2026-05-21 · FORGE-89 · tags: [code-review, security, process, ship-gates, foundation]

## What we expected
Review findings surfaced after /implement but before /ship would be filed as follow-up issues to keep the PR lean.

## What happened
code-reviewer + security-auditor returned 7 items (5 code, 2 security). Bundling all fixes into one pre-ship cleanup commit took ~30 min and closed: a real DoS vector (unbounded diff piped to a model — fixed with `MAX_DIFF_BYTES` cap), a real secrets-leak vector (predictable `/tmp/forge-${TASK}-*.txt` path — fixed with `mktemp`), and a test fixture type-lie that would have silently rotted. Filing them as follow-ups would have left two security holes in a published npm package.

## Why
The marginal cost of fixing at this stage is near-zero — the implementer has full context and no merge has happened. Filing security findings as "follow-ups" means they sit in the backlog while the vulnerable version ships to npm.

## Next time
Default to bundling pre-ship over filing follow-ups for any finding tagged security or any type-lie in a test fixture. Reserve follow-up filing for items that are genuinely out of scope or require separate design work. The signal: if it can be fixed in the same session, fix it now.
