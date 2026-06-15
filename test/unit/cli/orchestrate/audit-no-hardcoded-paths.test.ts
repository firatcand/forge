import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// FORGE-179 acceptance #2 (made executable): the shipped audit surfaces must
// carry ZERO forge-specific paths/identifiers. Scope + protected sets come ONLY
// from adopter config + auto-discovery — never from a hardcoded forge path.
//
// We scan the four shipped surfaces for forge-internal tokens that would betray
// a leaked path. (The audit module legitimately references shared HELPERS by
// import — `glob-match`, `preflight`, `symlink-guard` — and those imports are
// excluded from the scan; what is forbidden is a HARDCODED forge SOURCE PATH or
// subsystem name baked into scope/protected logic.)

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const SHIPPED_SURFACES = [
  'src/cli/orchestrate/audit.ts',
  'src/schemas/audit.ts',
  'skills/audit/SKILL.md',
  'templates/audit-principles.md',
];

// Forbidden tokens: forge-internal source paths + subsystem identifiers + the
// hardcoded-set markers from the simplification prototype. None of these may
// appear as a string LITERAL in the shipped audit surfaces.
const FORBIDDEN = [
  'src/orchestrator',
  'forge.cjs',
  'classifyOverlapError',
  'classifyGitHubError',
  'classifyLinearError',
  'classifyNotionError',
  'REPO_TOPS',
  'PROTECTED',
];

// `leases` as a hardcoded subsystem token — but allow it inside import paths to
// shared helpers (there are none in the audit surfaces) and inside prose that is
// clearly generic. We forbid the bare path-ish forms.
const FORBIDDEN_LEASES = ['leases.ts', "'leases'", '"leases"', '/leases'];

// Lines we exclude from the scan: the audit module imports shared helper modules
// (preflight.ts / glob-match.ts / symlink-guard.ts / fs-atomic.ts / settings.ts /
// templates.ts) by their real paths. Those imports are reuse, not a hardcoded
// SCOPE/PROTECTED forge path. Only import lines are exempted.
function isExemptImportLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('import ') || t.startsWith('} from') || t.includes("} from '");
}

test('audit surfaces contain zero hardcoded forge-specific paths/identifiers', () => {
  for (const rel of SHIPPED_SURFACES) {
    const text = readFileSync(resolve(repoRoot, rel), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (isExemptImportLine(line)) continue;
      for (const token of FORBIDDEN) {
        assert.ok(
          !line.includes(token),
          `${rel}:${i + 1} contains forbidden hardcoded forge token '${token}': ${line.trim()}`,
        );
      }
      for (const token of FORBIDDEN_LEASES) {
        assert.ok(
          !line.includes(token),
          `${rel}:${i + 1} contains forbidden hardcoded 'leases' path token '${token}': ${line.trim()}`,
        );
      }
    }
  }
});

test('audit principles template names protected surfaces as CLASSES, not concrete forge paths', () => {
  const text = readFileSync(resolve(repoRoot, 'templates/audit-principles.md'), 'utf8');
  // No `src/...` literal path with a real forge dir.
  assert.ok(!/src\/(orchestrator|trackers|harnesses|secrets-managers)\b/.test(text),
    'audit-principles.md must not name concrete forge source dirs');
});
