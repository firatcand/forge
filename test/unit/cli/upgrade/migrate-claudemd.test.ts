// Unit tests for FORGE-154 — `forge upgrade --migrate-claudemd`.
//
// All tests assert on actual on-disk file contents + exit codes
// (`feedback_ac_as_unit_test` discipline). Each test mints a tmpdir, writes
// the legacy fixture, calls migrateClaudemd, asserts both positive and
// negative file-system invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrateClaudemd, METHODOLOGY_HEADINGS } from '../../../../src/cli/upgrade/migrate-claudemd.ts';
import { readBundledMethodologyVersion } from '../../../../src/cli/upgrade/version-check.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, '../../../fixtures/legacy-claudemd.md');
const LEGACY_CLAUDEMD = readFileSync(FIXTURE_PATH, 'utf8');

interface BootstrapOpts {
  /** Override the CLAUDE.md content (defaults to the pinned v0.4 fixture). */
  readonly claudeOverride?: string;
  /** Skip writing CLAUDE.md entirely (for the "missing CLAUDE.md" test). */
  readonly skipClaude?: boolean;
  /** Skip writing .forge/settings.yaml (for the "missing settings" test). */
  readonly skipSettings?: boolean;
  /** Override settings.yaml content (for the "malformed settings" test). */
  readonly settingsOverride?: string;
  /** Pre-create .forge/CONTEXT.md (for the "already migrated" test). */
  readonly seedContext?: boolean;
}

/** Bootstrap a tmpdir that looks like a v0.4 repo just before migration:
 *  - CLAUDE.md = legacy fixture
 *  - .forge/settings.yaml = minimal v0.5 shape (post-Phase-A schema)
 *  - NO .forge/CONTEXT.md, NO .forge/.version (those are migration outputs)
 */
function bootstrapLegacy(opts: BootstrapOpts = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-'));

  if (!opts.skipClaude) {
    writeFileSync(join(cwd, 'CLAUDE.md'), opts.claudeOverride ?? LEGACY_CLAUDEMD);
  }

  if (!opts.skipSettings) {
    mkdirSync(join(cwd, '.forge'));
    const defaultSettings = `version: 1
project:
  name: test-project
tracker:
  type: github
  config:
    repo: org/repo
secrets:
  manager: env_file
  env_file_path: ./.env.local
agents:
  primary_host_cli: claude
  review_host_cli: codex
  enabled_root_files:
    - claude
design:
  mode: project_owned
`;
    writeFileSync(join(cwd, '.forge/settings.yaml'), opts.settingsOverride ?? defaultSettings);
  }

  if (opts.seedContext) {
    if (!existsSync(join(cwd, '.forge'))) mkdirSync(join(cwd, '.forge'));
    writeFileSync(join(cwd, '.forge/CONTEXT.md'), '# pre-existing\n');
  }

  return cwd;
}

function cleanup(cwd: string): void {
  rmSync(cwd, { recursive: true, force: true });
}

// =====================================================================
// Happy path
// =====================================================================

test('migrateClaudemd: happy path — v0.4 fixture → split layout', async () => {
  const cwd = bootstrapLegacy();
  try {
    const result = await migrateClaudemd({ cwd });

    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);

    // .bak exists + contains the ORIGINAL legacy content (byte-identical)
    const bakPath = join(cwd, 'CLAUDE.md.pre-migration.bak');
    assert.ok(existsSync(bakPath), '.pre-migration.bak should exist');
    assert.equal(readFileSync(bakPath, 'utf8'), LEGACY_CLAUDEMD, 'bak should match original');

    // New CLAUDE.md exists with marker block + import directive
    const newClaude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(newClaude, /<!-- >>> forge-managed/, 'new CLAUDE.md should have open marker');
    assert.match(newClaude, /<!-- <<< forge-managed/, 'new CLAUDE.md should have close marker');
    assert.match(newClaude, /@\.forge\/CONTEXT\.md/, 'new CLAUDE.md should have @import directive');

    // Each stripped methodology heading is GONE from new CLAUDE.md
    for (const heading of METHODOLOGY_HEADINGS) {
      assert.ok(
        !newClaude.includes(heading),
        `new CLAUDE.md must NOT contain stripped heading: ${heading}`,
      );
    }

    // Product headings ARE preserved (## Stack, ## Commands, ## Conventions, ## Critical paths)
    assert.match(newClaude, /\n## Stack\n/, '## Stack should be preserved');
    assert.match(newClaude, /\n## Commands\n/, '## Commands should be preserved');
    assert.match(newClaude, /\n## Conventions\n/, '## Conventions should be preserved');
    assert.match(newClaude, /\n## Critical paths\n/, '## Critical paths should be preserved (per plan Q2)');

    // Product project heading preserved
    assert.match(newClaude, /\n# forge\n/, '# forge product heading should be preserved');

    // .forge/CONTEXT.md materialized
    const ctx = readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8');
    assert.match(ctx, /# Forge methodology/, 'CONTEXT.md should start with methodology heading');
    assert.match(ctx, /forge orchestrate/, 'CONTEXT.md should contain CLI verbs section');

    // .forge/.version stamped with bundled methodology version
    const version = readFileSync(join(cwd, '.forge/.version'), 'utf8').trim();
    assert.equal(version, readBundledMethodologyVersion(), '.version should match bundled');

    // .gitignore has marker block (created from empty)
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.match(gi, /# >>> forge-managed/, '.gitignore should have marker block');
    assert.match(gi, /!\/\.forge\/settings\.yaml/, '.gitignore should negate settings.yaml');

    // filesChanged report mentions all expected paths
    assert.ok(result.filesChanged.includes('CLAUDE.md.pre-migration.bak'));
    assert.ok(result.filesChanged.includes('CLAUDE.md'));
    assert.ok(result.filesChanged.includes('.forge/CONTEXT.md'));
    assert.ok(result.filesChanged.includes('.forge/.version'));
    assert.ok(result.filesChanged.includes('.gitignore'));
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: preserves product-specific content verbatim', async () => {
  // Inject custom prose under ## Stack — must survive migration byte-for-byte.
  const customMarker = 'Node.js 22, TypeScript 5, React 19.';
  const claude = LEGACY_CLAUDEMD.replace(
    '## Stack\n<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->',
    `## Stack\n${customMarker}\n<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->`,
  );
  const cwd = bootstrapLegacy({ claudeOverride: claude });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 0, `expected exit 0, got: ${result.stderr}`);
    const newClaude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.ok(newClaude.includes(customMarker), 'custom product prose must survive verbatim');
  } finally {
    cleanup(cwd);
  }
});

// =====================================================================
// Bail-clean paths (exit 0, no writes)
// =====================================================================

test('migrateClaudemd: bail-clean on drifted methodology prose', async () => {
  const drifted = LEGACY_CLAUDEMD.replace('Boil the Lake', 'BOIL THE LAKE');
  const cwd = bootstrapLegacy({ claudeOverride: drifted });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 0, 'bail-clean exits 0');
    assert.match(result.stderr, /drifted|drift/i, 'stderr names the drift');
    assert.match(result.stderr, /Forge principles/i, 'stderr names the affected section');
    assert.match(result.stderr, /Manual migration recipe/i, 'stderr prints manual recipe');

    // No writes
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), drifted, 'CLAUDE.md unchanged');
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
    assert.ok(!existsSync(join(cwd, '.forge/CONTEXT.md')), 'no CONTEXT.md');
    assert.ok(!existsSync(join(cwd, '.forge/.version')), 'no .version');
    assert.ok(!existsSync(join(cwd, '.gitignore')), 'no .gitignore');
    assert.deepEqual(result.filesChanged, []);
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: bail-clean when a methodology heading is missing', async () => {
  // Remove the ## Source of truth heading from the legacy file.
  const broken = LEGACY_CLAUDEMD.replace(/## Source of truth\n/, '## Renamed heading\n');
  const cwd = bootstrapLegacy({ claudeOverride: broken });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 0, 'bail-clean exits 0');
    assert.match(result.stderr, /Source of truth.*not found/i, 'stderr names the missing heading');
    assert.match(result.stderr, /Manual migration recipe/i);

    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
    assert.ok(!existsSync(join(cwd, '.forge/CONTEXT.md')), 'no CONTEXT.md');
  } finally {
    cleanup(cwd);
  }
});

// =====================================================================
// Refusal paths (non-zero exit)
// =====================================================================

test('migrateClaudemd: refuses if CLAUDE.md already has a Forge marker block (already migrated)', async () => {
  // Bootstrap a "post-migration" CLAUDE.md: marker block + minimal product body.
  // This is what a successful migration produces; running --migrate-claudemd
  // again must refuse rather than try to re-strip.
  const claudeWithMarker = `<!-- >>> forge-managed (do not edit between markers) >>> -->
> some marker body
@.forge/CONTEXT.md
<!-- <<< forge-managed <<< -->

# my-product
## Stack
TypeScript.
`;
  const cwd = bootstrapLegacy({ claudeOverride: claudeWithMarker });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /already migrated|Forge marker block/i);
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), claudeWithMarker, 'CLAUDE.md unchanged');
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: PROCEEDS when .forge/CONTEXT.md exists but CLAUDE.md is still legacy (partial-crash recovery)', async () => {
  // Codex review IMPROVEMENT: a process killed between CONTEXT.md write and
  // CLAUDE.md trim leaves the repo in a state where CONTEXT.md exists but
  // CLAUDE.md still has the legacy methodology. The marker-block check
  // (not CONTEXT.md existence) MUST allow this re-run to complete cleanly.
  const cwd = bootstrapLegacy({ seedContext: true });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 0, `expected exit 0 (recovery), got: ${result.stderr}`);
    // CLAUDE.md now has marker block + product content (trimmed)
    const newClaude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(newClaude, /<!-- >>> forge-managed/);
    assert.doesNotMatch(newClaude, /## Forge principles/);
    // CONTEXT.md was overwritten with bundled content (NOT the seeded "# pre-existing")
    assert.match(readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8'), /# Forge methodology/);
    // .bak captures the legacy CLAUDE.md (NOT the seeded marker file)
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md.pre-migration.bak'), 'utf8'), LEGACY_CLAUDEMD);
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: refuses if CLAUDE.md is a symbolic link (security M1)', async () => {
  const cwd = bootstrapLegacy({ skipClaude: true });
  try {
    // Stage a target file outside the symlink so we can verify it stays untouched.
    const target = join(cwd, 'real-claude.md');
    writeFileSync(target, LEGACY_CLAUDEMD);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, join(cwd, 'CLAUDE.md'));

    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /CLAUDE\.md is a symbolic link/i);
    // The target file MUST be unchanged
    assert.equal(readFileSync(target, 'utf8'), LEGACY_CLAUDEMD, 'symlink target untouched');
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak written');
    assert.ok(!existsSync(join(cwd, '.forge/CONTEXT.md')), 'no CONTEXT.md');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: refuses if .forge/settings.yaml is a symbolic link (security M2)', async () => {
  const cwd = bootstrapLegacy({ skipSettings: true });
  try {
    // Bootstrap without settings, then symlink settings.yaml.
    mkdirSync(join(cwd, '.forge'));
    const target = join(cwd, 'real-settings.yaml');
    writeFileSync(target, 'evil: contents\n');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, join(cwd, '.forge/settings.yaml'));

    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /settings\.yaml is a symbolic link/i);
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: preserves intentional whitespace (\\n\\n\\n) in product sections', async () => {
  // Codex review BLOCK: the earlier global \n{3,} collapse silently rewrote
  // user-owned product whitespace. After the fix, product whitespace MUST
  // survive verbatim.
  const claude = LEGACY_CLAUDEMD.replace(
    '## Stack\n<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->',
    '## Stack\n\n\nNode.js 22, TypeScript 5.\n<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->',
  );
  // sanity: three consecutive newlines present before migration
  assert.match(claude, /## Stack\n\n\n/);
  const cwd = bootstrapLegacy({ claudeOverride: claude });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 0, `expected exit 0, got: ${result.stderr}`);
    const newClaude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(newClaude, /## Stack\n\n\nNode\.js 22, TypeScript 5\./, 'triple-newline + custom prose survives verbatim');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: refuses when CLAUDE.md is missing', async () => {
  const cwd = bootstrapLegacy({ skipClaude: true });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no CLAUDE\.md found/i);
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: refuses when .forge/settings.yaml is missing (exit 3)', async () => {
  const cwd = bootstrapLegacy({ skipSettings: true });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 3, 'spec §9 exit code 3 for missing settings');
    assert.match(result.stderr, /settings\.yaml not found|forge init/i);
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd: refuses when .forge/settings.yaml is malformed (exit 3)', async () => {
  const cwd = bootstrapLegacy({ settingsOverride: 'this is: not: valid: forge: settings\n' });
  try {
    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /invalid \.forge\/settings\.yaml|failed to parse/i);
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

// =====================================================================
// Dry-run
// =====================================================================

test('migrateClaudemd: --dry-run preserves all files', async () => {
  const cwd = bootstrapLegacy();
  try {
    const result = await migrateClaudemd({ cwd, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /dry-run.*would write/i, 'stderr lists pending writes');

    // No writes happened
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), LEGACY_CLAUDEMD, 'CLAUDE.md unchanged');
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
    assert.ok(!existsSync(join(cwd, '.forge/CONTEXT.md')), 'no CONTEXT.md');
    assert.ok(!existsSync(join(cwd, '.forge/.version')), 'no .version');
    assert.ok(!existsSync(join(cwd, '.gitignore')), 'no .gitignore');

    // filesChanged still lists what WOULD change
    assert.ok(result.filesChanged.includes('CLAUDE.md'));
    assert.ok(result.filesChanged.includes('.forge/CONTEXT.md'));
  } finally {
    cleanup(cwd);
  }
});

// =====================================================================
// extractSection direct unit tests (covers Edge cases E7–E10)
// =====================================================================

test('extractSection: heading at start of file', async () => {
  const { extractSection } = await import('../../../../src/cli/upgrade/migrate-claudemd.ts');
  const content = '## Foo\nbody\n\n## Bar\nbody2\n';
  const sec = extractSection(content, '## Foo');
  assert.ok(sec, 'must extract');
  assert.equal(sec.startIdx, 0);
  assert.equal(sec.fullBlock, '## Foo\nbody\n\n');
});

test('extractSection: heading mid-file', async () => {
  const { extractSection } = await import('../../../../src/cli/upgrade/migrate-claudemd.ts');
  const content = '## Foo\nbody\n\n## Bar\nbody2\n';
  const sec = extractSection(content, '## Bar');
  assert.ok(sec, 'must extract');
  assert.equal(sec.fullBlock, '## Bar\nbody2\n');
});

test('extractSection: heading at end of file (last section, no following ##)', async () => {
  const { extractSection } = await import('../../../../src/cli/upgrade/migrate-claudemd.ts');
  const content = '# Title\n\n## Last\nlast body\nno trailing newline';
  const sec = extractSection(content, '## Last');
  assert.ok(sec, 'must extract last section');
  assert.equal(sec.fullBlock, '## Last\nlast body\nno trailing newline');
});

test('extractSection: returns null when heading is absent', async () => {
  const { extractSection } = await import('../../../../src/cli/upgrade/migrate-claudemd.ts');
  const content = '# Title\n## Foo\nbody\n';
  assert.equal(extractSection(content, '## Bar'), null);
});

test('extractSection: deterministic across runs (same input → same fullBlock)', async () => {
  const { extractSection } = await import('../../../../src/cli/upgrade/migrate-claudemd.ts');
  const content = '## H\nbody\n\n## Next\n';
  const a = extractSection(content, '## H');
  const b = extractSection(content, '## H');
  assert.ok(a && b);
  assert.equal(a.fullBlock, b.fullBlock);
});

// =====================================================================
// FORGE-208 — upfront symlink preflight on every write target
// =====================================================================

test('migrateClaudemd (FORGE-208 #12): refuses upfront when .gitignore is a symlink — no partial writes, no .bak', async () => {
  const cwd = bootstrapLegacy();
  try {
    const { symlinkSync, lstatSync } = await import('node:fs');
    writeFileSync(join(cwd, 'real-gitignore'), 'node_modules\n');
    symlinkSync('real-gitignore', join(cwd, '.gitignore'));

    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\.gitignore is a symbolic link/i);
    assert.deepEqual([...result.filesChanged], []);

    // Upfront refusal — NOTHING was written (the bug this guards: a
    // mid-migration FsWriteError after .bak/CONTEXT.md already landed).
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
    assert.ok(!existsSync(join(cwd, '.forge/CONTEXT.md')), 'no CONTEXT.md');
    assert.ok(!existsSync(join(cwd, '.forge/.version')), 'no .version');
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), LEGACY_CLAUDEMD, 'CLAUDE.md unchanged');
    assert.equal(lstatSync(join(cwd, '.gitignore')).isSymbolicLink(), true, 'link intact');
    assert.equal(readFileSync(join(cwd, 'real-gitignore'), 'utf8'), 'node_modules\n', 'target untouched');
  } finally {
    cleanup(cwd);
  }
});

test('migrateClaudemd (FORGE-208 #12b): refuses upfront when .forge/CONTEXT.md is a symlink — no partial writes', async () => {
  const cwd = bootstrapLegacy();
  try {
    const { symlinkSync } = await import('node:fs');
    writeFileSync(join(cwd, 'real-context.md'), '# elsewhere\n');
    symlinkSync('../real-context.md', join(cwd, '.forge/CONTEXT.md'));

    const result = await migrateClaudemd({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\.forge\/CONTEXT\.md is a symbolic link/i);
    assert.ok(!existsSync(join(cwd, 'CLAUDE.md.pre-migration.bak')), 'no .bak');
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), LEGACY_CLAUDEMD, 'CLAUDE.md unchanged');
    assert.equal(readFileSync(join(cwd, 'real-context.md'), 'utf8'), '# elsewhere\n', 'target untouched');
  } finally {
    cleanup(cwd);
  }
});
