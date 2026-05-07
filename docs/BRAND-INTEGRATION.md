# Brand Integration

If you have a brand-book or design-system that you want to reuse across projects, forge supports it through the `@inherit` pattern. Edit your brand assets once; every project's `DESIGN.md` picks up the change.

This doc covers the recommended brand-book structure, how to wire it into `~/.claude/CLAUDE.md`, the `@inherit` syntax, and when NOT to inherit.

---

## Why inherit?

The naive approach is copying tokens, voice rules, and components into each project's `DESIGN.md`. That copies the bug too — when you decide to shift the primary color from `#3366ff` to `#3349ee`, you have to touch every project. After 4 projects this is unmaintainable.

The `@inherit` pattern keeps `DESIGN.md` short and lets brand assets stay single-source-of-truth. The skill `/draft-design` reads the inheritance chain and resolves it at generation time, so the resulting code reflects the latest tokens — but the project's `DESIGN.md` itself stays a thin reference doc.

---

## Recommended brand-book structure

A brand-book is a directory of markdown files. Six sections cover the surface area:

```
~/work/brand/
├── BRAND-BOOK.md          ← the index doc that links everything
├── POSITIONING.md         ← what the brand says, to whom, why
├── VOICE.md               ← tone, vocabulary, sentence shape, example copy
├── DESIGN-SYSTEM.md       ← tokens (color, type, spacing, motion, radii)
├── COMPONENTS.md          ← primitives (Button, Input, Card) — visual specs
├── PATTERNS.md            ← composites (NavBar, Hero, FormStep) — when to use
└── EXAMPLES.md            ← annotated screenshots of in-the-wild applications
```

You don't need all six on day one. Most projects do well with just `VOICE.md` and `DESIGN-SYSTEM.md`. Add the others when you find yourself re-deciding the same thing across projects.

### Section heading discipline

For `@inherit` to work cleanly, brand-book files should have stable, predictable section headings:

```markdown
# Design System

## Tokens

### Color
- `--color-primary: #3366ff`
- `--color-text: #1a1a1a`
- ...

### Typography
- `--font-display: "Inter", sans-serif`
- ...

## Components

### Button
[primitive spec]

### Input
[primitive spec]
```

A project-level reference like `@inherit ~/work/brand/DESIGN-SYSTEM.md#tokens` then resolves to the entire `## Tokens` block.

---

## Wiring into `~/.claude/CLAUDE.md`

Add a `brand_assets:` block to your global CLAUDE.md:

```markdown
## Brand Assets (forge)

brand_assets:
  brand_book: ~/work/brand/BRAND-BOOK.md
  design_system: ~/work/brand/DESIGN-SYSTEM.md
  voice_register: ~/work/brand/VOICE.md
  positioning: ~/work/brand/POSITIONING.md   # optional
  components: ~/work/brand/COMPONENTS.md     # optional
```

Only `brand_book`, `design_system`, and `voice_register` are required. The optional fields are read by `/draft-design` if present and ignored otherwise.

`/draft-design` reads this block on every invocation. If the block is missing, the skill prompts you to set it once.

---

## The `@inherit` syntax

Inside a project's `DESIGN.md`:

```markdown
## Tokens
@inherit ~/work/brand/DESIGN-SYSTEM.md#tokens

Project-specific overrides:
- accent: --color-coral (use only for primary CTA)

## Voice
@inherit ~/work/brand/VOICE.md

Project-specific calibration:
- This is a tool, not editorial — trim lyricism, keep precision.
- Replace "we" with "you" — the user is the protagonist, not the brand.
```

The syntax is:

```
@inherit <absolute-or-tilde-path>[#section-heading-slug]
```

- The path can use `~` for `$HOME`.
- The optional `#section-heading-slug` selects a single `##`-level section.
- Slug rules: lowercase, dashes for spaces, ignoring `#` and punctuation. `## Color Tokens` becomes `#color-tokens`.

When `/draft-design` (or any skill that resolves DESIGN.md) reads an `@inherit` line, it expands the reference inline at generation time. The expansion is lazy — the project's DESIGN.md stays as `@inherit` references on disk.

---

## Worked example

Suppose your brand-book has:

```markdown
# ~/work/brand/DESIGN-SYSTEM.md

## Tokens
- `--color-primary: #3366ff`
- `--color-text: #1a1a1a`
- `--space-1: 4px`
- ...
```

And your project's DESIGN.md is:

```markdown
## Tokens
@inherit ~/work/brand/DESIGN-SYSTEM.md#tokens

Project-specific overrides:
- accent: --color-coral
```

When `frontend-dev` is implementing a button, it reads DESIGN.md, follows the inherit reference, and builds the component using `--color-primary` from the brand-book + `--color-coral` as the project override.

A month later, you realize `--color-primary` should be slightly darker. You edit:

```markdown
# ~/work/brand/DESIGN-SYSTEM.md

## Tokens
- `--color-primary: #2649c4`   ← changed
```

Every project that inherits this gets the new value automatically on the next implementation pass. No project-by-project search-and-replace.

---

## When NOT to inherit

**Project-specific is project-specific.** The accent color a marketing site uses for its CTA is rarely a brand-level decision. Define it locally with a Project-specific overrides block.

**Voice that drifts from brand.** If a particular product needs a different voice (e.g., a financial product needs more formality than your usual conversational brand voice), don't inherit — write the voice section locally and link to the brand voice as background reference, not authority.

**One-off projects.** For a 2-week side project that won't outlive the brand-book's next refactor, just write tokens directly. The inheritance overhead doesn't pay off.

**During brand exploration.** When you're still figuring out the brand voice or token system, don't inherit yet. Inherit only after the brand-book has stabilized for at least one project cycle.

---

## Maintenance

Brand-books rot. Set a quarterly reminder to:

1. Check that every section heading in your brand-book still matches what projects reference. If you renamed `## Color Tokens` to `## Color`, every `@inherit ...#color-tokens` is now broken.
2. Look at the project DESIGN.mds you've shipped this quarter. Are there overrides that should be promoted to the brand-book?
3. Look for inconsistencies between projects — same problem solved two ways. Promote the better solution.

The `/draft-design` skill includes a `--check-inherits` flag in v1.1 to flag broken `@inherit` references across all projects in `~/repos/`. For v1.0, manual checks are the way.
