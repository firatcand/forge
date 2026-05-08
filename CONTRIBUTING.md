# Contributing to Forge

Thanks for considering contributing to forge. The contribution model is **gstack-shaped**: skills are markdown files, principles live in `ETHOS.md`, and there are no exotic dependencies. Most contributions don't require running anything — just editing markdown.

## What contributions are welcome

- **Skill improvements**: clearer instructions, better Confusion Protocol triggers, missing edge cases
- **New subagents** for stack specialties not yet covered (e.g., mobile-dev, ml-engineer)
- **Template refinements** that solve real problems you hit while dogfooding
- **Doc fixes**: typos, broken links, clearer examples
- **Bug fixes** in `bin/forge.js`, `lib/tools.js`, or `lib/*.sh` helpers
- **New examples** in `examples/` showing forge applied to a different stack or domain

## What contributions are NOT welcome (yet)

- Large architectural refactors without prior discussion in an issue
- New principles in `ETHOS.md` — these are deliberately stable
- Telemetry, analytics, or anything that calls home
- Build steps or compiled artifacts
- Dependencies beyond bash, git, gh, jq, yq, and python3 (for YAML validation only)

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
node --check bin/forge.js lib/*.js
bash -n lib/*.sh
for f in templates/github-workflows/*.yml templates/phases.template.yaml; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))"
done
for f in skills/*/SKILL.md agents/*.md; do
  head -1 "$f" | grep -q '^---$' || echo "MISSING FRONTMATTER: $f"
done
```

All must pass cleanly.

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

## Code of conduct

Be kind. Assume good faith. Keep PR discussions focused on the change. If a discussion drifts toward the meta-design of forge, take it to a separate issue.

## License

By contributing, you agree your contributions are licensed under the MIT License.
