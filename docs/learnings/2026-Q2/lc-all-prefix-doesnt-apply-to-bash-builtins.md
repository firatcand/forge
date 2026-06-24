# LC_ALL inline-prefix is silently ignored by bash builtins
> 2026-05-17 · FORGE-115 · tags: [bash, skills]

## What we expected
`LC_ALL=C [[ "${LINEAR_ID}" =~ [^A-Za-z0-9._-] ]]` would pin the regex to the C locale for that test and restore the prior locale afterward — the standard POSIX VAR=val command-prefix idiom.

## What happened
Bash silently treated the `LC_ALL=C` prefix as a no-op. The `[[` test ran under whatever locale was already active. No error, no warning. The sanitizer appeared correct on casual inspection.

## Why
The POSIX VAR=val command-prefix syntax scopes the variable to a forked child process. Bash builtins (`[[`, `[`, `read`, `echo`, etc.) run in-process — there is no child to scope to. Bash parses the assignment but it takes effect in the current shell's environment for the duration of that statement, meaning the variable is set, not scoped, and never automatically restored. The intent (temporary scoping) simply cannot be achieved this way for builtins.

## Next time
For builtins, save/restore explicitly:

```bash
_old_lc="${LC_ALL-UNSET}"
LC_ALL=C
if [[ "${LINEAR_ID}" =~ [^A-Za-z0-9._-] ]]; then ...; fi
if [[ "${_old_lc}" == "UNSET" ]]; then unset LC_ALL; else LC_ALL="${_old_lc}"; fi
unset _old_lc
```

Or wrap in a `( subshell )` when you don't need to `exit` from inside. Add a comment explaining why — the symptom (locale not actually pinned) is invisible to tests unless the test explicitly runs under a non-C locale.
