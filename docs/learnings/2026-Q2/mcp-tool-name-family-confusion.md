# MCP tool-name families look identical but aren't interchangeable

> 2026-05-13 · FORGE-17 · tags: [mcp, integration, adapters, codex-finding, spec-drift]

## What we expected
SPEC.md referenced `mcp__claude_ai_Notion__*` tool names (notion-fetch, notion-update-page, notion-create-pages, notion-get-users, notion-create-comment, notion-create-database). We built the NotionTracker adapter against those names because that's what the SPEC pointed at and that's what showed up in the host CLI's tool list.

## What happened
Live integration test against the official `@notionhq/notion-mcp-server` (the npm package adopters install) revealed every single tool name was wrong — that server exposes `API-*` names (API-retrieve-a-page, API-patch-page, API-post-page, API-get-self, API-create-a-comment, API-create-a-data-source). `mcp__claude_ai_Notion__*` is the **claude.ai hosted** Notion connector, a different MCP server entirely. Same Notion product, totally different tool surface. Also exposed: Notion's 2025-09 schema splits databases into data sources (parent shape `data_source_id` not `database_id`), `API-post-page` schema declares `children: array of string` but rejects strings live, and error bodies come back as `isError: undefined` successful tool calls.

## Why
"Notion MCP" colloquially refers to multiple servers. The host CLI's tools (`mcp__claude_ai_Notion__notion-fetch`) were taken as canonical, but the adapter must work against whatever server adopters spawn — which for forge's stdio-spawned-from-config design is `@notionhq/notion-mcp-server`. The SPEC's tool-name reference was descriptive of one server but used as prescriptive for another. Mocks confirmed call-shape correctness against the assumed names, not the real ones — the [[gh-cli-flag-spelling-vs-api-enum]] pattern at the protocol-surface level instead of the flag-string level.

## Next time
Before targeting an MCP server, run `ListTools` against the *actual binary* you'll spawn in production and pin tool names + arg schemas from that probe. Treat host-CLI tool listings (`mcp__provider__*`) as the connector's brand-namespacing, not the underlying server's API. For specs: write tool names with a server-version attribution (e.g., "`API-patch-page` per `@notionhq/notion-mcp-server@2.x`"), not bare names. Integration tests required-before-PR for every MCP-based adapter — same gate as [[gh-cli-flag-spelling-vs-api-enum]] established for CLI-based adapters.
