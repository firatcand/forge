# execa wrappers that spread defaults silently widen the result type
> 2026-05-18 · FORGE-122 · tags: [typescript, testing, execa, abstraction-cost]

## What we expected
A thin wrapper `spawnTsx(args, opts) => execa(tsxBin, args, { reject: false, ...opts })` would be a pure ergonomic improvement: centralize the binary path + default `reject: false`, callers spread their per-test options on top. The type-narrowing already enjoyed at inline call sites would carry through.

## What happened
Every call site exploded with `error TS2345: Argument of type 'string | unknown[] | string[] | Uint8Array | undefined' is not assignable to parameter of type 'string | Error | undefined'` on lines like `assert.equal(result.exitCode, 0, result.stderr)`. The wrapper widened `result.stdout` and `result.stderr` from `string | undefined` to a union including `unknown[]`, `string[]`, and `Uint8Array` — because execa's `ResultPromise<OptionsType>` narrows on the literal options-object type, and `{ reject: false, ...opts }` widens at the spread to `Options` (the broad union), losing `reject: false` as a literal type.

## Why
Execa v9 types its result via overloads parameterized by the literal options shape: `<NewOptions extends Options>(file, args, options: NewOptions) => ResultPromise<NewOptions>`. At an inline call, TS infers `NewOptions = { reject: false; cwd: string; env: {...} }` — literal `false`, narrow result. Inside a wrapper, `{ reject: false, ...opts }` spreads to `Options` (the broad declared type, because the wrapper's parameter is typed `Options = {}`), and `ResultPromise<Options>` returns the maximum-width union. Salvageable with explicit generics (`<O extends Options>(args, opts: O) => execa(tsxBin, args, { reject: false as const, ...opts })`), but every wrapper attempt is one more place to mis-type.

## Next time
- For thin wrappers around execa: prefer exporting a `tsxBin` (or similar) constant from the helper and letting callers `execa(tsxBin, args, opts)` inline. Same centralization, no type tax.
- If a wrapper is genuinely needed (e.g., to inject env, lifecycle), accept the type-narrowing loss explicitly and document why — or design with overloads/generics from the start, not after the spread breaks narrowing.
- Default-spread (`{ x: 1, ...opts }`) is a typescript landmine whenever the outer type has type-narrowing semantics tied to literal values. Spot the pattern early.
