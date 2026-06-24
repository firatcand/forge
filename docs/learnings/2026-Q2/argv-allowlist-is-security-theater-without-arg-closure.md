# argv[0] allowlists are security theater when argv[1+] is unconstrained
> 2026-05-17 · FORGE-100 · tags: [security, threat-model, spawn, mcp]

## What we expected
Restricting `mcp_command[0]` to `{npx, node}` meaningfully constrains what an attacker who writes `.forge/settings.yaml` can execute. The 1st-round security-auditor recommended this allowlist as a mitigation for arbitrary-command injection.

## What happened
Codex pointed out in the 2nd-pass review that `node` and `npx` both accept arguments that evaluate arbitrary code or fetch and run arbitrary packages. Constraining argv[0] without locking down argv[1+] is not a security boundary; it is cosmetic. The allowlist was replaced with a threat-model comment: settings.yaml is trusted-executable config (same trust level as package.json scripts), write-protected by branch rules + CODEOWNERS, and the allowlist would not have prevented execution by a CI worker that had already mutated the file.

## Why
Allowlists on binary names feel like security controls because they look like an explicit permission list. But when the binary is a general-purpose interpreter, the argument vector is itself a program. The real attack surface is the file that names the command, not the command name. A reviewer whose mental model is "constrain the binary name" misses that the binary accepts arguments that negate the constraint.

## Next time
When a config file names a binary that will be spawned: the security boundary is the file's write-protection, not its content shape. Either pin the exact full command+args (a complete closure with no runtime-evaluated arguments) or document the trust model explicitly and protect the file via CODEOWNERS. A partial allowlist on argv[0] alone is not a mitigation — flag it in review as theater and ask for one of the two real options.
