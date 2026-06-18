# Files requiring multi-model review (/second-opinion auto-triggers on /ship)
#
# Edit this list to match your project's critical paths.
#
# Note (forge-internal): this list still includes adopter-template defaults
# from the scaffold (auth/billing/prisma/supabase). Those don't exist in
# this repo and are kept as a reference for adopter projects. The forge-
# internal critical paths below are what /second-opinion actually triggers on.

# ─── forge internal critical paths ───────────────────────────────────────────

# Tracker adapters — atomic-claim primitives + subprocess/SDK boundary.
# Per learning docs/learnings/2026-Q2/codex-on-security-paths-even-when-critical-md-stale.md:
# atomic-claim code is recognizable by what it does, not by whether someone
# remembered to add it to a list. These entries make codex review explicit.
src/trackers/linear.ts
src/trackers/github.ts
src/trackers/notion.ts
src/trackers/base.ts
src/trackers/footers.ts

# Secrets-manager adapters — read secret material, classify provider errors.
src/secrets-managers/**
src/core/secrets.ts

# Tripwire injection scanner (FORGE-202) — the deterministic detection engine.
# Security-sensitive: it scans UNTRUSTED input, redacts secrets out of findings,
# and is the trust boundary for the future untrusted→prompt path (FORGE-203/204).
# Same review reasoning as the tracker/secrets adapters: a change here is a
# /second-opinion auto-trigger.
src/security/**

# Search adapters (FORGE-204) — the untrusted-content ingestion boundary.
# `forge search fetch` is the first path carrying externally-authorable free-form
# text toward an agent. Security-sensitive: SSRF-hardened HTTP (custom DNS lookup,
# manual redirect re-guard, streaming byte cap), bounded HTML→text extraction,
# and the structural Tripwire chokepoint (every result scanned at the base before
# it can reach a caller). A change here is a /second-opinion auto-trigger.
src/search/**

# CLI / init flow — touches user files, executes subprocesses.
src/cli/init/**

# Harness adapters (FORGE-88) — spawn primary worker / review subprocesses.
# Claude path is the subscription-billing surface (must NOT spawn `claude` CLI);
# Codex + Gemini paths spawn subprocesses with worktree cwd and parse stdout
# into a verdict. Same review reasoning as tracker adapters: subprocess
# boundary, structured-output parsing, security-sensitive defaults.
src/harnesses/**

# ─── adopter-template defaults (kept for reference; not applicable to forge core) ─

src/lib/auth/**
src/lib/billing/**
src/app/api/webhooks/**
src/app/api/auth/**
infrastructure/**
.github/workflows/**
prisma/schema.prisma
supabase/migrations/**

# Orchestrator local-state CAS — atomic claim primitives at the FS layer
# (Same reasoning as tracker adapters: generation-fenced CAS, multi-process race surface)
src/orchestrator/leases.ts
src/orchestrator/state-machine.ts

# ─── DO-NOT-SIMPLIFY (FORGE-181 /audit dogfood) ───────────────────────────────
# Subtle, correctness-critical modules whose apparent duplication / complexity is
# DELIBERATE. /audit reads THIS file for its protected set, so listing them here
# makes forge "just another adopter": /audit classifies findings in these as
# do-not-touch / protected (and /second-opinion reviews them on /ship). The audit
# feature ships with ZERO hardcoded paths — forge's specifics live HERE, in code.
src/orchestrator/glob-match.ts
src/orchestrator/overlap.ts
src/orchestrator/questions/writer.ts
src/cli/orchestrate/status.ts
src/core/logger.ts
