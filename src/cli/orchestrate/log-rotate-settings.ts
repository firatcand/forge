// Shared resolver for the JSONL soft-rotation threshold (FORGE-118 finding 3).
//
// Deep orchestrator writers (appendAttemptEvent / appendClaimHistory) have no
// settings access by design, so every CLI verb that drives a log append must
// source `agents.log_rotate_max_bytes` from loaded settings and pass it through.
// Before this, the verbs omitted the field and the writers fell back to the
// hardcoded schema default — a user override in settings.yaml was silently
// ignored (the inert-config foot-gun removed in FORGE-124).
//
// Resolution is best-effort: rotation is non-critical infrastructure, so a
// settings load failure must not break the verb's primary mutation. On any
// error we fall back to the schema default (LOG_ROTATE_MAX_BYTES_DEFAULT, which
// equals AgentsSchema.log_rotate_max_bytes' default). The schema default also
// remains the fallback for direct library use that never touches a verb.

import path from 'node:path';
import { loadSettings } from '../../core/settings.ts';
import { LOG_ROTATE_MAX_BYTES_DEFAULT } from '../../orchestrator/jsonl-rotate.ts';

export function resolveLogRotateMaxBytes(forgeDir: string): number {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.agents.log_rotate_max_bytes;
  } catch {
    // Settings missing/invalid → schema default. The verb's own settings-
    // dependent paths (if any) surface their own errors; here we only need a
    // sane rotation threshold and must never fail the append for it.
    return LOG_ROTATE_MAX_BYTES_DEFAULT;
  }
}
