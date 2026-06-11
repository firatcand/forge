<!-- >>> forge-managed (do not edit between markers) >>> -->
> This project uses [Forge](https://github.com/firatcand/forge). Before any work, read `.forge/CONTEXT.md`
> for the methodology this project follows. If that file is missing, install Forge with:
>
> ```
> npm install -g @firatcand/forge
> forge upgrade
> ```
>
> Note: `.forge/CONTEXT.md` is gitignored and regenerated per-developer by `forge upgrade`.
<!-- <<< forge-managed <<< -->

# forge

> **Note:** This is the forge repo itself. Iterating on this repo means iterating on the framework — every change ships to `npm publish @firatcand/forge` and lands on adopter machines via `npx @firatcand/forge`. Treat all changes as public-API.

## Stack
<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->

## Commands
- Build: `npm run build`
- Test: `npm test`
- Type check: `npm run typecheck`
- Lint: `npm run lint` (ESLint — unused vars/imports + unreachable; non-blocking, warnings only)
- Dev: `npm run dev`
- Render methodology context (one-shot, until Phase B's `forge upgrade` ships): `npm run forge:render-context`

## Conventions
<!-- Project-specific. -->
- Functional components only, no class components
- Always handle errors explicitly — no silent catches
- New API routes must have input validation
- See `spec/` for full conventions

## Critical paths
<!-- Files matching these patterns trigger /second-opinion auto-review on /ship -->
See CRITICAL.md
