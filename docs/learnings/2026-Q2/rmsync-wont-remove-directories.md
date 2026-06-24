# rmSync without recursive:true refuses to remove directories

> 2026-05-30 · FORGE-158 · tags: [foundation, gotcha, fs]

## What we expected
`rmSync(dir, { recursive: false, force: true })` would delete an empty directory
(I used recursive:false deliberately, as a guard so a non-empty dir wouldn't be
nuked).

## What happened
It throws `EISDIR`/`ERR_FS_EISDIR` on *any* directory — empty or not. eject's
empty-farm-dir cleanup silently caught the throw and left `.claude/skills`,
`.claude/agents`, `.claude/` behind as empty dirs. A unit test passed; the e2e
caught it.

## Why
Node's `fs.rmSync` only removes directories when `recursive: true`. There is no
"remove this dir only if empty" mode in `rmSync`.

## Next time
Use `rmdirSync(dir)` to remove a dir only-if-empty — it throws `ENOTEMPTY`
otherwise, which is exactly the "stop at a non-empty ancestor" guard you want.
Reserve `rmSync({recursive:true})` for "delete this whole subtree".
