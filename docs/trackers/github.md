# GitHub tracker

`tracker.type: github` — issues live in the same GitHub repo as your code. No external SaaS.

## How it works

- Adapter: `GitHubTracker` (`src/trackers/github.ts`), shipped in FORGE-15.
- Transport: `gh` CLI. Requires `gh auth login` on the host.
- Project → GitHub Milestone (`createProject` returns `{ id: milestoneNumber, url: html_url }`).
- Issue body carries forge metadata via HTML-comment footers: `<!-- forge:task=P1-T01 -->`, `<!-- forge:ownerType=backend-dev -->`, and `<!-- forge:blockedBy=12,15 -->` for dependencies.
- Claim labels: `claimed:agent-{agentId}` (used by the orchestrator).

## Config

```yaml
tracker:
  type: github
  config:
    repo: owner/name
```

A deeper deep-dive (label conventions, claim race semantics, body-footer parser contract) is coming — for now read the source at `src/trackers/github.ts` and the FORGE-15 PR description.
