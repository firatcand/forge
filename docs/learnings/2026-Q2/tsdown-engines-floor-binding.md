# Foundation tooling can silently dictate runtime engines
> 2026-05-10 · FD-6 · tags: [foundation, toolchain, dependencies, gotcha]

## What we expected
Picked Node `>=20.6` for `engines.node` to match the `node --import tsx --test` test runner requirement. Treated this as the binding constraint.

## What happened
After locking `tsdown@0.22.0` as the bundler, discovered tsdown's own `engines` is `^22.18.0 || >=24.0.0` — strictly higher than 20.6. The dev tooling's transitive engines silently overrode the project's intended floor; we had to align to tsdown's range or `npm install` would warn every contributor.

## Why
Build/test tools are dependencies too — their `engines` propagate up to whoever installs them. We made the engines decision before locking exact dev tool versions, so the constraint was unknown at decision time.

## Next time
Run `npm view <devDep>@<version> engines` for the bundler/runner BEFORE finalizing the project's `engines.node`. Treat the union of all dev-tool engines as the real floor — the manually-chosen number is just a starting bid.
