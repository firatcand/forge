# Examples

The `examples/` directory ships with one reference walkthrough: **time-logger**. It's a small CLI for logging context-switches across projects, and exists primarily to demonstrate forge's lifecycle artifacts in their natural habitat.

Future examples will land here as we ship them — each one chosen to demonstrate a different stack, domain, or scope.

---

## time-logger

A solo-founder CLI for logging time across projects. Local SQLite, no network, no team features.

### Why this example

- Small enough to read in one sitting (~50 lines of YAML for `phases.yaml`)
- Real enough to be representative — it has a phase split, dependencies, real acceptance criteria
- CLI-only, so it shows the lifecycle without DESIGN.md noise
- Maintained by the forge author so it stays in sync with the framework

### Files

- [examples/time-logger/spec/BRIEF.md](../examples/time-logger/spec/BRIEF.md) — what `/forge` produces from a one-sentence pitch
- [examples/time-logger/spec/PRD.md](../examples/time-logger/spec/PRD.md) — what `/draft-prd` produces from BRIEF
- [examples/time-logger/spec/SPEC.md](../examples/time-logger/spec/SPEC.md) — what `/draft-spec` produces from PRD
- [examples/time-logger/plans/phases.yaml](../examples/time-logger/plans/phases.yaml) — what `/decompose` produces from the spec

### What `/setup-repo` would output for this project

```
[1/11] Verifying gh CLI authentication... ✓
[2/11] Creating repo firatcand/time-logger (private)... ✓
[3/11] Initial commit on main... ✓
[4/11] Branch dev from main... ✓
[5/11] Branch protection on main: require PR review (1), test status check, no direct push, no force push... ✓
[6/11] Branch protection on dev: require PR review (1), test status check... ✓
[7/11] GitHub Environment: development (auto-deploy)... ✓
[8/11] GitHub Environment: production (manual approval)... ✓
[9/11] Copying CI workflows: claude-issue.yml, claude-pr-review.yml, test.yml, claude-scheduled.yml... ✓
[10/11] Generating .env.example from SPEC env vars (TL_HOME, TL_NOW, NO_COLOR, TL_DEBUG)... ✓
[11/11] Setting CLAUDE_CODE_OAUTH_TOKEN secret... ✓

✓ Repo wired: https://github.com/firatcand/time-logger
```

### What `/push-to-tracker` would output (Linear-configured project)

```
✓ Linear MCP server registered
✓ Created project: time-logger
✓ Created cycle: Phase 1: Foundations
  ✓ TLOG-101  P1-T01  Bootstrap Node + TypeScript project
  ✓ TLOG-102  P1-T02  SQLite schema + migration runner
  ✓ TLOG-103  P1-T03  Implement `tl init <project>` command
  ✓ TLOG-104  P1-T04  Implement `tl <project> [note]` happy path
  ✓ TLOG-105  P1-T05  GitHub Actions CI workflow
✓ Created cycle: Phase 2: Core Features (status: blocked, blocked_by: phase-1)
  ✓ TLOG-201  P2-T01  Implement `tl status`
  ✓ TLOG-202  P2-T02  Implement `tl report` (last 7 days)
  ...
✓ Created cycle: Phase 3: Polish & Launch (status: blocked, blocked_by: phase-2)
  ...
✓ Set blocks: TLOG-102 → TLOG-103, TLOG-103 → TLOG-104, TLOG-104 → TLOG-202, TLOG-104 → TLOG-204, TLOG-103 → TLOG-205, TLOG-104 → TLOG-206

Manual step required:
  1. Open Linear → Settings → Integrations → GitHub
  2. Connect repo: firatcand/time-logger
  3. Map to project: time-logger
  4. Enable: branch-name auto-link, PR-status sync

✓ phases.yaml updated with `source` block (tracker, project_id, synced_at, spec_revision) and per-task tracker_issue_id (plus legacy linear_* aliases through v0.3.x)
```

### Walking the lifecycle

To dogfood forge against this example, after install:

```bash
mkdir ~/repos/time-logger && cd ~/repos/time-logger
git init
forge init
cp ~/.forge/examples/time-logger/spec/* spec/
cp ~/.forge/examples/time-logger/plans/phases.yaml plans/
claude
> /ingest-spec        # validates the spec we copied in
> /setup-repo         # wires up GitHub
> /push-to-tracker    # creates tracker project + issues (Linear cycles, GH milestone, or Notion db row per tracker.type)
> /pickup-task        # claims TLOG-101, creates worktree
```

From there it's the standard task loop: `/plan-task`, `/implement`, `/review`, `/qa`, `/ship`, `/learn`.

The example stops at `phases.yaml` because the actual implementation is what `/pickup-task → /implement` should do for you. The point of forge is that the work after the spec is generated, not hand-written.

---

## Future examples (planned)

These will be added as they're built and dogfooded:

- **shadcn-app**: a Next.js + Supabase web app, demonstrates DESIGN.md, brand-book inheritance, multi-track frontend/backend tasks
- **rails-api**: a Rails JSON API, demonstrates that forge isn't Node-only
- **monorepo-pkg**: a multi-package npm workspace, demonstrates `/decompose` handling nested module dependencies

Want to contribute an example? See [CONTRIBUTING.md](../CONTRIBUTING.md). Examples that demonstrate a stack or domain not yet covered are especially welcome.
