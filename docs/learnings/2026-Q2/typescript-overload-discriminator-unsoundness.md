# TypeScript overload unsoundness when discriminator is left wide

> 2026-05-12 · FORGE-18 · tags: [typescript, api-design, overloads, codex-finding, type-safety]

## What we expected
```ts
get(key: string, opts: { optional: true }): Promise<string | undefined>;
get(key: string, opts?: GetOpts): Promise<string>;
```
A caller writing `const v: string = await sm.get(k, opts)` with `opts: GetOpts` would resolve to the right return type based on runtime `optional`.

## What happened
`GetOpts = { optional?: boolean }` is wider than `{ optional: true }`, so overload resolution picks the non-optional overload (returning `string`) even when runtime `opts.optional === true`. Caller gets `undefined` typed as `string`. TS compiler accepts it; codex caught it.

## Why
Overload resolution matches by static type, not runtime value. If the non-optional overload accepts the wide `GetOpts`, any variable-typed caller silently picks the unsound branch. Both overloads must constrain the discriminator field.

## Next time
When defining overloads gated by a discriminator field, narrow EVERY overload's discriminator — including the "default" one:
```ts
get(key: string, opts?: { optional?: false | undefined }): Promise<string>;
```
Forces variable-typed callers to narrow at the call site or accept the union. Rule of thumb: if you can write `opts: WiderType` and have it pick the wrong overload, the overloads are unsound. Codex catches this pattern; `tsc` does not.
