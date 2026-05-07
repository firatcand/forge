---
name: draft-design
description: Generate spec/DESIGN.md from spec/PRD.md. References user's brand-book and design-system via @inherit pattern.
tools: Read, Write, Edit
---

# /draft-design

## Preconditions

- `spec/PRD.md` must exist
- User's brand assets configured in `~/.claude/CLAUDE.md` under `brand_assets`

## Configuration expected

```yaml
# In ~/.claude/CLAUDE.md
brand_assets:
  brand_book: ~/work/brand/BRAND-BOOK.md
  design_system: ~/work/brand/DESIGN-SYSTEM.md
  voice_register: ~/work/brand/VOICE.md
```

If not configured, prompt user to set these once.

## Orchestration

1. Read PRD, brand_book, design_system, voice_register
2. Check if user has a `ux-design` skill — invoke with all four as context
3. Determine project surface area (marketing site, app UI, email, docs)
4. Generate DESIGN.md using `@inherit` pattern — reference brand assets, don't duplicate

## The @inherit pattern

DESIGN.md should reference, not duplicate:

```markdown
## Tokens
@inherit ~/work/brand/DESIGN-SYSTEM.md#tokens

Project-specific overrides:
- accent: --color-coral (use only for primary CTA)

## Voice
@inherit ~/work/brand/VOICE.md

Project-specific calibration:
- This is a tool, not editorial — trim lyricism, keep precision
```

When brand assets update, project DESIGN.md inherits the change.

## Output

`spec/DESIGN.md` + Gate 3 confirmation.
