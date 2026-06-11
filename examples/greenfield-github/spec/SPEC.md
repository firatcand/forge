# Greenfield SPEC

> Compact example SPEC. Two real headings below resolve as `§`-anchors for the
> ephemeral-ADR / update-spec flow.

## CLI surface

The product exposes a single CLI entrypoint. Subcommands are added per phase.

## Data model

The persistence layer is a single relational store. Schemas are versioned via
migrations.
