# Forge Autopilot — Design Spec

> **Status: DRAFT — AWAITING USER APPROVAL.** Not committed, not implemented.
> Architecture/scope decisions in this doc are the user's to approve or redline.
> Working name "Forge Autopilot" is a placeholder pending the user's naming call.

**Date:** 2026-06-07
**Repo:** forge (public-API — every change ships to `npm` and lands on adopters)
**Origin:** Brainstorm on using Claude Code `/loop` + `/workflows` + `/goal` with Forge to make engineering work *less hands-on* and *more always-running*, while keeping architecture/design decisions human-in-the-loop (HITL) and looping both Claude and Codex to review plans and implementations.

---

## 1. Goal

A continuously-running, plan-gated autonomous pipeline that drives Forge tickets from "ready" to "merged" with a single human gate — plan approval — where the user's architecture and design control lives. Everything mechanical (implementation, test-fixing, review nits, merge) runs unattended. The user's footprint shrinks to: draining a plan-approval queue, and answering the occasional architecture question.

### Success criteria
- The user touches the keyboard only to (a) approve/redline parked plans and (b) answer escalated architecture questions.
- No code change reaches `main` without both Claude and Codex review passing.
- No architectural or design decision is made autonomously — these always route to the user.
- The system keeps running across transient API failures (529, output-token-max) without losing in-flight work.

---

## 2. Decisions log (resolved during brainstorm)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Where does the system stop for the user? | **Plan approval + architecture forks** | Architecture is decided at the planning stage; gating the plan gives full architecture control with one touch per ticket. |
| D2 | How do tickets reach the gate? | **Swarm + async plan-approval queue** (serial mode as a stepping stone) | The loop keeps feeding work to the gate; the gate is async so the user is never the pacing bottleneck. Reconciles "always-running" with "architecture HITL." |
| D3 | Worker execution model | **In-session subagents (Workflow) by default**; separate-process workers opt-in | In-session subagents run under the interactive subscription (no metered drain) and provide the parallel fan-out natively. Separate processes are an opt-in scale/resilience mode. |
| D4 | Behavior on test failure / reviewer rejection | **Bounded self-heal (≤3 rounds) then escalate**; architecture-smell escapes immediately to the user | Matches the user's TDD discipline; the cap prevents runaway token spend; the architecture escape hatch preserves HITL during implementation. |
| D5 | Reviewer composition | **Claude reviews everything; Codex (`/second-opinion`) on `CRITICAL.md` paths; both must approve to merge** | Existing Forge convention; minimal change. |
| D6 | Where the system lives | **Build as a first-class Forge feature now** (public-API) | User's call. It is Forge's core mission (structured agentic development); neither Claude Code nor Codex ships this opinionated pipeline. |

### Landscape findings that shaped the design
- **Claude Code** provides the deterministic multi-agent fan-out engine (`Workflow`): ~16 concurrent agents, worktree isolation, checkpoint/resume (`resume-from-runId`), background execution with completion notifications. This is the orchestration substrate.
- **Codex CLI** (v0.137.0) is a clean *worker*, not an orchestrator: `codex exec --json --output-schema -a never` is fully scriptable and unattended; `codex mcp-server` exposes it as an MCP server. But it has **no scriptable review command** (only a TUI-only `/review`), **no framework-level fan-out**, and **no built-in self-heal-until-green loop**. → Codex is the review/implement worker, invoked via `codex exec`.
- **Billing reality (verified 2026-06-06):** Today `claude -p` bills as API usage regardless of auth (known bug). From **June 15, 2026**, `claude -p` / Agent SDK / GitHub Actions move to a separate metered "Agent SDK credit" pool ($20 Pro / $100 Max 5x / $200 Max 20x, no rollover, full API rates). Interactive sessions stay on subscription. → In-session subagents (D3 default) run under subscription; separate-process mode is metered and should require an explicit `ANTHROPIC_API_KEY` + opt-in. *(Caveat: not in first-party changelog yet; re-confirm before June 15.)*

---

## 3. Pipeline shape

```
[watcher /loop] → ready ticket → claim → /plan-task
      → DUAL-REVIEW plan (Claude + Codex)
      → ⏸ PARK in approval queue ──────── USER drains async (approve / redline / reject)
            approved ↓
      → /implement test-first
      → bounded self-heal loop (≤3 rounds: run → diagnose → fix)
      → DUAL-REVIEW impl (Claude always + Codex on CRITICAL.md)
      → overlap-gate + rebase-on-drift → AUTO-MERGE → capture learning
            architecture smell at ANY point → ⏸ back to USER queue as a question
```

---

## 4. Components (each one unit, one responsibility)

| Unit | Responsibility | Built on | Interface |
|------|----------------|----------|-----------|
| **Watcher** | `/loop` polls the tracker for ready, non-colliding tickets and feeds the queue. Surface-only — never claims-to-decide, never merges. | `forge orchestrate phases --ready` | reads tracker; writes queue entries |
| **Planner stage** | Claim ticket → `/plan-task` → dual-review the *plan* → park plan in queue with summary + review notes. | `claim`, `dispatch` verbs | consumes ready ticket → produces parked plan |
| **Approval queue** | Durable store of parked plans + escalated questions; the user drains it via a skill (approve / redline / reject). The single HITL gate. | new `queue` verb + skill (owns UX) | user-facing |
| **Executor** | On approved plan: `/implement` test-first → self-heal loop → dual-review impl → merge. Runs as a Workflow fan-out (default) or separate process (opt-in). | Workflow; FORGE-148 executors | consumes approved plan → produces merged PR |
| **Review worker** | Scriptable second-opinion: `codex exec --json --output-schema -a never` wrapper emitting a structured `ReviewVerdict`; plus the Claude reviewer. Reused for both plan and impl review. | extends `/second-opinion` / `second-opinion` verb | diff/plan in → verdict out |
| **Merge / overlap gate** | Serialize colliding PRs, rebase-on-drift, re-run gates, then merge. | FORGE-170 overlap gate | gates merge |
| **Resilience layer** | Per-stage checkpoint; lease-expiry detection; `/loop` resumes from last checkpoint after a 529; backoff. | Workflow `resume-from-runId`; lease/heartbeat | wraps all stages |
| **Architecture classifier** | Decides whether a reviewer objection or implementation blocker is *architectural/design* (→ escalate to user) vs *mechanical* (→ self-heal). Conservative: escalate when unsure. | new (fuzziest unit) | classifies → routes |

---

## 5. Fit with Forge architecture

Honors the **skill ↔ verb contract**:
- **Skills own UX:** the watcher's surfacing, the approval-queue drain prompts, the architecture-question prompts. Skills never mutate orchestrator state directly.
- **Verbs own state transitions:** new verbs (`queue`, `approve-plan`, `auto-merge`) + existing (`claim`, `dispatch`, `heartbeat`, `question`, `complete`). Every state change goes through a verb, so the whole pipeline is testable as state-machine transitions in isolation.

Hard dependency: **FORGE-148 orchestrator executors** (still pending) for the Executor unit (P1+).

---

## 6. Generalization (public-API requirements)

- **Tracker-agnostic:** ready-detection and status via the existing reconcile layer (Linear / GitHub / Notion). No tracker-specific logic in the pipeline.
- **Review-host-agnostic:** the second opinion uses `agents.review_host_cli` (codex | gemini). Codex is the default worker, not a hardcoded dependency.
- **Execution mode as a setting:**
  - **Default — in-session subagents** (Workflow): subscription-billed, no metered drain.
  - **Opt-in — separate-process workers** (`claude -p` / SDK): cross-process resilience/scale; requires explicit `ANTHROPIC_API_KEY` + opt-in flag; the feature warns before using metered mode.

---

## 7. Cost model

- Default mode = subscription (in-session).
- Metered mode (separate processes) requires explicit API key + opt-in; the feature surfaces the June-15 Agent SDK credit-pool reality before enabling it.
- Any capped or dropped work (self-heal round limit hit, queue overflow, parallelism cap) is `log()`-surfaced — **no silent truncation.**

---

## 8. Phasing (decomposition — too large for one spec/PR)

| Phase | Ships | Why this order |
|-------|-------|----------------|
| **P0** | Scriptable review-worker atom: `second-opinion` verb → `codex exec --json` structured `ReviewVerdict` + Claude reviewer. | Smallest reusable piece; everything depends on it; useful standalone. |
| **P1** | Single-ticket autonomous pipeline, serial, in-session (plan → approve → implement → self-heal → dual-review → merge). | Proves the full shape end-to-end on one ticket before adding scale. |
| **P2** | Watcher + plan-approval queue (always-running swarm-with-queue). | Adds "always-running" once the pipeline is trusted. |
| **P3** | Parallelism + overlap-gate serialization + checkpoint/resume resilience. | Adds scale + 529-survival. |
| **P4** *(later)* | Separate-process worker mode (API-key swarm). | Only if one session is outgrown. |

Each phase is its own spec → plan → implementation cycle and likely its own Linear ticket(s).

---

## 9. Testing

- Each new verb's state transitions unit-tested in isolation (Forge convention).
- Every acceptance-criterion run as a *failing* test against live code before close (AC-as-unit-test).
- A `--dry-run` pipeline mode that plans + reviews but does not merge, for safe end-to-end validation.

---

## 10. Risks & open questions

- **Architecture classifier (P1)** is the fuzziest unit; start conservative (escalate when unsure) and tune from real escalations.
- **Stale plans** in the queue may need a re-plan if `main` drifts before the user approves (P2 handles via rebase-on-drift + re-review).
- **FORGE-148 executors** are a hard prerequisite for P1+; sequence accordingly.
- **Billing policy** for headless/metered mode should be re-confirmed against Anthropic's first-party changelog before relying on separate-process mode (D3/§7).
- **Open — user's calls pending:** (a) approve the overall shape; (b) confirm or adjust the P0→P4 phasing; (c) set the real name.

---

## 11. Next step

On user approval: turn this into an implementation plan (Forge-native path: `/draft-spec` → `/decompose` into phased Linear tickets, starting with P0). Until approved, this doc is a draft and nothing is built.
