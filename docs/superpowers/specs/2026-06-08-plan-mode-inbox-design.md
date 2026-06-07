# Plan-Mode Enforcement + Parked-Decision Inbox — Design

**Date:** 2026-06-08
**Repo:** forge (public-API)
**Tickets:** FORGE-194 (T1), FORGE-195 (T2), FORGE-196 (T3), FORGE-197 (T4) — "I0.5" foundation under Autopilot epic FORGE-183
**Status:** Approved (this session). Pre-build foundation docs.

---

## 1. Origin

Started from a concrete complaint: *"while planning a task, `/plan-task` doesn't automatically spin a subagent or turn the session into plan mode — so planning isn't actually read-only."* `skills/plan-task/SKILL.md:37-38` only *describes* "enter Plan mode" / "delegate to a subagent" in prose — nothing enforces it.

The discussion widened to: how does this fit the Autopilot roadmap (the `/loop` + `/goal` + `Workflow` automation, FORGE-183–192), and — once decisions can be *parked* for the human — how does the human notice and answer them without breaking the daemon-free, subscription-only constraints?

## 2. The two halves

**A — Enforced read-only planning.** `/plan-task` enters the host's **native** read-only mode (Claude Plan Mode via `EnterPlanMode`; Codex `--sandbox read-only`), researches read-only, surfaces architectural forks to the user via `AskUserQuestion`, and ends with the native approval card. **Hybrid model:** the main session owns the forks (HITL, never delegated) + approval; read-only subagents do the heavy reading/drafting.

**B — Parked-decision inbox.** A read verb `forge orchestrate inbox --json` lists `blocked_on_question` tasks + open questions tagged by `classification`; a `/inbox` skill drains them (digest → pick → deep-dive → `answer`); a display-only `statusLine` badge shows the count.

## 3. Key decisions (and why)

| # | Decision | Why |
|---|----------|-----|
| Enforcement = **native host mode, not a Forge hook** | `spec/SPEC.md:989,1001` deliberately dropped host hooks as too fragile across host versions. Claude Plan Mode already hard-blocks edits while active; Codex read-only sandbox does the same. No new fragility. |
| **Hybrid**, not full-subagent planning | A subagent cannot call `AskUserQuestion` — it can't reach the user. HITL on architectural forks is non-negotiable, so decisions + approval stay in the main session; subagents only do read-only research. |
| Inbox = **status badge + `/inbox`**, everything else cut | Chosen for simplicity over tracker-comment remote-answering, a decision-artifact spine, Slack, and OS push. Each was designed and explicitly deferred. |
| **statusLine only** for host-settings | A status line is display-only — it cannot block or alter execution, so it dodges the behavioral-hook fragility the SPEC retired. Documented as an explicit allowed exception (`spec/SPEC.md` §Plan-mode enforcement). |
| **Commands, not prose**, if remote answering is ever added | Codex second opinion: never put an LLM parser in the authorization boundary — a remote reply must be a structured command (`forge answer <id> approve`), not free-form text an LLM interprets. (Deferred with the rest of remote answering.) |

## 4. Rejected / deferred (designed, not built)
- Tracker-comment remote answering (poll comments → `answer`) — needs creds, cursor/authz, intent-parsing; deferred.
- Decision-artifact spine (`.forge/decisions/<id>.md` as canonical) — Codex's suggestion; good, but more than v1 needs.
- Slack relay / OS push — Slack relay risks the daemon-free constraint.
- PreToolUse hard-lock hook — conflicts with the SPEC's no-hooks decision.
- The autonomous watcher loop itself — that's FORGE-190 (I4); this feature is its foundation.

## 5. Fit with Autopilot
"I0.5" foundation: **T1 blocks FORGE-190** (the unattended planner can't run without enforced read-only planning); **T2/T3 are reused by FORGE-190** as its plan-approval-queue drain surface; **T2 shares `collectTasksByState` with FORGE-185** (review-queue). It does not block I1/I2/I3. It is **also standalone-useful today** in interactive `/plan-task` and for answering any parked question — that dual nature is why it's built now rather than folded into FORGE-190.

## 6. Constraints honored
- Daemon-free (no background process; the badge/inbox are pull/display only).
- Subscription-only billing (no `claude -p`; `codex exec` is fine).
- Tracker-agnostic; skill↔verb contract (skills never write orchestrator state directly).
- HITL on architecture is non-negotiable and structurally preserved.

## 7. Implementation
See the approved plan and tickets FORGE-194–197 for files, reuse points, and the test matrix. Caches (`.forge/CONTEXT.md`, `plans/phases.yaml`) regenerate via `forge upgrade` / `reconcile --pull` once the verbs/skills are registered — not hand-edited.
