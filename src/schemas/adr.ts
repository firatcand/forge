import { z } from 'zod';

// Ephemeral ADR frontmatter (FORGE-92 template → FORGE-95 parser).
// Verbatim from spec/SPEC.md §ADR layer "Zod schema". No id/supersedes chain —
// ADRs don't persist, so there's no sortable-ID or supersession need; a reversal
// is a new ADR. The git log is the sequence of record.

export const ADR_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export const AdrStatusSchema = z.enum(ADR_STATUSES);
export type AdrStatus = z.infer<typeof AdrStatusSchema>;

export const AdrFrontmatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: AdrStatusSchema,
  affected_tasks: z.array(z.string()).default([]),
  affected_spec_sections: z.array(z.string()).default([]),
  affected_prd_sections: z.array(z.string()).default([]),
  affected_phases_tasks: z.array(z.string()).default([]),
});
export type AdrFrontmatter = z.infer<typeof AdrFrontmatterSchema>;
