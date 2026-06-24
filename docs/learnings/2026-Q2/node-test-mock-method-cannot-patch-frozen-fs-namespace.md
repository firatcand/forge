# `node:test`'s `mock.method` cannot patch the frozen `node:fs` namespace — use a mutable seam

> 2026-05-14 · FORGE-69 · tags: [testing, mocking, node-test, esm, fs, test-seam]

## What we expected
The FORGE-69 plan called for testing partial-write loops, `closeSync` failures, and `writeSync(...) === 0` zero-progress guards by passing a custom implementation via `t.mock.method(fs, 'writeSync', impl)` from `node:test`. `mock.method` is the standard mocking primitive in the built-in test runner and the writer imports its fs functions from `node:fs` directly — should just work.

## What happened
`node:fs` is a built-in module. Its namespace, accessed via `import * as fs from 'node:fs'`, is a **Module Namespace Object** — V8 marks its bindings as non-writable and non-configurable per the ES spec. `mock.method` uses `Object.defineProperty(target, key, ...)` under the hood, which throws `TypeError: Cannot redefine property` against a frozen namespace. Named imports (`import { writeSync } from 'node:fs'`) bind to the same frozen references and cannot be swapped either. Tests T2–T5/T8 would all fail at setup. The plan was naive about how ESM bindings to built-in modules work.

## Why
ES module namespaces are spec-frozen for purity (live bindings, predictable evaluation). Mocking libraries that work in CommonJS land (where `require('fs').writeSync = mock` mutates the module's exports object) hit a wall against ESM built-ins. There's no flag or escape hatch in core Node — the lockdown is intentional.

## Next time
For any module that wraps fs (or any other built-in) and needs failure-injection tests, add a tiny test seam: a plain mutable object that holds the fs method references the module uses internally. Pattern:

```ts
import { closeSync as _closeSync, writeSync as _writeSync /* ... */ } from 'node:fs';
export const __fsForTesting = { closeSync: _closeSync, writeSync: _writeSync /* ... */ };
const fs = __fsForTesting; // internal alias
// ...use fs.writeSync(...) etc. throughout.
```

Tests use `t.mock.method(__fsForTesting, 'writeSync', impl)` and it works because `__fsForTesting` is a plain mutable object. Cost: one exported symbol with a leading `__` to flag intent at the call site. Cheaper than pulling in a CommonJS mocking lib and far cheaper than refactoring to dependency injection. The same pattern applies to other built-in module wrappers (`node:crypto`, `node:os`, `node:http`) where tests need to simulate failures. Skip this seam only if the module's fs use is so narrow that integration testing (real temp dir + real failure conditions like `chmod 0`) covers the cases — but partial-write / zero-progress / delayed-close-error paths are usually not reproducible without mocks.
