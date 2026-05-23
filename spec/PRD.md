# forge — PRD (v-next)

> Drafted: 2026-05-08 · Amended: 2026-05-17 (closed-loop workflow control) · Re-amended: 2026-05-17 PM (team-mode minimum architecture) · **Amended: 2026-05-21 (CLAUDE.md methodology split + multi-agent root files — FORGE-151)**
> Source: spec/BRIEF.md
> Mode: PRD with embedded feature specs

## Amendments (2026-05-17 PM — team-mode minimum architecture, supersedes morning amendment in part)

Driven by [docs/plans/team-mode-minimum-architecture.md](../docs/plans/team-mode-minimum-architecture.md). After four rounds of Codex stress-tests against a 5-person-team scenario, the user pulled the morning's closed-loop redesign back to a minimum-viable shape for v0.4. SPEC.md §21 and CONTEXT.md carry parallel amendment blocks; [CLAUDE.md §Source of truth](../CLAUDE.md) carries the canonical authority matrix.

**Sections in this PRD that are now partially or fully superseded (read this amendment before trusting them):**

| Section | Status |
|---|---|
| §Feature 5 — Drift workflow + ephemeral ADRs (lines ~302-358) | **Deferred to v0.5 opt-in** — only `templates/adr.template.md` ships in v0.4 (FORGE-92); full lifecycle lands in v0.5 (FORGE-93, FORGE-95) |
| §Feature 6 — Mid-flight roadmap mutation (lines ~361-410) | **Deferred to v0.5 opt-in** — only `/reconcile` ships in v0.4 (FORGE-100); `/amend-roadmap` lands in v0.5 (FORGE-101); `worktree-drift-guard` is dropped (FORGE-103 canceled) |
| §Acceptance criteria — Closed-loop drift contract bullet (line ~428) | **Deferred to v0.5** with the drift workflow |
| §Acceptance criteria — Precedence enforcement bullet (line ~430) | **Superseded** — replaced with authority-by-field (see below); no worker drift events in v0.4 |
| §Acceptance criteria — Resumable apply bullet (line ~431) | **Deferred to v0.5** with the `/update-spec --apply` journal |
| §Locked architectural decisions — Decision 10 (artifact precedence) | **Superseded** — replaced with authority-by-field (see below and CLAUDE.md) |
| §Locked architectural decisions — Decision 11 (ephemeral ADRs) | **Deferred to v0.5** — only template scaffold ships in v0.4 (FORGE-92) |
| §Precedence rules (lines ~540-573, 6-level chain) | **Superseded 2026-05-17 PM** — see §Authority by field below |
| Flow B `npx @firatcand/forge doctor [reports drift: @inherit pattern detected]` (line ~504) | **Rewritten** — v0.4 doctor scope is SPEC↔code only |

**Sections that stay as written:**

| Section | Status |
|---|---|
| §Problem, §Target user, §Per-feature breakdown (Features 1-4) | Unchanged |
| §Feature 3 init flow | Unchanged structurally; small annotation on `templates/adr.template.md` mention |
| §Feature 4 settings.yaml example | Unchanged structurally; comment line added above `decisions:` block (v0.5-only) |
| §Acceptance criteria (overall v-next), §Explicit non-goals | Unchanged except for the annotated bullets above |
| §Constraints, §User flows (cross-feature) | Unchanged except for Flow B doctor line |
| §Locked architectural decisions 1-9 | Unchanged |
| §Doctor enforcement (cleaned in FORGE-99) | Unchanged |

### Authority by field (replaces the 6-level precedence chain)

The 6-level linear precedence rule (`user > SPEC > PRD > phases > tracker > attempts`) is replaced with a matrix of ownership by concern. Authoritative version lives in [CLAUDE.md §Source of truth](../CLAUDE.md) and [SPEC §21](SPEC.md); short form:

| Artifact | Owns |
|---|---|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements. Durable design-time truth. |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria. |
| `plans/phases.yaml` | Local execution snapshot (derived from tracker; do not hand-edit). **Status and dependency fields drift between `/reconcile --pull` runs and must be confirmed against the tracker.** |
| Tracker issue body | **Live execution truth:** status, assignee, sequencing, blockers, ownership. |
| Source code | Implementation. |

**Workers ask "whose field is this?" not "which artifact ranks higher?"** No drift event, no `/update-spec --apply` propagation, no forge-mediated escalation in v0.4. SPEC changes flow through standard git (`git commit && git push`). Other engineers `git pull` and adapt their in-flight work.

**For status / readiness / dependency / blocker questions: always query the tracker directly** (`mcp__linear-server__get_issue`, `gh issue view`, `ntn`) — never grep `plans/phases.yaml`, which is a stale cache between `/reconcile --pull` runs. This rule lives canonically in [CLAUDE.md §Source of truth](../CLAUDE.md).

### Out of scope for v0.4 (re-listed for clarity)

- `/update-spec --draft` and `/update-spec --apply` skills
- `forge orchestrate apply-decision` verb + apply-journal
- `/amend-roadmap` skill + verb
- `forge orchestrate worktree-drift-guard` verb (FORGE-103 canceled — dropped, not deferred)
- Drift events, drift-routed questions, `QuestionIndex.drift_event_id`, `QuestionIndex.routing_hint`
- Section ownership tags (`<!-- forge:section affects=... -->`)
- Active worktree file-glob registry as architectural-safety gate
- `forge spec-push --affects` flag
- Forge-enforced PR review policy

The ADR template scaffold (`templates/adr.template.md`) does ship in v0.4 (FORGE-92) as preparation for the v0.5 lifecycle.

### Rationale (preserved from the original PM amendment prose)

**What changes vs the morning amendment below:**

- **Feature 5 (Drift workflow + ephemeral ADRs)** — **deferred to v0.5 opt-in.** No `/update-spec --draft`, no `/update-spec --apply`, no `apply-decision` verb in v0.4. SPEC changes flow through standard git (`git commit && git push`). Other engineers `git pull` and adapt their in-flight work. Forge does not mediate.
- **Feature 6 (Mid-flight roadmap mutation)** — **deferred to v0.5 opt-in.** No `/amend-roadmap`, no `worktree-drift-guard`. v0.4 uses direct tracker edit + `/reconcile --pull` for scope changes.
- **§Precedence rules** — the 6-level linear chain is replaced with **authority-by-field** (see table above).
- **No contradiction gate** on SPEC pushes. The morning's `/update-spec --apply` propagation and the briefly-considered `forge spec-push --affects` flag are both dropped. Forge provides mechanism (scaffold + dispatch + sync), not policy (review rituals, conflict resolution, PR enforcement). Team coordination is the team's responsibility.
- **`phases.yaml` becomes a derived snapshot** regenerated by `/reconcile --pull` from the tracker. Source-of-truth for execution scope is the tracker. phases.yaml carries a source metadata stanza (`tracker`, `synced_at`, `tracker_revision`, `spec_revision`); every command that reads it displays a freshness summary.
- **Spec files untracked from forge's own `.gitignore`** — they were git-ignored to keep them out of the published npm package. The correct control is `package.json#files` allowlist + a CI `npm pack` gate, not gitignore. Spec files are now committed and part of the shared source of truth across maintainers.
- **One small worker-side assist (informational only, not a gate):** workers stamp `spec_revision` at claim time. On resume, the dispatch skill prints "SPEC changed since you claimed this ticket — N commits affecting spec/" — the worker proceeds regardless; the dev decides what to do.

**The honest cost of this simplification (explicitly accepted):** a dev pushes "we now use async dispatch for billing events." Another dev mid-task on "invoice retry UI" doesn't connect the dots. Their work ships against the old assumption. Bug surfaces later. Mitigations are the **team's** responsibility (PR review, standup, Slack), not forge's. Forge's role is mechanism, not architectural governance.

**Why pull back:** Codex consults consistently expanded the surface (proposal-object lifecycle, section ownership tags, active worktree registry, revalidation gates, PR-policy modes). The user consistently chose simpler. The final position is: forge is a scaffolder + dispatcher + sync bridge. Symphony's positioning (pure scheduler; tracker is read-only input; spec is repo-owned policy) is a useful reference point — forge is slightly broader (spec lifecycle is in scope) but does not become a coordination engine.

---

## Amendments (2026-05-21 — CLAUDE.md methodology split + multi-agent root files)

Drafted in `spec/decisions/2026-05-21-claudemd-methodology-split.md` (in-flight design). Locked during user-led design session 2026-05-21. Lands across **FORGE-152** (Phase A), **FORGE-153** (Phase B), **FORGE-154** (Phase C); parent epic **FORGE-151**. Blocks all other Linear work until shipped.

**Why:** Today the `forge init` flow writes a single `CLAUDE.md` mixing product-owned rules with framework-owned methodology, and only Claude Code can read it. Codex and Gemini users have no in-context methodology. Roster (downstream Forge-built product) patched this manually; the refactor lifts the patch into Forge so every scaffolded repo gets the split natively.

### Sections in this PRD that change (read this amendment before trusting them)

| Section | Status |
|---|---|
| §Feature 3 — Init flow | **Amended** — adds multi-agent selection question (multi-select: Claude Code / Codex CLI / Gemini CLI); writes only the selected agent root files; writes `.forge/CONTEXT.md` + `.forge/.version`; emits `.gitignore` marker block. Default selection = user's currently-invoked agent. Inline edit lands in Phase A. |
| §Feature 4 — `.forge/settings.yaml` example | **Amended** — `agents` block gains `enabled_root_files: ['claude_code']` (default; multi-select at init expands the array). Inline edit lands in Phase A. |
| §Feature 4 — Cross-host parity | **Amended** — Codex/Gemini users get first-class methodology context via their respective root files (no longer Claude-only) |
| §Acceptance criteria — Init UX | **Amended** — new criterion: `forge init` produces tracked `CLAUDE.md`+`AGENTS.md`+`GEMINI.md` only for selected agents, plus tracked `.forge/settings.yaml`, gitignored `.forge/CONTEXT.md`+`.forge/.version`, `.gitignore` with forge-managed marker block |
| §New feature — `forge upgrade` | **Added** (Phase B / FORGE-153) — explicit re-sync verb; never auto-runs on `npm install`/`npm update`; refuses on user-edited `.forge/CONTEXT.md`; `--force` saves `.bak`; `--add-agent` / `--remove-agent` / `--dry-run` flags; CLI drift warning on every forge invocation when methodology version differs from bundled (`FORGE_QUIET=1` suppresses) |
| §New feature — Legacy migration | **Added** (Phase C / FORGE-154) — one-shot `forge upgrade --migrate-claudemd`; strict heading-by-heading SHA-256 match against pinned v0.4 fixture; bails to manual recipe on any drift; saves `CLAUDE.md.pre-migration.bak` on success |

### User-facing decisions (locked)

- **Forge methodology is gitignored, per-developer.** `.forge/CONTEXT.md` materializes when a dev runs `forge init` or `forge upgrade` in a repo. Not shared via git; not in the published npm package's runtime files; not visible to non-Forge collaborators. Methodology is a tool, not source code.
- **Each agent's root file is tracked.** Users see one of `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` (or several, if their team uses multiple agents). Product rules live here. A small marker-delimited prefix block at the top (managed by Forge) carries the breadcrumb + import directive to `.forge/CONTEXT.md`.
- **Breadcrumb for non-Claude tools.** Agents that don't follow the AGENTS.md / CLAUDE.md / GEMINI.md conventions (Cursor, Aider, future tools) read the marker block at the top of whichever root file they pick up — the breadcrumb tells them "this project uses Forge; install via `npm i -g @firatcand/forge && forge upgrade`."
- **`forge init` asks which agents to support.** Multi-select prompt. Default = the currently-invoking agent. Stored as `agents.enabled_root_files[]` in `.forge/settings.yaml` (tracked, project config).
- **Re-sync is explicit, never automatic.** `forge upgrade` requires user invocation. `npm install -g @firatcand/forge` only updates the binary, never touches the user's working tree.
- **Strict edit detection.** `forge upgrade` refuses to overwrite a `.forge/CONTEXT.md` that the user has edited (byte-diff against bundled). `--force` saves the edited copy to `.forge/CONTEXT.md.bak` before overwriting.
- **CLI drift warning.** Every forge command prints to stderr if local `.forge/.version` is older than bundled (one-line, suppressible via `FORGE_QUIET=1`).
- **Legacy migration is opt-in and reversible.** `forge upgrade --migrate-claudemd` runs once per repo; refuses if `.forge/CONTEXT.md` already exists; bails on any drift from a pinned v0.4 fixture and prints a manual recipe; saves `CLAUDE.md.pre-migration.bak`.

### Out of scope (in this amendment)

- Postinstall hooks that touch cwd at `npm install` time
- Auto-fetching forge from the GitHub link in the breadcrumb
- `forge downgrade` verb
- Per-repo methodology-version pinning (no consumer yet)

### Relationship to v0.5 ADR workflow

This refactor's own design lives at `spec/decisions/2026-05-21-claudemd-methodology-split.md` — the same `spec/decisions/` directory that the v0.5 `/update-spec --draft` skill (FORGE-93) will own. The split refactor uses the ADR location informally; the formal lifecycle (auto-propagation, ADR deletion) ships with v0.5. After Phase C lands, this ADR + its plan file will be manually deleted; SPEC.md amendment block + this PRD amendment block + the merge commits are the durable record.

---

## Amendments (2026-05-17 AM, simplified after Codex review + user pushback) — PARTIALLY SUPERSEDED, see PM amendment above

Surgical addition driven by [docs/plans/closed-loop-workflow-redesign.md](../docs/plans/closed-loop-workflow-redesign.md). The original PRD remains ~75% intact; this amendment adds:

- **Feature 5** — Drift workflow + **ephemeral ADRs** (`spec/decisions/` as staging area; `/update-spec --draft` + `/update-spec --apply`; ADR file is DELETED after successful apply, rationale preserved in commit message; `forge orchestrate doctor` for SPEC↔code drift)
- **Feature 6** — Mid-flight roadmap mutation (`/amend-roadmap`, `/reconcile`, worktree drift guard)
- **§Precedence rules** — binding contract for artifact authority when SPEC/PRD/phases.yaml/tracker disagree (6 levels; no ADR layer because ADRs are ephemeral)

Light edits to Features 2/3/4, ACs, Flow A, and Locked decisions integrate the new closed-loop primitives.

**Dropped from the 2026-05-17 first-draft** (user pushback + Codex review concluded the value didn't justify the complexity):

- Workflow-stage state machine + `.forge/workflow/state.json`
- `suggest-next`, `session-check`, `intent-detect` verbs
- SessionStart / Stop / UserPromptSubmit host hooks
- ADR append-only convention (replaced with ephemeral)

**Rationale for the drops:** the existing skill-end nudges + `/pickup-task` + `forge orchestrate status` cover session re-grounding. Host hooks added moving parts without solving a real problem in the one-session-one-task workflow. Ephemeral ADRs preserve the staging value of formal decision drafting while keeping SPEC as the sole source of truth.

## Completed pre-PRD work (this iteration)

The following ships before the rest of v-next and is **already in the working tree** (uncommitted at PRD draft time):

- `/forge` skill refactored — 4 product questions, dropped philosophical framing
- `/draft-prd` skill refactored — adds per-feature discovery loop
- `/draft-design` skill rewritten — project-owned vs reference-external; `@inherit` removed
- BRIEF / PRD / DESIGN templates refactored
- README updated; `.gitignore` updated for dogfooding artifacts

This PRD specs the **remaining four features** that complete v-next.

---

## Problem

Solo developers using Claude Code hit four concrete walls:

1. **Spec drift.** Defining product specifications inside the coding agent is hard, so users context-switch to claude.ai → broken context between thinking and execution.
2. **Agent inertia.** Without a kanban-style surface, agents lose momentum across sessions; each session restarts cold.
3. **AI slop.** Combined effect is products that drift from what was envisioned — features half-done, decisions undocumented, structure improvised.
4. **Artifact drift (added 2026-05-17).** Even with a structured spec→decompose→track pipeline, mid-flight architectural decisions live only in tracker issue bodies; PRD, SPEC, and phases.yaml ossify. Agents reading the canonical artifacts cold build the wrong mental model. Forge's own dogfooding surfaced this: two of our learnings literally contradict each other on which artifact wins when SPEC and tracker disagree.

Forge wraps the coding agent with a structured discovery → spec → decompose → track → execute → drift-aware sync pipeline that **never forces the user to leave the coding agent**, pushes all task state into their existing tracker for observability, and keeps local artifacts deterministic so agents never read a stale mental model.

## Target user

**Persona:** Solo developers and small teams already using Claude Code (or Codex CLI / Cursor / Gemini CLI). They have an idea worth building. Not seeking validation — seeking structure and delivery quality.

**JTBD:** *When I have a product idea and want to ship it with a coding agent, I want a lightweight framework that turns my plan into a spec, decomposes it into trackable phases, and orchestrates parallel agents — so I can stay in the coding agent and watch progress in my task tracker without switching contexts.*

---

## Per-feature breakdown

### Feature 1: Multi-tool task tracker

**What it does**
Pluggable abstraction over external task trackers. v-next supports **Linear, GitHub Issues, and Notion**. Pushes phases/tasks/state, reads claim status, writes back updates. Adapter interface so future trackers can be added without forge core changes.

**User flow**
1. During `forge init`, user picks tracker (Linear / GitHub Issues / Notion)
2. CLI verifies required tooling (Linear MCP, `gh` CLI, or Notion API key)
3. After `/decompose` generates `phases.yaml`, `/push-to-tracker` (renamed from `/push-to-linear`) creates project/cycles/issues in chosen tracker
4. `/reconcile --pull` pulls state changes back into local `phases.yaml`
5. `/pickup-task` and orchestrator claim issues from the tracker

**Acceptance criteria**
- [ ] User selects tracker at `forge init`: Linear, GitHub Issues, or Notion
- [ ] `phases.yaml` structure pushes to chosen tracker without information loss
- [ ] Dependency relations preserve (`depends_on` → tracker's "blocks" relation)
- [ ] State sync round-trip: tracker → forge → tracker without divergence
- [ ] Adapter interface published as `lib/trackers/<name>.js` so future trackers can be added by dropping a file
- [ ] Each adapter implements: `listActiveIssues()`, `claim(id, runId)`, `releaseClaim(id)`, `updateState(id, state)`, `createIssue(payload)`, `createProject(name)`, `setBlockedBy(id, blockerId)`, `updateIssueBody(id, body)` (added 2026-05-17 for `/update-spec --apply` + `/reconcile` propagation)
- [ ] **Authority by field** (clarified 2026-05-17 PM, supersedes the 2026-05-17 AM "tracker body is a projection" framing): tracker body owns **live execution metadata** (assignee, status, sequencing, blockers, ownership); `plans/phases.yaml` is a **local snapshot** derived from the tracker via `/reconcile --pull`. Status / readiness / dependency questions MUST query the tracker directly (`mcp__linear-server__get_issue`, `gh issue view`, `ntn`) — `phases.yaml` is a stale cache between `/reconcile --pull` runs. See §Amendments (PM) above and [CLAUDE.md §Source of truth](../CLAUDE.md) for the full matrix.

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| Tracker auth failure | Surface error to user; do not silently retry |
| Tracker rate limit hit | Exponential backoff per Symphony pattern; log clearly |
| Mid-pipeline tracker switch | Not supported in v-next; documented limitation |
| Required tooling missing (Linear MCP, `gh` CLI) | Init prompts to install; offers manual continue |
| Tracker schema mismatch (custom states) | Map to closest standard state; warn user |

**Non-goals (this feature)**
- Two-way real-time sync (poll-based is sufficient)
- Forge creating tracker accounts on user's behalf
- Cross-tracker migration of pre-existing issues
- Notion / Trello / Jira / Asana adapters (deferred to v-next+1)

---

### Feature 2: Symphony-style parallel agent orchestrator

**What it does**
A `/forge orchestrate` skill that runs in the user's interactive Claude Code or Codex main session and dispatches host-native subagent workers into isolated git worktrees, one per ready task in the dependency graph. State is owned by the `forge` CLI control plane (lease-backed local truth + per-adapter tracker CAS for cross-run rendezvous). Caps concurrency at `subagent_cap_per_main` per main session, surfaces architectural questions from workers back to the user, retries on failure with exponential backoff.

**Per the suggest-don't-force principle (binding):** the skill calls read-only `forge orchestrate phases --ready` to find ready tasks, presents them with rationale for user approval; only after user confirmation does it call `forge orchestrate claim` and `forge orchestrate dispatch`. No silent claiming, no silent mutation. Workers read `spec/SPEC.md` for the current architecture (no separate ADR hydration — ephemeral ADRs propagate into SPEC at apply time).

**Two truths, two mechanisms (clarified 2026-05-17 PM, supersedes the AM phases.yaml-canonical framing):** *task ownership truth* is lease + tracker CAS (which worker is allowed to write to a given task right now). *Roadmap truth* — what tasks exist, their dependencies, their current status — lives in the **tracker**; `plans/phases.yaml` is a local snapshot regenerated by `/reconcile --pull`. Workers read `phases.yaml` at claim time for acceptance criteria and SPEC §refs (the parts the tracker doesn't carry); live execution state (assignee, status, blockers) is queried directly from the tracker, never grepped from `phases.yaml`. See §Amendments (PM) above and [CLAUDE.md §Source of truth](../CLAUDE.md) for the full authority matrix.

**User flow**
1. User opens Claude Code (or Codex) in their project and invokes `/forge orchestrate` — **this invocation is the explicit user approval to begin a run**; skill calls `forge orchestrate run start` (mutates run state, allowed because run-level approval just happened)
2. Skill calls `forge orchestrate phases --ready --run <run-id> --json` (read-only) to list ready tasks (deps shipped + merged + no worktree overlap); presents them with rationale; user picks one or "all"; skill then calls `forge orchestrate claim` per selected task (atomic via tracker CAS)
3. For each claimed task: skill calls `forge orchestrate dispatch <claim_id>` (refuses without a valid claim_id from step 2); spawns a Task-tool subagent (Claude) or native subagent (Codex) with the worker prompt template (worker reads `spec/SPEC.md` + `plans/phases.yaml` task body + `CLAUDE.md` for conventions; no ADR hydration needed since SPEC is already authoritative)
4. Subagent works inside the worktree: heartbeats every 5 min, escalates architectural decisions via `forge orchestrate question`, writes a verdict via `forge orchestrate complete` when done
5. Skill surfaces any open questions to the user, records the answer via `forge orchestrate answer`, and re-dispatches a fresh subagent that picks up the prior worker's worktree state
6. After IMPLEMENT verdict verified, skill dispatches a REVIEW subagent in the secondary host; after REVIEW passes, a SHIP subagent opens the PR (only when all `depends_on` PRs are merged to base)
7. After `agents.retry_attempts` failures, notifies user, marks issue `failed`, moves to next ready task
8. To stop: user simply closes the main session. To cancel a specific task: `forge orchestrate cancel <task-id>`. Recovery on next session via `forge orchestrate gc`.

**Acceptance criteria**
- [ ] Subagent cap respected per main (default `agents.subagent_cap_per_main: 3`); multiple mains coexist via lease-backed coordination
- [ ] Tasks with unmerged dependencies are **never** dispatched to SHIP
- [ ] Each task gets a deterministic worktree path; collision-safe sanitization
- [ ] Failures retry with exponential backoff (1s base, capped at `agents.retry_backoff_ms_max`, default 5min — Symphony pattern)
- [ ] After max retries, user is notified AND tracker comment posted on the issue
- [ ] Closing the main session does not leave orphan state — `forge orchestrate gc` reconciles on next invocation
- [ ] Survives transient tracker outages (CLI logs + skill retries next tick)
- [ ] Settings change → next CLI invocation reflects it (no separate reload mechanism)
- [ ] Workers bill against the user's interactive Claude / ChatGPT Plus subscription — never Agent SDK quota or API credits

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| Worker subagent crashes mid-task | Lease eventually expires; `gc` marks attempt `abandoned`; worktree state preserved for next attempt |
| Two mains on same project | Lease enforces at-most-one-worker-per-task; tracker is rendezvous (Linear strong CAS, GitHub/Notion race-detect) |
| Issue removed from tracker mid-flight | Worker's next CLI call detects tracker divergence; `gc` releases lease and archives attempt |
| Worktree path collision | Append hash; if still collision → fail closed with error |
| Worker silent >`lease_ttl_ms` (default 30 min) | Lease becomes steal-eligible; `forge orchestrate phases --ready` from any main surfaces the steal-eligible task; user-approved `claim` + `dispatch` proceeds with fresh attempt |
| Question unanswered >`question_timeout_ms` | Attempt marked `expired`; tracker comment posted; resumable when user later runs `forge orchestrate answer` |
| Cap reduced (10→3) via hot-reload | Drain 7 oldest workers gracefully; do not kill |
| Disk full | Pause dispatch; surface error |
| Network outage to tracker | Pause poll loop; resume on reconnect |

**Non-goals (this feature)**
- Cross-machine orchestration (single-machine only)
- Agents sharing intermediate artifacts (independent worktrees only — Symphony pattern)
- Auto-merge to main (user merges PRs through GitHub UI)
- Built-in dashboard / web UI (use the tracker's existing UI)
- Coordination beyond dependency graph (no agent-to-agent comms)

---

### Feature 3: Init flow

**What it does**
Interactive CLI Q&A during `npx @firatcand/forge init [name]` that captures project context, tool choices, and writes `.forge/settings.yaml` + scaffolds project structure (`spec/`, `plans/tasks/`, `.gitignore`, per-agent root files, `CRITICAL.md`, `.forge/CONTEXT.md`, `.forge/.version`).

**User flow**
1. User runs `npx @firatcand/forge init [project-name]` from a clean directory
2. CLI prompts (sequential, all optional with sensible defaults):
   - Project name (default: directory name)
   - One-line description
   - High-level goal / what you're building (free text, multi-line)
   - Task tracker — Linear / GitHub Issues / Notion (default: GitHub Issues)
   - Primary coding agent CLI — Claude Code / Codex CLI / Gemini CLI (default: Claude Code; Cursor was dropped per FORGE-88 — no runtime adapter ever shipped)
   - Secondary coding agent CLI for adversarial review — Codex CLI / Gemini CLI / disabled (default: Codex when primary is Claude, else Codex)
   - **Which agent root files to write (FORGE-152)** — multi-select for CLAUDE.md / AGENTS.md / GEMINI.md. The primary host CLI is pre-checked; user can add others so teammates on those agents have a tracked root file with the methodology breadcrumb. Validator: must include primary.
   - GitHub connected? — yes / no (if yes, validates `gh auth status`)
   - Secret manager — `.env` file [default] / 1Password / AWS Secrets / Doppler / Infisical
   - Concurrent subagent cap per main session (default 3, max 10)
   - Retry attempts (default 10)
3. CLI verifies required tooling for chosen tracker AND chosen primary/secondary agent CLIs:
   - Linear → checks for Linear MCP server
   - GitHub Issues → checks for `gh` CLI authenticated
   - Notion → asks for API key, validates
   - Coding agents → checks for `claude --version`, `codex --version`, etc.
4. CLI scaffolds project files using `templates/`:
   - BRIEF/PRD/SPEC/DESIGN/CRITICAL templates pre-placed in `spec/`
   - `templates/adr.template.md` ships in v0.4 for v0.5 prep (the `/update-spec --draft` skill itself is deferred to v0.5, see Feature 5)
   - **Per-agent root files (FORGE-152):** one tracked root file per selected agent — CLAUDE.md (with native `@.forge/CONTEXT.md` import + first-run approval-dialog callout), AGENTS.md (Codex prose-directive form), GEMINI.md (mirrors AGENTS). Each carries a forge-managed marker block at the top; product content below is user-owned.
   - **`.forge/CONTEXT.md` (FORGE-152):** tool-agnostic methodology doc rendered from `templates/CONTEXT.template.md` + bundled CLI registry. Gitignored after step 6 but materialized at init so the first agent session has methodology immediately.
   - **`.forge/.version` (FORGE-152):** forge's package.json version, stamped for Phase B's drift-warning pre-hook.
5. CLI writes `.forge/settings.yaml` with all answers (including `agents.enabled_root_files`)
6. CLI adds the forge-managed marker block to `.gitignore`: `/.forge/*` with `!/.forge/settings.yaml` exception. Block is shared with Phase B's `forge upgrade` for drift-free round-trip; idempotent on re-run; user-curated rules outside the markers are preserved.
7. CLI prints clear next-step instructions: *"Run `claude` and then `/forge` to start the discovery interview. Run `/status-check` any time to see project state."* For Claude Code users, the banner notes the one-time `@.forge/CONTEXT.md` approval prompt on first session — must accept it or the methodology context is silently skipped.

**Acceptance criteria**
- [ ] Init completes in <30 seconds end-to-end (excludes external tooling validation; see next bullet)
- [ ] External validations (tracker auth, `gh auth status`, `claude --version`) run concurrently via `Promise.all` and complete before scaffold; total init time stays under 30s p95. Non-interactive mode treats failures as `unverified[]` rather than aborting init. *(Note: an earlier draft of this AC required streaming "returns control immediately" UX; FORGE-108 closed this as deliberate scope-cut — current parallel-then-await design already delivers the performance intent and avoids a post-scaffold callback surface that would touch five modules for a UX nicety on a sub-5s operation.)*
- [ ] All defaults work without user input (Enter through every prompt → valid project)
- [ ] `.forge/settings.yaml` validates against schema before write
- [ ] Existing files are not overwritten silently — prompt for confirmation
- [ ] Re-running init in an already-init'd project offers `--reconfigure` flow that preserves user content
- [ ] Init refuses to run inside a forge-framework checkout (detects `package.json` with `name: @firatcand/forge`) to prevent dogfooding accidents
- [ ] Cross-host: same init flow works whether installed for Claude Code, Codex CLI, Cursor, or Gemini CLI

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| Missing prerequisite (no Linear MCP, no `gh` CLI) | Prompt to install with link; offer "skip and configure later" |
| Project name collides with existing dir | Ask to overwrite, rename, or abort |
| Network down during tooling validation | Fall back to local-only init; mark settings as unverified |
| User cancels mid-flow (Ctrl-C) | No partial state written; existing files untouched |
| Permission denied writing to dir | Surface error, exit cleanly |

**Non-goals (this feature)**
- Web-based init UI
- Importing from existing PRD/spec docs (deferred)
- Multi-project workspaces / monorepo init
- Auto-creation of GitHub repo / Linear project (that's `/setup-repo` and `/push-to-tracker` later)

---

### Feature 4: `.forge/settings.yaml`

**What it does**
Single source of truth for project-level forge configuration: tracker choice, secret manager, orchestrator parameters, design mode. Declarative YAML, schema-validated, hot-reloadable.

**Schema (v1)**
```yaml
version: 1
project:
  name: <string>
  description: <string>
tracker:
  type: linear | github | notion
  config:
    # tracker-specific (Linear team_id, GitHub repo, Notion workspace)
secrets:
  manager: env_file | 1password | aws_secrets | doppler | infisical
  env_file_path: ./.env.local       # only when manager = env_file
agents:
  primary_host_cli: claude          # claude | codex | gemini  (cursor dropped FORGE-88)
  review_host_cli: codex            # codex | gemini | null  (must differ from primary; null disables REVIEW)
  enabled_root_files:               # FORGE-152: which agent root files init writes
    - claude                        # → CLAUDE.md
    # - codex                       # → AGENTS.md  (add for Codex-on-the-team)
    # - gemini                      # → GEMINI.md  (add for Gemini-on-the-team)
  subagent_cap_per_main: 3          # cap on parallel subagents per main session
  lease_ttl_ms: 1800000             # 30 min; heartbeat every 5 min, steal after expiry
  heartbeat_interval_ms: 300000
  steal_grace_ms: 300000
  retry_attempts: 10
  retry_backoff_ms_max: 300000      # 5 min cap
  question_timeout_ms: 1800000
  question_max_attempts: 3
  worktree_root: ./.forge/worktrees
  branch_strategy: merge-to-main
  on_persistent_failure: notify     # notify | block_task | move_to_next
  # preflight_globs and hard_lock_globs default lists — see SPEC.md
design:
  mode: project_owned | reference_external
  reference: <url-or-path>          # only when mode = reference_external
# Added 2026-05-17 (closed-loop workflow control — minimal surface after dropping Feature 7)
codex:
  auto_codex_enabled: true          # auto-suggest /second-opinion at /plan-task exit, ADR draft, pre-/ship (settings field keeps the `codex` name in v0.4; rename deferred to v0.5)
  auto_codex_token_cap: 50000       # max tokens per session for auto-codex (0 disables)
# decisions: — v0.5 only (no v0.4 consumer; block reserved in schema for forward compatibility)
decisions:
  decision_dir: ./spec/decisions    # where draft ADRs live (ephemeral; deleted on --apply) [v0.5]
  stale_draft_threshold_days: 7     # doctor warns about drafts older than this [v0.5]
doctor:
  spec_code_check_enabled: true     # grep SPEC for symbols, check src/ for hits
```

**User flow**
1. Settings file written by `forge init`
2. User can hand-edit any time
3. Every `forge` CLI invocation re-reads + validates settings on entry (no separate reload mechanism)
4. CLI flag overrides per-command: `forge orchestrate phases --ready --limit 1` (read-only display cap; `--limit` never auto-claims), env-var overrides via `FORGE_*` (see SPEC.md "Environment variables")

**Acceptance criteria**
- [ ] Schema validation on every CLI invocation with helpful error messages (`agents.subagent_cap_per_main must be a positive integer`)
- [ ] Defaults applied for any missing key (no required keys outside `version` and `project`)
- [ ] Settings changes take effect on the next CLI call (no daemon to reload)
- [ ] CLI flag overrides take precedence over file values for the current invocation
- [ ] Settings file lives at `.forge/settings.yaml`; gitignored by default in init flow's scaffolded `.gitignore`

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| Invalid YAML syntax | Orchestrator pauses dispatch; surfaces parse error; keeps prior in-memory config |
| Schema violation | Reject change; keep prior config; log violation |
| Concurrent reload while dispatching | Quiesce dispatch, reload, resume |
| File deleted while orchestrator running | Treat as "unchanged"; orchestrator continues with last loaded |
| Required tracker config missing | Refuse to start orchestrator; surface "tracker.config incomplete" |

**Non-goals (this feature)**
- TOML / JSON / TypeScript config formats
- Encryption of settings.yaml itself (secrets routed through `secrets.manager`)
- GUI editor
- Per-environment settings (no `settings.production.yaml` — use env vars or branching)

---

### Feature 5: Drift workflow + ephemeral ADRs (added 2026-05-17 — deferred to v0.5)

> **Deferred to v0.5.** — Feature 5 (drift workflow + ephemeral ADRs) does not ship in v0.4. Only the template scaffold at `templates/adr.template.md` ships in v0.4 (FORGE-92) as preparation. The `/update-spec --draft` and `--apply` skills, the `apply-decision` verb, the apply-journal, and `worktree-drift-guard` all land in v0.5 (FORGE-93, FORGE-95, FORGE-101). The full feature description below is preserved as v0.5 design reference. See §Amendments (PM) above and SPEC §21 for the rationale.

**What it does (v0.5 design intent)**
Surfaces, formalizes, and propagates mid-flight architectural decisions so all artifacts stay in sync. `spec/decisions/` is a **staging area** for in-flight decisions, NOT a permanent record. Three coordinated primitives, collapsed into a single user-facing skill:

- **`/update-spec --draft`** — opens a new ADR draft at `spec/decisions/<date>-<slug>.md` (MADR-shaped frontmatter for structure). User reviews + optionally consults the configured second-opinion reviewer via auto-suggested `/second-opinion review-decision`. User marks `status: accepted` in frontmatter when ready.
- **`/update-spec --apply <slug>`** — propagates the accepted ADR's change to SPEC + PRD § + phases.yaml task amendments + tracker issue body updates atomically (with per-artifact diff preview), writes the full ADR content (decision + alternatives + consequences) into the propagation commit message body, then **DELETES the ADR file**. After successful apply, `spec/decisions/` is empty until the next decision.
- **`forge orchestrate doctor`** verb — read-only diagnostic that flags drift between SPEC↔code (symbols SPEC references that no longer exist in src/). Exit codes per SPEC §Precedence rules.

**Why ephemeral ADRs:** SPEC is the sole source of truth at all times. ADR files exist only during the "drafted-but-not-yet-applied" window. After `/update-spec --apply`, the SPEC reflects the decision; the rationale lives in `git log -- spec/SPEC.md`. No accumulation. No worker-side ADR hydration needed (workers just read SPEC). No "temporary drift between accepted ADR and SPEC" caveat in precedence rules.

**User flow**
1. Mid-build, user realizes architecture needs to change (e.g., "switching public API from REST to GraphQL")
2. User runs `/update-spec --draft` — skill prompts for title, context, decision summary, alternatives considered, affected_spec_sections, affected_tasks
3. ADR template written to `spec/decisions/<date>-<slug>.md` with frontmatter (`id`, `date`, `status: proposed`, `affected_spec_sections`, `affected_tasks`) and structured body sections
4. (Auto-suggested) User runs `/second-opinion review-decision` against the draft for adversarial input
5. User edits the draft to incorporate feedback, manually flips frontmatter to `status: accepted`
6. User runs `/update-spec --apply <slug>` — skill propagates the change with per-artifact diff preview:
   - Edits SPEC § marked as affected
   - Edits PRD § marked as affected
   - Amends phases.yaml task acceptance criteria where referenced
   - Updates tracker issue bodies via `updateIssueBody()` with rescope notes
   - Writes the full ADR content into the propagation commit message body
   - Deletes `spec/decisions/<date>-<slug>.md`
7. `forge orchestrate worktree-drift-guard` (invoked automatically by `--apply`) flags active worktrees whose tasks touched the affected sections (writes drift events + questions to those workers)
8. `forge orchestrate doctor` returns 0; cold-read of SPEC/PRD/phases.yaml matches reality

**Acceptance criteria**
- [ ] ADR template at `templates/adr.template.md` with frontmatter and structured body sections (Context, Decision, Consequences, Alternatives)
- [ ] `/update-spec --draft` refuses if `spec/decisions/` already has an unaccepted ADR (one decision at a time)
- [ ] `/update-spec --apply <slug>` refuses if ADR `status != accepted`
- [ ] `--apply` shows diff per artifact before applying; user confirms each independently (or `--yes-all`)
- [ ] `--apply` is resumable via `--resume` flag (uses journal at `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`) — partial tracker push failures recoverable without re-applying local edits
- [ ] `--apply` writes the full ADR content (Context + Decision + Alternatives + Consequences) as the commit message body of the propagation commit
- [ ] `--apply` DELETES the ADR file from `spec/decisions/` on success
- [ ] `--apply` invokes `worktree-drift-guard` automatically (with `--dry-run` available for preview)
- [ ] `forge orchestrate doctor` exits non-zero when SPEC references symbols not in `src/`
- [ ] Worker subagents detect drift (precedence violation per §Precedence rules) and emit drift events instead of silently fixing

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| `--draft` invoked while another draft exists in `spec/decisions/` | Refuse; suggest user finishes existing draft via `--apply` or deletes it manually |
| ADR `status: proposed`, `--apply` invoked | Refuse; require `status: accepted` first |
| `--apply` mid-tracker-edit fails network on issue #43 (3 of 7 issues updated) | Journal records `pending` for #43; local edits already done; user runs `--apply <slug> --resume`; skill skips applied entries, retries pending |
| ADR file deleted manually before `--apply` runs | `--apply` refuses; no ghost decisions |
| User manually flips frontmatter `proposed → accepted` without review | Allowed; the workflow is suggestion-not-enforcement |
| Two concurrent `/update-spec --apply` calls (different ADRs) | Each writes its own journal file under unique slug; no shared state, no race |

**Non-goals (this feature)**
- Permanent ADR archive (use `git log -- spec/SPEC.md` for rationale history)
- Auto-generating ADRs from code changes (always human-authored)
- Cross-tracker ADR linking (Linear ↔ GitHub ↔ Notion bodies)
- NLP-based detection of "rescope" markers in tracker bodies
- Backfilling ADRs for past architectural shifts (separate effort)
- ADR supersedes chains (irrelevant when ADRs are ephemeral — git history shows succession)

---

### Feature 6: Mid-flight roadmap mutation (added 2026-05-17 — deferred to v0.5 except /reconcile)

> **Deferred to v0.5.** — Feature 6 (/amend-roadmap + worktree-drift-guard) does not ship in v0.4. `/reconcile` DOES ship in v0.4 via FORGE-100 (it's part of the v0.4 surface, just specced here alongside the v0.5 primitives). `/amend-roadmap` lands in v0.5 (FORGE-101). `worktree-drift-guard` is dropped — FORGE-103 was canceled per the §21 pivot. The full feature description below is preserved as v0.5 design reference. See §Amendments (PM) above and SPEC §21 for the rationale.

**What it does (v0.5 design intent; /reconcile already lives in v0.4)**
First-class skills to mutate the roadmap mid-build without violating the artifact-precedence contract:

- **`/amend-roadmap`** *(v0.5)* — create new tasks mid-flight; updates phases.yaml AND pushes to tracker with dependency edges in one atomic step (rolls back both on failure)
- **`/reconcile`** *(v0.4 — FORGE-100)* (replaces `/sync-status --write` from earlier drafts) — bi-directional sync between phases.yaml and tracker; resolves divergence with conflict detection; `--pull` reads tracker → phases.yaml, `--push` reverse
- **Worktree drift guard** *(dropped — FORGE-103 canceled)* (`forge orchestrate worktree-drift-guard`) — when SPEC/phases changes affect an active task's worktree, flag for rebase or restart; preserves worktree state under `.forge/orchestrator/legacy/` on restart; `--dry-run` available for preview (Codex I1)

**User flow**

*Amend roadmap (mid-build new idea):*
1. User: "I realized we need a caching layer task; create it as P2.5-T19, depends on T05"
2. `/amend-roadmap` prompts for: title, description, type, ACs, deps, est, owner_type
3. Skill writes to phases.yaml AND pushes to tracker AND sets blocked_by relations (all-or-nothing)
4. Returns new tracker ID for reference

*Reconcile (sync drift):*
1. User: "I added a story directly in Linear; pull it into phases.yaml"
2. `/reconcile --pull` reads tracker, detects new issues + status changes not in phases.yaml
3. Shows diff (added / removed / changed fields); user confirms each
4. `/reconcile --push` reverse direction (rarely needed; phases.yaml is canonical)

*Worktree drift guard:*
1. User runs `/update-spec --apply <slug>` while two worktrees are active on tasks in the affected SPEC section
2. Guard flags both worktrees: "task T07 worktree depends on §X which just changed; rebase or restart?"
3. User chooses; for restart, worktree is preserved under `.forge/orchestrator/legacy/`. Targets worktrees in `running`, `blocked_on_question`, `awaiting_respawn`, or `ready_for_review` states (not `dispatched` or terminal — Codex I3).

**Acceptance criteria**
- [ ] `/amend-roadmap` writes phases.yaml + tracker atomically (rollback both if either fails)
- [ ] New task gets stable `task_id` (e.g., P2.5-T<next>); preserves existing IDs
- [ ] `/reconcile --pull` round-trip: tracker → phases.yaml → tracker preserves all fields without loss
- [ ] Conflict detection: same task edited in both places → user resolves before write
- [ ] Worktree drift guard runs after every `/update-spec --apply` and `/amend-roadmap` mutation
- [ ] Guard suggests `/pickup-task --restart <id>` for restart, or `git rebase` snippet for in-place rebase

**Edge cases / failure modes**
| Edge case | Expected behavior |
|---|---|
| `/amend-roadmap` mid-tracker-push fails | Local phases.yaml change rolled back; user re-runs |
| Task ID collision (rare) | Detect, suggest next available ID |
| `/reconcile` detects task deleted in tracker but present in phases.yaml | Ask user: archive locally or recreate in tracker |
| Worktree is dirty when drift guard fires | Guard refuses restart; suggests commit/stash first |
| Cross-tracker reconcile attempted (tracker switch mid-project) | Refuse; out of scope per Feature 1 non-goals |

**Non-goals (this feature)**
- Live tracker watching (poll-only)
- Auto-amend when tracker shows scope creep (always user-initiated)
- Cross-project reconciliation
- Conflict-free merge of concurrent edits (last-writer-wins with explicit user resolution)

---

## Acceptance criteria (overall v-next)

End-to-end criteria that prove v-next ships:

- [ ] **Greenfield path:** Brand-new user runs `npx @firatcand/forge init`, then `claude` → `/forge` → `/draft-prd` → `/draft-spec` → `/draft-design` → `/decompose` → `/push-to-tracker` → `forge orchestrate` and ends with shipped PRs on a real product. Total time-to-first-shipped-task ≤ 2 hours including thinking.
- [ ] **Tracker portability:** Same flow works on Linear, GitHub Issues, and Notion. Sample project succeeds on each.
- [ ] **Orchestrator under load:** 10 parallel agents on a sample 30-task `phases.yaml` complete without deadlock, race condition, or worktree collision.
- [ ] **Refactor compatibility:** Existing forge users on `@inherit` pattern get a clear migration message in CHANGELOG; `/draft-design` detects the old pattern and offers automatic conversion.
- [ ] **Cross-host parity:** All four features work identically across Claude Code, Codex CLI, Cursor, Gemini CLI (where the host supports the underlying primitives).
- [ ] **Engineering hygiene (guardrails):**
  - npm package size ≤ 1MB unpacked
  - `npx @firatcand/forge --version` runs in <500ms
  - No new top-level npm dependencies beyond what's in v0.2.1 (lightweight discipline)
  - All four features covered by tests in `examples/` end-to-end harness
- [ ] **Closed-loop drift contract (added 2026-05-17 — *deferred to v0.5*, see §Amendments PM):** Mid-flight architectural change drafted via `/update-spec --draft`, accepted, applied via `/update-spec --apply <slug>` propagates to SPEC + PRD + phases.yaml + tracker bodies atomically; ADR file is deleted; rationale lands in commit message body. `forge orchestrate doctor` returns 0 after. *(v0.4: SPEC changes flow through standard git; doctor scope is SPEC↔code only.)*
- [ ] **Suggest-don't-force (added 2026-05-17, simplified):** No CLI verb silently claims, dispatches, or mutates roadmap. All mutation flows through user-approved skills. Read-only verbs (`status`, `questions`, `doctor`, `phases`, `attach`) emit no side effects beyond their own log line.
- [ ] **Authority by field (replaces "precedence enforcement" — superseded 2026-05-17 PM):** When two artifacts disagree, workers ask "whose field is this?" and follow ownership-by-concern (SPEC owns architecture; PRD owns product behavior; tracker owns execution state; phases.yaml is a derived snapshot). No drift events, no automated propagation in v0.4. See §Amendments PM above and [CLAUDE.md §Source of truth](../CLAUDE.md).
- [ ] **Resumable apply (added 2026-05-17 per Codex C2 — *deferred to v0.5*):** `/update-spec --apply <slug>` is resumable via `--resume`; partial tracker push failures don't destroy local edits; journal at `.forge/orchestrator/global/update-spec-apply-journal/<slug>.json`. *(v0.4 has no apply verb; deferred to v0.5 with the rest of the drift workflow.)*

## Explicit non-goals (v-next)

(Carrying forward all from BRIEF, plus PRD-level additions)

- Forge does not own a model, runtime, server, or SaaS
- Forge does not replace Linear / GitHub Issues / Notion
- Forge does not support non-coding workflows
- Forge does not question the user's idea, feature set, or tech stack
- Forge does not measure delivery success via north-star metrics or kill criteria
- Forge does not inherit a maintainer-global brand book (no `@inherit`)
- Forge does not build a parallel-agent runtime from scratch (adapt Symphony's pattern)
- **PRD-additions:**
  - No cross-machine orchestration
  - No agent-to-agent communication beyond dependency graph
  - No web UI / dashboard
  - No auto-merge of PRs
  - No automatic tracker switching mid-pipeline
  - No support for non-`@firatcand/forge` install paths (i.e. no `git clone` adoption flow)

## Constraints

- **Cross-host requirement:** Same skills/agents/templates must work on Claude Code, Codex CLI, Cursor, Gemini CLI (with host-specific invocation patterns acknowledged in README).
- **Lightweight discipline:** No daemons. No server. Forge CLI commands are stateless and on-demand; the dispatch skill runs inside the user's main session as a thin layer. No new runtime dependencies beyond v0.2.1's `@inquirer/prompts`, `chalk`, `fs-extra`, plus `yaml`, `zod`, `execa`.
- **Stack-agnostic:** Works for Next.js, Django, Rails, Go, Rust, Elixir — no opinionated framework defaults.
- **Node ≥ 18** (per `package.json` engines field).
- **Backward compatibility:** Existing forge v0.2.1 users get a documented migration path. Breaking changes only in `/draft-design` (`@inherit` deletion) and `/push-to-linear` rename → `/push-to-tracker` (with deprecation alias for one minor version).
- **Tracker-agnostic data:** `phases.yaml` schema is the canonical *local* derived representation; tracker bodies are the source of live execution state (see §Authority by field in §Amendments PM and [CLAUDE.md §Source of truth](../CLAUDE.md)). No tracker-specific fields in core data model — adapters serialize to/from a tracker-neutral `phases.yaml` shape.
- **Public-API discipline:** Any change to the npm package or globally-installed skills is a public-API change — versioned and documented in `CHANGELOG.md`.

## User flows (cross-feature)

### Flow A: Greenfield project, end-to-end
```
npx @firatcand/forge init my-product   [init flow; no host hooks installed]
cd my-product
claude                                 [normal Claude Code launch]
> /forge                               [4 product questions → BRIEF.md; ends with "next: /draft-prd"]
> /draft-prd                           [per-feature loop → PRD.md; ends with "next: /draft-spec"]
> /draft-spec                          [delegates to founder-skills software-architect → SPEC.md]
> /draft-design                        [project-owned vs reference → DESIGN.md]
> /ingest-spec                         [validation → CONTEXT.md]
> /decompose                           [phases.yaml]
> /setup-repo                          [GitHub repo + branch protection]
> /push-to-tracker                     [creates tracker issues]
> /pickup-task                         [claims one ready task atomically, creates worktree]
# OR
> /forge orchestrate                   [presents ready tasks via phases --ready; user approves; workers ship PRs]

# ─── v0.5 design intent below (deferred — see Feature 5/6 + §Amendments PM) ───
# v0.4: SPEC changes flow through standard git (`git commit && git push`);
# scope changes go via direct tracker edit + `/reconcile --pull`.
# Mid-flight: worker detects an architectural shift it can't resolve under §Precedence rules
> /update-spec --draft                 [v0.5 — drafts ADR in spec/decisions/<date>-<slug>.md]
# (auto-suggested) /second-opinion review-decision against the draft       [v0.5]
# Review feedback; edit draft; flip frontmatter status: accepted
> /update-spec --apply <slug>          [v0.5 — propagates to SPEC + PRD § + phases.yaml + tracker bodies
                                        atomically; writes rationale to commit message;
                                        DELETES the ADR file; invokes worktree-drift-guard]
# Worktree drift guard flags affected workers; user chooses rebase or restart [v0.5]
> /forge orchestrate                   [resumes; affected workers rebase or restart against new SPEC]

# Mid-flight: user has a new idea that adds scope
> /amend-roadmap                       [v0.5 — creates new task in phases.yaml AND tracker atomically]

# After all tasks ship
> /reconcile --pull                    [optional: pulls any tracker-side edits back into phases.yaml]

# Any time during a session: explicit re-grounding
> /status-check                        [dashboard: active workers, ready tasks, open questions]
```

### Flow B: Existing forge v0.2.1 project upgrading to v-next
```
npm install @firatcand/forge@latest
npx @firatcand/forge doctor             [reports SPEC↔code drift if any — v0.4 doctor scope]
npx @firatcand/forge migrate            [proposes DESIGN.md conversion (@inherit pattern → project-owned), alias for /push-to-tracker]
# review diff, accept
forge orchestrate                       [resume work in new orchestrator]
```

### Flow C: Single-task pickup (manual, no orchestrator)
```
claude
> /pickup-task                         [claims next ready issue from tracker]
> /plan-task → /implement → /ship      [normal flow]
```

---

## Locked architectural decisions

(Resolved before /draft-spec — carry forward as constraints, not open questions.)

1. **Orchestrator runtime model (revised 2026-05-14):** CLI-as-control-plane + skill-as-dispatch. No long-running daemon. The `forge` CLI owns durable state (state machine, leases, atomic file ops, tracker CAS, gc); the `/forge orchestrate` skill runs in the user's main session and drives dispatch via CLI commands. See `ORCHESTRATOR.md` "Changes from v1" for the rationale.
2. **Worker process model (revised 2026-05-14):** Host-native subagents. Workers are Claude Code Task-tool subagents or Codex native subagents dispatched from the user's interactive main session. Billing is the user's subscription (interactive Claude / ChatGPT Plus); forge never spawns headless host CLIs (`claude -p`, `codex exec`) and never touches provider API keys or Agent SDK quota. Tracker adapters still use `execa` for `gh` / `git` / secret-manager CLIs.
3. **Settings loading:** Every CLI invocation re-reads `.forge/settings.yaml`. No long-running process to reload into. Changes take effect on the next CLI call (i.e., next dispatch-loop iteration in the skill, which polls the CLI every tick).
4. **Default concurrent agents:** 3 subagents per main session (`agents.subagent_cap_per_main`). Multiple mains coexist via lease-backed coordination (`lease_ttl_ms` default 30 min, heartbeat, steal-after-expiry). User can change at init or by editing settings.yaml.
5. **GitHub Issues adapter:** Hard dependency on `gh` CLI. Init flow validates `gh auth status`; if missing, offers `brew install gh` link and skip-and-configure-later flow. No direct GitHub REST/GraphQL fallback in v-next.
6. **Install model:** Three install paths supported equally:
   - `npm install -g @firatcand/forge` → global `forge` binary on PATH
   - `npx @firatcand/forge ...` → ad-hoc, no global install required
   - `npm install --save-dev @firatcand/forge` → per-project install
7. **Migration for v0.2.1 users:** `forge migrate` does best-effort auto-convert with diff preview. Detects `@inherit` lines in existing DESIGN.md and proposes project-owned replacement; provides `/push-to-linear` → `/push-to-tracker` deprecation alias for one minor version.
8. **Tracker adapter interface:** Responsibilities listed in Feature 1 (`listActiveIssues`, `claim`, `releaseClaim`, `updateState`, `createIssue`, `createProject`, `setBlockedBy`). Formal typed interface signatures defer to /draft-spec. Extended 2026-05-17 with `updateIssueBody(id, body)` for `/update-spec --apply` and `/reconcile` propagation.
9. **Suggest-don't-force (added 2026-05-17, simplified):** Skills present ready work via skill-end nudges and `/pickup-task`; user always approves before any state mutation. CLI verbs are split into read-only (`status`, `questions`, `doctor`, `phases`, `attach`) and user-approved mutate (everything else). No verb may straddle the boundary. No session-start hooks installed (sole-user workflow doesn't need automated re-grounding; explicit `/status-check` covers it).
10. ~~**Artifact precedence (added 2026-05-17, simplified):** When two artifacts disagree, agents follow: user instruction > SPEC > PRD > phases.yaml > tracker body > older attempts.~~ **Superseded 2026-05-17 PM** — replaced with **authority by field** (see §Amendments PM above and [CLAUDE.md §Source of truth](../CLAUDE.md)). Each artifact owns specific concerns; there is no linear ranking. The original 6-level prose below remains as reasoning trail, NOT as binding rule.

    *Original superseded text:* When two artifacts disagree, agents follow: user instruction > SPEC > PRD > phases.yaml > tracker body > older attempts. Tracker body is a **projection** of phases.yaml, not equal authority. Workers MUST emit drift events rather than silently fix higher-precedence artifacts. See §Precedence rules. Ephemeral ADRs are NOT in the precedence chain (they're transient staging artifacts; SPEC IS truth post-apply).
11. **Ephemeral ADRs (added 2026-05-17 — *deferred to v0.5*):** Only `templates/adr.template.md` ships in v0.4 (FORGE-92) as preparation. The full lifecycle described below — `/update-spec --draft`, optional `/second-opinion review-decision`, `--apply` propagation, ADR-file-deleted-on-success, commit-message-as-rationale — lands in v0.5 (FORGE-93, FORGE-95). In v0.4, architectural decisions are propagated to SPEC via standard `git commit && git push`; the rationale history lives in `git log -- spec/SPEC.md`.

    *v0.5 design intent (preserved as reference):* Architectural decisions are formalized via `/update-spec --draft` (writes a staging file to `spec/decisions/`), reviewed (optionally with `/second-opinion review-decision`), accepted (user flips frontmatter), then propagated to SPEC + PRD + phases + tracker via `/update-spec --apply <slug>`. The propagation DELETES the ADR file on success; the rationale (Context + Decision + Alternatives + Consequences) goes into the apply-commit's message body. SPEC is the sole durable source of truth; `git log -- spec/SPEC.md` is the rationale history.

---

## Precedence rules (superseded 2026-05-17 PM — see §Authority by field in §Amendments above)

> **Superseded 2026-05-17 PM.** — the 6-level precedence chain described in this section is no longer the v0.4 contract. v0.4 uses **authority by field** (see §Amendments PM at the top of this file and [CLAUDE.md §Source of truth](../CLAUDE.md)). The original prose is preserved as reasoning trail. The mutation-paths table and drift-event flow describe v0.5 design intent that lands with FORGE-93/95.

When two artifacts disagree, agents and skills MUST follow this order:

1. **Current user instruction** (in active session) — highest. *Session/recency rule:* the active session's instruction wins; persisted contradictory instructions from an older session must be formalized as a SPEC / PRD / phases change via `/update-spec --draft` + `/update-spec --apply`, otherwise they are treated as attempt notes (lowest precedence).
2. **`spec/SPEC.md`** — current architectural snapshot (sole source of truth; ADRs propagate INTO this and then disappear)
3. **`spec/PRD.md`** — current product requirements snapshot
4. **`plans/phases.yaml`** — canonical execution scope and per-task ACs. Tracker issue bodies are a **projection** of phases.yaml (kept in sync by `/push-to-tracker` initial sync + `/reconcile --push` updates). When phases.yaml and tracker disagree, phases.yaml wins unless the user invokes `/reconcile --pull` to explicitly pull tracker-side edits back.
5. **Tracker issue body** — projection of (4); authoritative only when (4) is silent on a field the tracker has authoritative knowledge of (e.g., live human comments, assignee changes)
6. **Older attempt notes** — lowest

**Note on ephemeral ADRs and precedence (added 2026-05-17):** ADR files in `spec/decisions/` are NOT in the precedence chain because they are ephemeral. A draft ADR has no authority (it's a proposal); an accepted-but-not-yet-applied ADR is an in-flight operation, not a durable artifact. The workflow guarantees convergence: `/update-spec --draft` writes a staging file, user accepts it, `/update-spec --apply` propagates to SPEC (now level 2) and deletes the file. The drafted-but-unapplied window is one user session; the precedence chain handles only persistent artifacts.

### When lower disagrees with higher

The worker MUST NOT silently "fix" the discrepancy. It:

1. Emits a drift event via `forge orchestrate event --type drift --from <artifact> --to <artifact>`
2. Writes a question via `forge orchestrate question` requesting routing decision
3. Pauses the attempt with state `blocked_on_question`
4. Supervisor routes through one of:
   - `/update-spec --draft` then `--apply` (formalize the architectural change → propagates to SPEC + PRD + phases + tracker; ephemeral ADR deleted)
   - `/amend-roadmap` (formalize new scope → updates phases.yaml + tracker)
   - Answer the question with "lower is right; update higher" (manual edit + commit + worker resumes)

### Only mutation paths to higher-precedence artifacts

| Mutation | Path | Refuses without |
|---|---|---|
| ADR draft (staging) | `/update-spec --draft` | another draft already exists in `spec/decisions/` |
| SPEC + PRD + phases + tracker (propagation) | `/update-spec --apply <slug>` | ADR `status: accepted` in frontmatter |
| phases.yaml mid-flight (new task) | `/amend-roadmap` | none |
| Tracker body via reconcile | `/reconcile --push` | local change exists |
| phases.yaml from tracker | `/reconcile --pull` | tracker has changes phases.yaml doesn't |

### Doctor enforcement

v0.4 contract: `forge orchestrate doctor` is a read-only diagnostic that checks SPEC↔code drift only — for each TypeScript path under `src/` mentioned in `spec/SPEC.md`, `spec/PRD.md`, or `spec/ORCHESTRATOR.md`, doctor asserts the file exists under `repoRoot`. Honors `settings.doctor.spec_code_check_enabled` (default `true`).

Scopes: `--scope spec-code` (default), `--scope all` (alias for `spec-code` until v0.5). Legacy `--scope adr-drafts` and `--scope apply-journal` were dropped per SPEC §21 and now return INVALID_ARGS.

Exit codes: 0 = clean, 1 = warnings (e.g. required `spec/SPEC.md` is missing), 2 = drift detected.

The broader doctor scopes — stale ADR draft warnings, pending `--apply` journal warnings, phases.yaml↔tracker drift — are deferred to v0.5 alongside the ADR template (P2.5-T01) and apply-decision verb (P2.5-T04). When those land, this section will document the additional checks.
