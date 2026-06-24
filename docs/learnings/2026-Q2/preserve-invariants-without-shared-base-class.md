# Preserve architectural invariants even without shared scaffolding

> 2026-05-12 · FORGE-18 · tags: [architecture, invariants, eureka-preservation, adapters, error-handling]

## What we expected
The EUREKA from FORGE-14 (adapters classify their own provider errors via `classifyProviderError`, base class normalizes) lives in `BaseTracker`. With only one secret-manager adapter, skipping `BaseSecretsManager` was the right call.

## What happened
Kept the invariant alive anyway: `EnvFileSecretsManager` implements `SecretsManager` directly AND owns its own error classification. When adapter #2 lands (1password/doppler), extracting `BaseSecretsManager` is a clean refactor — each adapter already owns its classification.

## Why
Invariants survive across modules only if they're documented in BOTH the plans AND the code, and followed even when the scaffolding that usually enforces them is absent. Otherwise a future adapter "discovers" provider-error sniffing belongs in the base class — and the abstraction rots.

## Next time
When deferring a shared base class, write the invariant as a comment in the single concrete implementation ("adapters own their own provider-error classification — do not move into base"). Reference the originating EUREKA / Linear ID. Future-you reads the comment before refactoring.
