# Spec "placeholder OK" doesn't excuse silent-no-op behavior
> 2026-05-10 · FD-6 · tags: [code-review, spec-interpretation, anti-pattern, gotcha]

## What we expected
Task spec said `src/bin/forge.ts` could be a placeholder that handles `--version`. Wrote: if `--version`, print and exit; else fall through (do nothing, exit 0). All 4 acceptance criteria passed.

## What happened
Codex review (P2) flagged it: any non-`--version` invocation silently exits 0 with no output, behaving as a "broken CLI artifact." Spec literalism was satisfied but behavior was a real anti-pattern that would confuse anyone who pokes the file directly.

## Why
"Placeholder OK" specifies what the file *can* skip, not what it *can't* be. Falling through to exit 0 implies success — silently. A CLI that exits 0 without doing anything is worse than one that errors loudly, especially when shipped in a published `dist/`.

## Next time
For placeholder CLIs/handlers/stubs: explicit error path with a clear stderr message + non-zero exit when invoked outside the supported surface. "Placeholder" should mean "not yet implemented, fails loudly," not "silently does nothing." Treat Codex's signal as valid even when ACs pass — acceptance criteria are necessary, not sufficient.
