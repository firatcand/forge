# Contributing to Forge

Thanks for considering contributing to forge. The contribution model is **gstack-shaped**: skills are markdown files, principles live in `ETHOS.md`, and there are no exotic dependencies. Most contributions don't require running anything — just editing markdown.

## What contributions are welcome

- **Skill improvements**: clearer instructions, better Confusion Protocol triggers, missing edge cases
- **New subagents** for stack specialties not yet covered (e.g., mobile-dev, ml-engineer)
- **Template refinements** that solve real problems you hit while dogfooding
- **Doc fixes**: typos, broken links, clearer examples
- **Bug fixes** in the TypeScript core under `src/` (CLI entrypoint `src/bin/forge.ts`, schemas, core utilities)
- **New examples** in `examples/` showing forge applied to a different stack or domain

## What contributions are NOT welcome (yet)

- Large architectural refactors without prior discussion in an issue
- New principles in `ETHOS.md` — these are deliberately stable
- Telemetry, analytics, or anything that calls home
- Dependencies beyond what the TypeScript core needs (Node ^22.18 || >=24, the runtime deps listed in `package.json`, and standard host tools: git, gh)

## How to contribute

### Small fixes (typos, doc corrections, single-skill improvements)

1. Fork
2. Edit
3. Open a PR with a short description and a reasoning sentence

### Larger changes (new skill, new agent, new template)

1. Open an issue first describing the gap you've hit and your proposed approach
2. Wait for a maintainer reaction — usually within 48 hours
3. If the direction is approved, fork and implement
4. Dogfood the change on a real project before submitting the PR
5. Open a PR with a description that includes:
   - The problem you hit
   - How the change solves it
   - A link to or summary of the dogfooding evidence

## Style guide

### Skills (`skills/{name}/SKILL.md`)

- Keep the description concise: 1–2 sentences max. This is what Claude reads to decide whether to invoke.
- Use the imperative voice: "Generate the PRD" not "This skill generates the PRD"
- Always document preconditions explicitly (what files must exist, what state must hold)
- Include an Output section so the user sees what to expect
- If the skill delegates to a subagent, name it in frontmatter

### Subagents (`agents/{name}.md`)

- Scope: list what the agent does and (when relevant) what it does NOT do
- Conventions: bullet list of rules the agent applies
- Confusion Protocol triggers: explicit list of decisions the agent MUST stop and ask about
- Output format: example or schema

### Templates (`templates/`)

- Use `{{PLACEHOLDER}}` for substitutions
- Mark required sections with `<!-- REQUIRED -->`
- Inline guidance with `<!-- comments -->` so users know what to fill in

## Local validation

Before opening a PR:

```bash
cd <your forge clone>
npm run typecheck
npm run build
npm test
for f in skills/*/SKILL.md agents/*.md; do
  head -1 "$f" | grep -q '^---$' || echo "MISSING FRONTMATTER: $f"
done

# Guard: removed orchestrate verbs must not reappear (see CLAUDE.md §Skill ↔ verb contract).
! git grep -nE 'forge orchestrate (next|suggest-next|session-check|intent-detect)\b' -- src skills templates docs || (echo "FORBIDDEN: removed orchestrate verb reference" >&2; false)
```

All must pass cleanly.

### Pre-push smoke (catches packaging bugs the regular checks miss)

Regular checks run against a `devDependencies`-populated `node_modules`; end users get only runtime deps because `tsdown` marks `dependencies` external. A chalk packaging bug shipped exactly this way in FORGE-67 — `--version` worked but any command that rendered colored output crashed at runtime. The smoke test catches this class of regression before it reaches npm.

```bash
npm run build
rm -rf node_modules
npm ci --omit=dev
node dist/bin/forge.cjs --version
node dist/bin/forge.cjs --help
node dist/bin/forge.cjs migrate --dry-run
```

`--version` and `--help` verify the bundle loads at all under a production-only install — missing runtime dependencies fail at module load, since the CJS bundle imports them at startup. They print plain text, though, so they never reach the colored-output code paths. `migrate --dry-run` (read-only — plans changes, writes nothing) renders the chalk-colored migration report, which is exactly the path that broke in FORGE-67: chalk v5 is pure ESM and the CJS bundle's interop can double-wrap it, so it only fails when colored output actually renders.

Restore dev dependencies afterwards:

```bash
npm ci
```

## PR description template

```markdown
## What

One sentence describing the change.

## Why

Concrete pain you hit while using forge that motivated the change.

## How tested

How you dogfooded the change on a real project.

## Breaking change?

Yes / No. If yes, what migrates.
```

## Releasing

Releases are automated (FORGE-157). The flow:

1. Open a release PR that bumps `package.json` version and adds (or moves `[Unreleased]` into) a `## [X.Y.Z] — YYYY-MM-DD` section in `CHANGELOG.md`.
2. Merge the PR.
3. Tag the merge commit on `main` and push the tag:
   ```bash
   git tag v0.3.1 9308b22  # use the actual merge SHA
   git push origin v0.3.1
   ```
4. `.github/workflows/release.yml` runs the full CI gate on the tagged commit, refuses if the tag doesn't match `package.json` version, and runs `npm publish --provenance`.
5. `.github/workflows/release-draft.yml` slices the `## [0.3.1]` section from `CHANGELOG.md` and creates a DRAFT GitHub Release pre-filled with those notes. Review + click Publish in the GH UI.
6. Verify the published package: `npm audit signatures @firatcand/forge@0.3.1` should report a verified attestation.

### One-time setup: `NPM_TOKEN` secret

The publish step needs an npm token in the repo's GitHub secrets.

1. Create a granular automation token at https://www.npmjs.com/settings/<your-username>/tokens/granular-access-tokens/new
   - **Token name:** `forge-publish-from-gh-actions` (or any label you'll remember)
   - **Token expires:** as long as you're comfortable with — 90 days is a reasonable balance
   - **Packages and scopes** → restrict to `@firatcand/forge`
   - **Permissions** → `Read and write` (publish requires write)
2. Add the token to the repo: Settings → Secrets and variables → Actions → New repository secret
   - **Name:** `NPM_TOKEN`
   - **Secret:** the token from step 1
3. Rotate every ~90 days, or whenever the token expires.

## Code of conduct

Be kind. Assume good faith. Keep PR discussions focused on the change. If a discussion drifts toward the meta-design of forge, take it to a separate issue.

## License

By contributing, you agree your contributions are licensed under the MIT License.
