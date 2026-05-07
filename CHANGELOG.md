# Changelog

All notable changes to forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and forge adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-05-07

Initial public release.

### Added

- **21 skills** covering the full product lifecycle:
  - Ideation: `/forge`, `/draft-prd`, `/draft-spec`, `/draft-design`, `/ingest-spec`, `/decompose`
  - Setup: `/setup-repo`, `/push-to-linear`, `/sync-status`
  - Per-task loop: `/pickup-task`, `/plan-task`, `/implement`, `/investigate`, `/fix`
  - Quality gates: `/review`, `/qa`, `/codex`, `/ship`
  - Compound: `/learn`, `/phase-gate`, `/retro`
- **12 subagents**: product-decomposer, linear-syncer, frontend-dev, backend-dev, db-architect, qa-engineer, code-reviewer, security-auditor, phase-gatekeeper, learning-curator, devops-engineer, design-reviewer
- **13 templates**: BRIEF, PRD, SPEC, DESIGN, phases.yaml, CLAUDE.project, CRITICAL, learning, retro, plus 4 GitHub Actions workflows
- **8 enforced principles** (see ETHOS.md): Boil the Lake, Iron Law of Investigation, Confusion Protocol, Test-or-die, Compound Learning, Multi-model Second Opinion, Plan Mode Mandatory, 12-Factor Env Discipline
- **Linear ↔ GitHub native sync** via branch-name and PR-title conventions
- **Git worktree-based parallelism** for multiple Claude Code sessions on one repo
- **`@inherit` pattern** for brand-book / design-system reuse across projects
- **`forge` CLI** with `init`, `templates`, `upgrade`, `version` subcommands
- **`setup.sh`** installer that symlinks skills/agents into `~/.claude/`
- **time-logger example** demonstrating end-to-end lifecycle (BRIEF → PRD → SPEC → phases.yaml)

### Notes

- Stack-agnostic: Next.js, Django, Rails, Go, anything.
- macOS-targeted; Linux compatibility likely but not yet validated.
- Codex CLI integration assumes Codex is installed and authenticated separately.
