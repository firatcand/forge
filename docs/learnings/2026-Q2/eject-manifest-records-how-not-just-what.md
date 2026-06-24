# A reversible-uninstall manifest must record HOW forge wrote, not just WHAT

> 2026-05-30 · FORGE-158 · tags: [foundation, architecture, trade-off]

## What we expected
A list of forge-written paths would be enough for `forge eject` to reverse an
install ("delete what forge made").

## What happened
"Remove a forge file" ≠ "restore pre-install state". `applyGitignoreBlock`
inserts a separator newline OUTSIDE its markers, and two different priors
(`"X\n"` and `"X"`) collapse to byte-identical post-install files — so the
inverse is genuinely ambiguous from the post-state alone. Codex's plan review
caught it; the impl then needed per-write metadata.

## Why
Forge's writes are lossy at the boundary (append-with-separator, create-vs-stamp,
symlink-vs-copy). Byte-exact reversal needs the disambiguating bits captured at
write time, not re-derived later.

## Next time
For any reversible mutation, have the FORWARD op record what the INVERSE needs:
`created` (file existed before?), `priorEndedWithNewline`, exact appended line,
exact farm entry+mode. Co-locate the inverse with the writer. And: choosing the
"complete" manifest over a hardcoded list (user's Q2 fork) is what made the
Codex findings cheap to fix — the ledger was already the right shape.
