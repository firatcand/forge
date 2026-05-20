---
name: codex
description: DEPRECATED — alias for /second-opinion. Removed in v0.5.0. Use /second-opinion instead; it dispatches to whichever reviewer (Codex or Gemini) is configured in `.forge/settings.yaml` agents.review_host_cli.
tools: Read
---

# /codex — DEPRECATED

This skill was renamed to **`/second-opinion`** in v0.4.x (FORGE-89, P2-T21).

The new name is host-agnostic. `/codex` was misleading because forge can dispatch second-opinion review to either Codex *or* Gemini depending on `settings.agents.review_host_cli`. The skill behavior, prompt construction, and verdict shape are unchanged — only the canonical name moved.

## What to do

Invoke `/second-opinion` with the same prompt you would have given `/codex`. The skill body, prompt-construction guidance, evaluation discipline, and integration with `/ship` and `/review` are all preserved under the new name.

## Removal

This alias is removed in **v0.5.0**. Update any hooks, scripts, or documentation that reference `/codex` to use `/second-opinion` before upgrading.
