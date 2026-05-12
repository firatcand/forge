# Files requiring multi-model review (/codex auto-triggers on /ship)
#
# Edit this list to match your project's critical paths.
#
# Note (forge-internal): this list still includes adopter-template defaults
# from the scaffold (auth/billing/prisma/supabase). Those don't exist in
# this repo and are kept as a reference for adopter projects. The forge-
# internal critical paths below are what /codex actually triggers on.

# ─── forge internal critical paths ───────────────────────────────────────────

# Tracker adapters — atomic-claim primitives + subprocess/SDK boundary.
# Per learning docs/learnings/2026-Q2/codex-on-security-paths-even-when-critical-md-stale.md:
# atomic-claim code is recognizable by what it does, not by whether someone
# remembered to add it to a list. These entries make codex review explicit.
src/trackers/linear.ts
src/trackers/github.ts
src/trackers/base.ts
src/trackers/footers.ts

# Secrets-manager adapters — read secret material, classify provider errors.
src/secrets-managers/**
src/core/secrets.ts

# CLI / init flow — touches user files, executes subprocesses.
src/cli/init/**

# ─── adopter-template defaults (kept for reference; not applicable to forge core) ─

src/lib/auth/**
src/lib/billing/**
src/app/api/webhooks/**
src/app/api/auth/**
infrastructure/**
.github/workflows/**
prisma/schema.prisma
supabase/migrations/**
