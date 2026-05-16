# GitHub tracker

`tracker.type: github` — issues live in the same GitHub repo as your code. No external SaaS.

## How it works

- Adapter: `GitHubTracker` (`src/trackers/github.ts`), shipped in FORGE-15.
- Transport: `gh` CLI. Requires `gh auth login` on the host.
- Project → GitHub Milestone (`createProject` returns `{ id: milestoneNumber, url: html_url }`).
- Issue body carries forge metadata via HTML-comment footers: `<!-- forge:task=P1-T01 -->`, `<!-- forge:ownerType=backend-dev -->`, and `<!-- forge:blockedBy=12,15 -->` for dependencies.
- Claim labels: `forge:claimed-by:{runId}` (used by the orchestrator) — the second component is the v2 orchestrator `runId` (UUIDv7). Weak label-CAS + verify-on-readback semantics; see [`docs/adapters/github.md`](../adapters/github.md) for the full deep-dive.

## Config

```yaml
tracker:
  type: github
  config:
    repo: owner/name
```

Full deep-dive (claim semantics, state mapping, error classification, auth runbook, limitations): [`docs/adapters/github.md`](../adapters/github.md).
