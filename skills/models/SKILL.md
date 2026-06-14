---
name: models
description: Refresh the agent-maintained model catalog — web-search each host's provider docs + CLI model listings into a cited chart mapping concrete models to forge's {small, standard, frontier} tiers, then validate + write the cache via `forge orchestrate models --refresh`. Zero ongoing user maintenance.
tools: Read, Write, Bash(forge*), WebSearch, WebFetch
---

# /models

Compile the model catalog that the router (FORGE-210) reads for deterministic
tier → concrete-model routing. The verb (`forge orchestrate models`) is the
deterministic half: it reads/prints the cache, nudges on staleness, and on
`--refresh --file <json>` validates the agent's chart and atomically writes
`.forge/models-catalog.json`. This skill is the agent half: it does the web
research and produces that file.

## When to run

- The `models` read path printed a staleness nudge (catalog older than
  `settings.models.ttl_days`, default 14d).
- A new model shipped (new Claude / GPT-5.x / Gemini / Cursor release) and you
  want routing to see it.
- Cold start: no `.forge/models-catalog.json` yet (the verb falls back to the
  bundled seed until you refresh).

## Steps

1. **Read the current state** (so the diff is meaningful and you don't re-derive
   what's already correct):

   ```bash
   forge orchestrate models --json
   ```

2. **Research each host.** For every host in `{claude, codex, gemini, cursor}`,
   web-search the provider's model documentation + the host CLI's model listing,
   then fetch the authoritative page(s). Suggested anchors (verify, don't trust
   from memory — model names change):
   - claude → Anthropic model docs (`docs.anthropic.com`).
   - codex → OpenAI model docs (`platform.openai.com/docs/models`).
   - gemini → Google AI model docs (`ai.google.dev`).
   - cursor → Cursor model docs (`docs.cursor.com`).

   Use `WebSearch` to find the current pages and `WebFetch` to read them. If a
   host doesn't honor `WebSearch`/`WebFetch`, use whatever web tool the host
   provides; if no web tool is available at all, the bundled cold-start seed
   already covers the no-web case — do NOT fabricate models or sources.

3. **Map each model to a tier.** Tier vocab is the fixed forge set:
   `small | standard | frontier`. Map the host's flagship/most-capable model to
   `frontier`, its balanced workhorse to `standard`, and its cheapest/fastest to
   `small`. Every model MUST carry at least one real `sources` URL (the page you
   read it from) — citations are the trust mechanism; an uncited entry is a bug.

4. **Compile a `ModelsCatalog` JSON** matching this shape (see
   `src/schemas/models-catalog.ts`):

   ```json
   {
     "version": 1,
     "refreshed_at": "<ISO-8601 with offset, e.g. 2026-06-14T12:00:00Z>",
     "hosts": {
       "claude": {
         "models": [
           { "id": "<model-id>", "tier": "frontier", "capabilities": "<short>", "sources": ["https://..."] }
         ]
       }
     }
   }
   ```

   Bounds the verb enforces (keep within them): `id` ≤ 200 chars, `capabilities`
   ≤ 2000, each source URL ≤ 500, ≤ 20 sources per model, ≤ 100 models per host,
   and the object is strict (no extra keys). The whole file must be ≤ 1 MB.

5. **Write to a temp file and hand it to the verb** (the verb validates +
   atomically writes the cache + prints the diff):

   ```bash
   TMP=$(mktemp -t forge-models.XXXXXXXXXX)
   # ... write the compiled catalog JSON to "$TMP" ...
   forge orchestrate models --refresh --file "$TMP" --json
   rm -f "$TMP"
   ```

6. **Print the returned diff** (added / removed / retiered models) so the human
   sees exactly what routing will now resolve to. On `INVALID_CATALOG` or
   `INPUT_TOO_LARGE`, fix the file and retry — nothing is written on a bad parse.

## Notes

- **No self-loop.** This skill runs once per invocation: research → compile →
  one `--refresh` call → print the diff → return. It does NOT poll, sleep,
  watch, or re-invoke `/models`.
- **Pins are not here.** `settings.models.pinned[host]` is a per-host allow-list
  FILTER applied at read time over the cache — you never re-specify tiers or
  sources in settings. Always emit the full known set per host; let pins narrow
  it downstream.
- **Settings override wins** for which hosts the router considers, but the cache
  is the single source of truth for tiers and citations.
