---
name: draft-design
description: Generate spec/DESIGN.md for the project. Asks at init whether to create a project-owned design system or reference an external one (URL/file/brand-book) as a guideline. Each project owns its DESIGN.md — no inheritance.
tools: Read, Write, Edit
---

# /draft-design

## Preconditions

- `spec/PRD.md` must exist
- Project has a UI surface (marketing site, app UI, email, docs). Skip for pure-backend products.

## Init prompt

When `/draft-design` runs the first time on a project, ask:

> Do you have a design system to reference, or should I create one for this project?
>
> **A) Reference external** — point me at a URL, file path, or brand-book asset. The project's DESIGN.md will be generated *consistent with* that reference, but stored locally as a self-contained doc.
>
> **B) Create new** — I'll generate a self-contained palette, type scale, spacing, components, voice from your product requirements.

Save the answer to `.forge/settings.yaml`:

```yaml
design:
  mode: project_owned        # project_owned | reference_external
  reference: <url-or-path>   # only if mode = reference_external
```

## Orchestration

1. Read PRD
2. Read `.forge/settings.yaml` for `design.mode` + `design.reference`
3. Check if user has a `ux-design`, `graphic-design`, or `frontend-design-pro` skill — invoke with PRD + reference (if any) as context
4. Determine project surface area (marketing site, app UI, email, docs)
5. Generate `spec/DESIGN.md` according to mode:
   - **project_owned** — write self-contained tokens, components, layouts, voice derived from product requirements
   - **reference_external** — read the reference, extract its guidelines (palette, type scale, spacing, voice register), write DESIGN.md *consistent with* it as a self-contained local doc

## Important: no @inherit pattern

DESIGN.md is a self-contained project artifact. It does NOT inherit at runtime from a maintainer-global brand book or external file. If a reference is configured, it constrains *generation* of DESIGN.md, but DESIGN.md itself is the project's source of truth from that point forward.

## Output

Print:

```
DESIGN written to spec/DESIGN.md (mode: {{design_mode}})

Summary:
- Tokens: [palette + type scale]
- Components: [primitives + composites]
- Voice: [tone + register]
- Reference: [if any]

Gate 3 — review the DESIGN. To proceed:
  • /ingest-spec to validate BRIEF + PRD + SPEC + DESIGN coherence
  • Edit spec/DESIGN.md directly
  • /draft-design --refine [section] to re-generate
```

## --refine mode

When invoked with `--refine [section]`:
1. Read existing spec/DESIGN.md
2. Re-generate the section per current PRD + reference
3. Show diff before writing
