# FORGE-117 — NotionTracker → `ntn` CLI transport + `updateIssueBody`

> Status: implementing (Codex pre-opinion "revise" applied) · Attempt 019eb67c-c04c-7ddd-b382-b9e9f043e07d
>
> **Pre-opinion deltas (all applied):**
> 1. **setClaimFence DROPPED from scope** — reusing `forge_claimed_by` would lose claimId/generation and violate the ClaimFenceData contract; claim/cancel tolerate the stub best-effort; correct impl belongs to FORGE-145/167 follow-up. Stub stays.
> 2. init touches MCP too: `src/cli/init/validate.ts` probeTracker reads `mcp_command`; `src/cli/init/prompts.ts` emits the deprecated fields — init now emits only `database_id`, probe becomes `ntn --version` (+ auth guidance); their tests updated.
> 3. `defaultNtnExec` uses execa `reject: false` so nonzero exits return (not throw); classifier handles thrown spawn errors AND returned shapes; unknown nonzero → UNKNOWN (not retriable TRANSPORT). Add `restricted_resource`, invalid-request variants, `concurrent_edit`, 5xx → TRANSPORT mappings.
> 4. Chunking: one paragraph block with multiple ≤2000-char rich_text items (extract shared `bodyToParagraphBlock`); respect 100-items/block by splitting into multiple paragraphs past 100 items.
> 5. Children pagination via query args (`page_size==100`, `start_cursor==…`), not stdin.
> 6. Pin `NOTION_API_VERSION = '2026-03-11'` (current official; replaces the adapter's stale 2025-09-03 assumption — verify nothing in payloads changed between versions for the endpoints we use; data_sources split is already reflected in current code).
> 7. Flip `trackerSupportsBodyMutation()` for notion; update docs/adapters/notion.md lifecycle comments; remove SDK from package-lock too; integration notion config + stale MCP comments updated.
> 8. close-handle removal confirmed safe (TrackerHandle.close already optional).
> User decision 2026-06-11: **remove @modelcontextprotocol/sdk; soft-deprecate settings fields** — `mcp_command`/`mcp_env` stay schema-accepted but IGNORED (one-line deprecation warning); removed for real in v0.5. Notion config effectively shrinks to `database_id`; the `ntn` binary is assumed on PATH exactly like `gh`.
> `ntn api` contract verified against developers.notion.com: raw JSON body via stdin or `--data`; inline `field=str` / `field:=json` syntax; `-X` method override (GET default, POST with body); `--notion-version` pinning (else latest); auth from keychain (`ntn login`); `--verbose` puts response metadata on stderr.

## What ships

| Artifact | Change |
|---|---|
| `src/trackers/notion.ts` | `McpCall` seam → `NtnExec` seam (exact `GhExec` mirror: `(args, opts?: {input?}) => Promise<{stdout, stderr, exitCode}>`); every `runTool('API-…')` call → `ntn api v1/…` invocation; `updateIssueBody` + `setClaimFence` implemented; `classifyNotionExecError` added |
| `src/trackers/notion-mcp-transport.ts` | DELETED |
| `src/trackers/index.ts` | drop the transport re-exports |
| `src/cli/orchestrate/tracker-factory.ts` | notion case: no child process, no close handle — construct `NotionTracker` with `defaultNtnExec`; print the soft-deprecation warning when `mcp_command`/`mcp_env` present |
| `src/schemas/settings.ts` | `mcp_command`/`mcp_env` → optional, documented DEPRECATED+ignored (no default emission); `database_id` unchanged |
| `package.json` | remove `@modelcontextprotocol/sdk` |
| `test/unit/trackers/notion.test.ts` | `MockMcp` → `MockNtn` (gh-test pattern: argv+input capture, scripted stdout/exitCode steps); ALL existing cases preserved; new updateIssueBody/setClaimFence/error-classification cases |
| `docs/adapters/notion.md` | transport row → ntn CLI; `ntn login` auth section; install; updateIssueBody → implemented; MCP-removal note + deprecated fields |

## Endpoint mapping (MCP tool → ntn)

| Method | ntn invocation |
|---|---|
| healthCheck | `ntn api v1/users/me` |
| listFiltered | `ntn api v1/data_sources/{database_id}/query -X POST` body via stdin (filter + pagination cursor loop, `truncated` flag at page cap as today) |
| claim / releaseClaim / updateState / setBlockedBy | `ntn api v1/pages/{page_id} -X PATCH` body via stdin (property writes identical to today's API-patch-page payloads) |
| comment | `ntn api v1/comments -X POST` |
| createProject | `ntn api v1/data_sources -X POST` (as today's API-create-a-data-source) |
| createIssue | `ntn api v1/pages -X POST` (children blocks via stdin body — unchanged builder `buildIssueChildren`) |
| updateIssueBody | see below |
| setClaimFence | property write like claim (page properties carry claim identity on Notion — body fences are a Linear/GitHub concept; Notion's `forge_claimed_by` property is the fence equivalent, matching today's claim storage) |

All request bodies go via **stdin** (single body source; avoids arg-length limits and quoting bugs); `--notion-version <pinned>` on every call (constant `NOTION_API_VERSION`, pinned not floating — deterministic behavior across adopter machines).

## `updateIssueBody(issueId, body)` — the heart

1. `assertValidBodyInput(body, NOTION_BODY_MAX_BYTES = 65_536)` (footers.ts contract: non-string, `<!-- forge:* -->` rejection, byte cap — identical to Linear/GitHub).
2. Retrieve the page (`ntn api v1/pages/{id}`); **PRECONDITION_FAILED unless the `forge_task_id` property exists and is non-empty** (issue created outside forge).
3. Replace children — Notion has NO atomic body replace; `PATCH v1/blocks/{id}/children` APPENDS:
   a. `GET v1/blocks/{page_id}/children` (cursor loop, collect child ids)
   b. `DELETE v1/blocks/{child_id}` per child
   c. `PATCH v1/blocks/{page_id}/children` appending new paragraph blocks from the body string (reuse the paragraph-chunking from `buildIssueChildren`; chunk ≤2000 chars per rich_text item — Notion limit)
4. Partial-failure semantics: a crash mid-delete/append leaves a partial body. This matches the interface's documented contract (`updateIssueBody` has NO CAS; caller holds the claim; single-writer) — the operation is **idempotently re-runnable** (re-run deletes whatever children remain and re-appends). Errors mapped retriable (TRANSPORT/RATE_LIMITED) vs not via classifyNotionExecError. Document in the method docstring + docs/adapters/notion.md.
5. forgeTaskId/blockerIds survive untouched — they are PAGE PROPERTIES on Notion, not body footers (adapter-specific storage; the round-trip AC `createIssue → updateIssueBody → listActiveIssues` proves it).

## Error classification (`classifyNotionExecError`)

Mirror `classifyGitHubError`'s order-critical structure: ENOENT/spawn fail → TRANSPORT ("ntn not installed — see docs"); exitCode!=0 + stderr/stdout JSON `{"object":"error","code":…}` mapping: `unauthorized`→AUTH, `object_not_found`→NOT_FOUND, `validation_error`→VALIDATION, `conflict_error`→CONFLICT, `rate_limited`→RATE_LIMITED, timeouts→TIMEOUT, else TRANSPORT. Parse Notion's error JSON from stdout when present (ntn passes the API response through), else stderr patterns.

## Settings + factory

- Schema: `mcp_command`/`mcp_env` optional, no defaults, JSDoc DEPRECATED note. Existing files parse unchanged.
- Factory notion case: `new NotionTracker({databaseId, ntn: defaultNtnExec}, logger)`; `close` handle gone (no child process) — factory returns undefined close for notion now (callers already tolerate undefined: Linear/GitHub have none).
- Deprecation warning (stderr, once per construction) when the deprecated fields are present.

## Tests

1. Every existing notion.test.ts case rewired to MockNtn (responses now JSON-on-stdout instead of MCP tool results) — behavior assertions unchanged.
2. updateIssueBody: happy path (children listed→deleted→appended; argv sequence asserted incl. -X and stdin bodies); validation trio (non-string, forge-footer, >64KiB); PRECONDITION_FAILED on missing forge_task_id; pagination of children list; partial-failure retriability (delete fails mid-way → retriable error; re-run completes); body chunking >2000 chars.
3. setClaimFence: property write + missing forge_task_id precondition.
4. classifyNotionExecError table-driven cases.
5. Factory: notion constructs without close handle; deprecation warning emitted when mcp_command present; absent otherwise.
6. Round-trip (unit-level with MockNtn): createIssue → updateIssueBody → listActiveIssues preserves forgeTaskId.
7. `@modelcontextprotocol/sdk` absent from package.json (a small dependency-guard assertion in an existing meta test if one exists, else skip).

## Risks / notes

- `ntn` exit-code/stdout contract is under-documented; the exec seam isolates it — unit tests script the seam, and FORGE-110's live e2e arm validates reality. classifyNotionExecError is written defensively (JSON-first, pattern fallback, TRANSPORT default).
- Children delete loop = N+2 calls per body update; bodies are small (task descriptions), acceptable.
- `setClaimFence` was NOT_IMPLEMENTED too; implementing it via the existing claim-property avoids leaving a second stub behind (cheap — same property machinery). If Codex flags scope creep, it can be dropped to keep the ticket tight.
