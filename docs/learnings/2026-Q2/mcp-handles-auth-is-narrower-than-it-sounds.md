# "MCP handles auth" is a layer-1 promise, not layer-2

> 2026-05-13 · FORGE-17 · tags: [spec, mcp, auth, architecture, adapters]

## What we expected
SPEC and FORGE-17 description both said "MCP handles auth — no secrets manager dependency" for NotionTracker. Interpreted that as "the user configures Notion once for their host CLI and forge piggybacks; no Notion credential surfaces in forge's flow."

## What happened
The MCP server itself (`@notionhq/notion-mcp-server`) is a separate process that makes HTTPS calls to api.notion.com — it needs a Notion integration token at spawn time. forge spawns its own server (not piggybacking on the host CLI's connection) and inherits `process.env`, so adopters still have to export `NOTION_TOKEN` somewhere. Documenting this in `docs/adapters/notion.md` revealed the SPEC phrase had been read as broader than its narrow technical meaning.

## Why
Two distinct auth layers in any MCP-based adapter: (1) forge ↔ MCP server (transport, no creds — just stdio), (2) MCP server ↔ provider API (still needs provider creds). "MCP handles auth" only covers layer 1: forge doesn't add a `notion_api_key` entry to its `secrets.manager` config or call `secrets.get(...)` for it. Layer 2 doesn't disappear; the token just lives in the user's shell env, not forge's managed secrets pipeline.

## Next time
For every future MCP-based tracker / integration spec, write the auth contract in two lines: "forge ↔ MCP: X. MCP ↔ provider: Y." Never write "MCP handles auth" alone — it elides the layer-2 reality and sets adopters up for "wait, why do I still need a token?" If the goal is true zero-config auth for adopters, the design has to be host-CLI-config inheritance (cf. the Option C we deliberately deferred), not just "use MCP" — those are different solutions to different problems.
