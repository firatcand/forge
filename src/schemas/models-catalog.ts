// FORGE-212: the agent-refreshed model catalog — the router's knowledge base.
//
// The `/models` skill compiles a cited chart (web-search over provider docs +
// host CLI listings) and hands it to `forge orchestrate models --refresh --file
// <json>`, which validates it against this schema and atomically writes
// `.forge/models-catalog.json`. The router (FORGE-210) and availability probe
// (FORGE-213) read ONLY this cache, so the schema is the trust boundary between
// an agent-authored file and deterministic routing.
//
// R2 (untrusted --file): every field is BOUNDED and both object schemas are
// `.strict()`. A `--refresh --file` is agent/external input; an unbounded
// `capabilities` string or a 10k-element `models` array would be a memory /
// output-amplification vector. The verb additionally size-caps the file before
// it ever reaches this parser (statSync > 1 MiB → INPUT_TOO_LARGE).

import { z } from 'zod';

import { MODEL_TIERS } from './phases.ts';

// Bumped only on a breaking shape change; `version` is a literal so an older
// forge refuses a newer cache rather than mis-reading it.
export const CATALOG_VERSION = 1 as const;

// The host vocabulary mirrors agents.primary_host_cli / enabled_root_files
// (claude / codex / gemini / cursor). Kept as a standalone const (not imported
// from settings.ts) so the schema layer has no dependency on the settings
// layer — settings.ts depends on this direction is fine, the reverse is not.
export const CATALOG_HOSTS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type CatalogHost = (typeof CATALOG_HOSTS)[number];

// R2 field bounds — see file header.
const ID_MAX = 200;
const CAPABILITIES_MAX = 2_000;
const SOURCE_URL_MAX = 500;
const SOURCES_MAX = 20;
const MODELS_MAX = 100;

// F1 (untrusted --file): the `id` is interpolated into stderr diffs and printed
// charts, so it must not be able to carry control chars, ANSI escapes, tabs,
// newlines, or spaces. Constrain to a safe printable model-id charset that
// still covers real ids (`claude-opus-4`, `gpt-5.1-codex`, `gemini-2.5-pro`,
// `anthropic/claude-...`): alphanumerics plus . _ : / -.
const MODEL_ID_RE = /^[A-Za-z0-9._:\/-]+$/;

// A single concrete model mapped to one of the fixed 211 tiers, carrying at
// least one citation. `.strict()` rejects unknown keys (a malformed/hostile
// catalog cannot smuggle extra fields past the trust boundary).
export const ModelEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(ID_MAX)
      .regex(MODEL_ID_RE, 'model id must be alphanumerics and . _ : / - only'),
    tier: z.enum(MODEL_TIERS),
    capabilities: z.string().max(CAPABILITIES_MAX).optional(),
    sources: z.array(z.string().url().max(SOURCE_URL_MAX)).min(1).max(SOURCES_MAX),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

// F2 (determinism / untrusted --file): a host must not list the same model id
// twice (even under different tiers) — a duplicate id would make canonical
// ordering and diffing ambiguous, and is never a legitimate catalog. `.strict()`
// already blocks unknown keys; this `.superRefine` blocks the in-array dup.
export const HostCatalogSchema = z
  .object({
    models: z.array(ModelEntrySchema).min(1).max(MODELS_MAX),
  })
  .strict()
  .superRefine((host, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < host.models.length; i++) {
      const id = host.models[i]!.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate model id "${id}" within a host`,
          path: ['models', i, 'id'],
        });
      }
      seen.add(id);
    }
  });
export type HostCatalog = z.infer<typeof HostCatalogSchema>;

// The full cache. `hosts` is a partial record keyed by the host enum — a
// catalog may list a SUBSET of hosts (an unknown host KEY is rejected; see the
// R4 zod-behavior test). `.refine` forbids the degenerate empty-hosts catalog.
export const ModelsCatalogSchema = z
  .object({
    version: z.literal(CATALOG_VERSION),
    refreshed_at: z.string().datetime({ offset: true }),
    hosts: z.record(z.enum(CATALOG_HOSTS), HostCatalogSchema),
  })
  .strict()
  .refine((c) => Object.keys(c.hosts).length > 0, {
    message: 'catalog must list at least one host',
    path: ['hosts'],
  });
export type ModelsCatalog = z.infer<typeof ModelsCatalogSchema>;
