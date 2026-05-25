import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { parse as yamlParse } from 'yaml';
import { tsxBin, forgeBinEntry as entry, repoRoot } from '../../helpers/spawn-tsx.ts';
import { readBundledMethodologyVersion } from '../../../src/cli/upgrade/version-check.ts';
import { renderContext } from '../../../src/cli/upgrade/render-context.ts';
import {
  buildPrefixBlock,
  ROOT_FILE_BY_AGENT,
  type AgentKind,
} from '../../../src/cli/upgrade/agent-root-files.ts';
import { applyGitignoreBlock } from '../../../src/cli/upgrade/gitignore-block.ts';
import { applySkillFarm, locatePackageRoot } from '../../../src/cli/upgrade/skill-farm.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../../../src/cli/registry.ts';

const FORGE_REPO_URL = 'https://github.com/firatcand/forge';

/** Set up a tmp dir that looks like a freshly init'd Forge repo at the current bundled version. */
function bootstrapInitdRepo(opts: { enabled?: AgentKind[]; primary?: AgentKind; versionOverride?: string } = {}): string {
  const enabled = opts.enabled ?? ['claude'];
  const primary = opts.primary ?? enabled[0]!;
  const version = opts.versionOverride ?? readBundledMethodologyVersion();

  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-e2e-'));
  mkdirSync(join(cwd, '.forge'));

  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: ${primary}\n  review_host_cli: ${primary === 'codex' ? 'gemini' : 'codex'}\n  enabled_root_files:\n${enabled.map((a) => `    - ${a}`).join('\n')}\ndesign:\n  mode: project_owned\n`,
  );
  writeFileSync(join(cwd, '.forge/.version'), `${version}\n`);

  const template = readFileSync(resolve(repoRoot, 'templates/CONTEXT.template.md'), 'utf8');
  const rendered = renderContext(template, {
    version,
    verbs: CLI_VERBS,
    slashCommands: SLASH_COMMANDS,
  });
  writeFileSync(join(cwd, '.forge/CONTEXT.md'), rendered);

  for (const agent of enabled) {
    writeFileSync(
      join(cwd, ROOT_FILE_BY_AGENT[agent]),
      buildPrefixBlock(agent, { repoUrl: FORGE_REPO_URL }),
    );
  }
  writeFileSync(join(cwd, '.gitignore'), applyGitignoreBlock(''));

  // FORGE-156: pre-create the skill farm so "no-op on clean repo" tests
  // see a truly-clean state. The CLI subprocess we spawn below uses the
  // same skill-farm module loaded from this repo, so the targets it
  // computes match what we materialize here.
  applySkillFarm({ cwd, packageRoot: locatePackageRoot(), enabledAgents: enabled });

  return cwd;
}

// ============================================================================
// B8 — CLI drift-warning pre-hook
// ============================================================================

test('e2e: drift warning fires on a non-upgrade command when .forge/.version is stale', async () => {
  const cwd = bootstrapInitdRepo();
  // Pin .version to something deliberately stale
  writeFileSync(join(cwd, '.forge/.version'), '0.0.1\n');

  const result = await execa(
    tsxBin,
    [entry, 'codex-suggest', 'plan-task'],
    { cwd, reject: false, all: true },
  );

  assert.match(result.stderr, /methodology is v0\.0\.1/, `expected drift warning, got: ${result.stderr}`);
  assert.match(result.stderr, /Run `forge upgrade`/);
});

test('e2e: FORGE_QUIET=1 suppresses the drift warning', async () => {
  const cwd = bootstrapInitdRepo();
  writeFileSync(join(cwd, '.forge/.version'), '0.0.1\n');

  const result = await execa(
    tsxBin,
    [entry, 'codex-suggest', 'plan-task'],
    { cwd, reject: false, env: { ...process.env, FORGE_QUIET: '1' } },
  );

  assert.doesNotMatch(result.stderr, /methodology is v/);
});

test('e2e: forge upgrade does NOT print its own drift warning (self-referential suppression)', async () => {
  const cwd = bootstrapInitdRepo();
  writeFileSync(join(cwd, '.forge/.version'), '0.0.1\n');

  const result = await execa(
    tsxBin,
    [entry, 'upgrade'],
    { cwd, reject: false },
  );

  assert.doesNotMatch(result.stderr, /Run `forge upgrade`/, 'upgrade verb must suppress its own drift warning');
  assert.equal(result.exitCode, 0);
});

test('e2e: drift warning is silent in a non-forge directory (no .forge/.version)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-e2e-'));

  const result = await execa(
    tsxBin,
    [entry, 'codex-suggest', 'plan-task'],
    { cwd, reject: false },
  );

  assert.doesNotMatch(result.stderr, /methodology is v/);
});

// ============================================================================
// B9 — upgrade verb wired into router
// ============================================================================

test('e2e: forge upgrade in a non-init dir exits 3 with helpful message', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-e2e-'));

  const result = await execa(
    tsxBin,
    [entry, 'upgrade'],
    { cwd, reject: false },
  );

  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /settings\.yaml not found/);
});

test('e2e: forge upgrade is a no-op on a clean repo', async () => {
  const cwd = bootstrapInitdRepo();
  const result = await execa(
    tsxBin,
    [entry, 'upgrade'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '', `expected no "changed:" output, got: ${result.stdout}`);
});

test('e2e: forge upgrade --dry-run reports without writing', async () => {
  const cwd = bootstrapInitdRepo();
  writeFileSync(join(cwd, '.forge/CONTEXT.md'), 'CORRUPTED\n');

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--force', '--dry-run'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /changed: \.forge\/CONTEXT\.md/);
  // File still corrupted on disk — dry-run didn't write
  assert.equal(readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8'), 'CORRUPTED\n');
});

test('e2e: forge upgrade --add-agent codex writes AGENTS.md and updates settings', async () => {
  const cwd = bootstrapInitdRepo({ enabled: ['claude'] });

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent', 'codex'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /changed: AGENTS\.md/);
  const settings = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')) as {
    agents: { enabled_root_files: AgentKind[] };
  };
  assert.ok(settings.agents.enabled_root_files.includes('codex'));
  assert.match(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /<!-- >>> forge-managed/);
});

test('e2e: forge upgrade --add-agent with NO value is rejected (Codex round-1 fix)', async () => {
  const cwd = bootstrapInitdRepo();
  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent'],
    { cwd, reject: false },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--add-agent requires a value/);
});

test('e2e: forge upgrade --add-agent followed by another flag is rejected (no positional fallthrough)', async () => {
  const cwd = bootstrapInitdRepo();
  // Without the MISSING_VALUE check, `--add-agent --force` would silently
  // interpret --force as the agent name and then unsafely pass through.
  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent', '--force'],
    { cwd, reject: false },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--add-agent requires a value/);
});

test('e2e: forge upgrade --add-agent + --remove-agent are mutually exclusive (Codex round-1 fix)', async () => {
  const cwd = bootstrapInitdRepo({ enabled: ['claude'] });
  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent', 'codex', '--remove-agent', 'codex'],
    { cwd, reject: false },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /mutually exclusive/);
});

test('e2e: forge upgrade --add-agent rejects unknown agent name', async () => {
  const cwd = bootstrapInitdRepo();

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent', 'cursor'],
    { cwd, reject: false },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /unknown agent 'cursor'/);
});

test('e2e: forge upgrade --add-agent supports --flag=value form', async () => {
  const cwd = bootstrapInitdRepo({ enabled: ['claude'] });

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--add-agent=gemini'],
    { cwd, reject: false, env: { ...process.env, FORGE_GEMINI_EXPERIMENTAL: '1' } },
  );

  assert.equal(result.exitCode, 0);
  const settings = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')) as {
    agents: { enabled_root_files: AgentKind[] };
  };
  assert.ok(settings.agents.enabled_root_files.includes('gemini'));
});

test('e2e: forge upgrade exits 4 when on-disk version is newer than CLI bundle', async () => {
  const cwd = bootstrapInitdRepo();
  writeFileSync(join(cwd, '.forge/.version'), '99.0.0\n');

  const result = await execa(
    tsxBin,
    [entry, 'upgrade'],
    { cwd, reject: false },
  );

  assert.equal(result.exitCode, 4);
  assert.match(result.stderr, /DOWNGRADE/);
});

test('e2e: forge upgrade --force does NOT bypass exit-4 refusal', async () => {
  const cwd = bootstrapInitdRepo();
  writeFileSync(join(cwd, '.forge/.version'), '99.0.0\n');

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--force'],
    { cwd, reject: false },
  );

  assert.equal(result.exitCode, 4);
});

test('e2e: forge upgrade on a stale (older) repo refreshes CONTEXT.md + .version', async () => {
  const cwd = bootstrapInitdRepo({ versionOverride: '0.0.1' });

  const result = await execa(
    tsxBin,
    [entry, 'upgrade'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /changed: \.forge\/CONTEXT\.md/);
  assert.equal(
    readFileSync(join(cwd, '.forge/.version'), 'utf8').trim(),
    readBundledMethodologyVersion(),
  );
});

// ============================================================================
// FORGE-154 Phase C — --migrate-claudemd
// ============================================================================

const LEGACY_CLAUDEMD_PATH = resolve(repoRoot, 'test/fixtures/legacy-claudemd.md');

/** Bootstrap a tmpdir that looks like a v0.4 repo just before migration:
 *  - CLAUDE.md = pinned legacy fixture
 *  - .forge/settings.yaml = minimal v0.5 shape (post-Phase-A schema)
 *  - NO .forge/CONTEXT.md, NO .forge/.version (those are migration outputs)
 */
function bootstrapLegacyRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-e2e-'));
  writeFileSync(join(cwd, 'CLAUDE.md'), readFileSync(LEGACY_CLAUDEMD_PATH, 'utf8'));
  mkdirSync(join(cwd, '.forge'));
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: claude\n  review_host_cli: codex\n  enabled_root_files:\n    - claude\ndesign:\n  mode: project_owned\n`,
  );
  return cwd;
}

test('e2e: --migrate-claudemd against v0.4 fixture → split layout', async () => {
  const cwd = bootstrapLegacyRepo();

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--migrate-claudemd'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0, `expected exit 0, got: ${result.all}`);
  assert.match(result.stdout, /changed: CLAUDE\.md/);
  assert.match(result.stdout, /changed: \.forge\/CONTEXT\.md/);
  assert.match(result.stdout, /changed: \.forge\/\.version/);
  assert.match(result.stdout, /changed: \.gitignore/);

  // .bak holds the original
  const bak = readFileSync(join(cwd, 'CLAUDE.md.pre-migration.bak'), 'utf8');
  assert.equal(bak, readFileSync(LEGACY_CLAUDEMD_PATH, 'utf8'));

  // CLAUDE.md trimmed: marker block + @import + product headings present;
  // methodology headings absent.
  const newClaude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(newClaude, /<!-- >>> forge-managed/);
  assert.match(newClaude, /@\.forge\/CONTEXT\.md/);
  assert.doesNotMatch(newClaude, /## Forge principles/);
  assert.doesNotMatch(newClaude, /## Source of truth/);
  assert.doesNotMatch(newClaude, /## Skill ↔ verb contract/);
  assert.doesNotMatch(newClaude, /## Branch strategy/);
  assert.doesNotMatch(newClaude, /## Ephemeral ADR workflow/);
  assert.match(newClaude, /## Stack/);
  assert.match(newClaude, /## Commands/);
  assert.match(newClaude, /## Conventions/);
  assert.match(newClaude, /## Critical paths/); // preserved per plan Q2

  // CONTEXT.md materialized; .version stamped
  assert.match(
    readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8'),
    /# Forge methodology/,
  );
  assert.equal(
    readFileSync(join(cwd, '.forge/.version'), 'utf8').trim(),
    readBundledMethodologyVersion(),
  );

  // .gitignore created with marker block
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /# >>> forge-managed/);

  // Idempotency boundary: re-running `forge upgrade` (no migrate flag) on the
  // just-migrated repo is a no-op. CONTEXT.md SHA matches bundled → no rewrite.
  const reUpgrade = await execa(tsxBin, [entry, 'upgrade'], { cwd, reject: false, all: true });
  assert.equal(reUpgrade.exitCode, 0);
  assert.doesNotMatch(reUpgrade.stdout, /changed: \.forge\/CONTEXT\.md/);
});

test('e2e: --migrate-claudemd refuses if CLAUDE.md already has Forge marker block (already migrated)', async () => {
  // After codex review, the precondition shifted from CONTEXT.md-exists to
  // CLAUDE.md-has-marker — that lets partial-crash recoveries succeed while
  // still refusing genuine re-migration attempts. Set up a post-migration
  // CLAUDE.md (marker block + minimal product body) and verify refusal.
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-e2e-'));
  mkdirSync(join(cwd, '.forge'));
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: claude\n  review_host_cli: codex\n  enabled_root_files:\n    - claude\ndesign:\n  mode: project_owned\n`,
  );
  const claudeWithMarker = `<!-- >>> forge-managed (do not edit between markers) >>> -->
> marker body
@.forge/CONTEXT.md
<!-- <<< forge-managed <<< -->

# my-product
## Stack
TypeScript.
`;
  writeFileSync(join(cwd, 'CLAUDE.md'), claudeWithMarker);

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--migrate-claudemd'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /already migrated|Forge marker block/i);
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), claudeWithMarker, 'CLAUDE.md unchanged');
});

test('e2e: --migrate-claudemd --force is refused at CLI parse (mutex)', async () => {
  const cwd = bootstrapLegacyRepo();

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--migrate-claudemd', '--force'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /mutually exclusive with --force/);
  // No writes happened — CLAUDE.md byte-identical to fixture.
  assert.equal(
    readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'),
    readFileSync(LEGACY_CLAUDEMD_PATH, 'utf8'),
  );
});

test('e2e: --migrate-claudemd --add-agent codex is refused at CLI parse (mutex)', async () => {
  const cwd = bootstrapLegacyRepo();

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--migrate-claudemd', '--add-agent', 'codex'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /mutually exclusive with --add-agent/);
});

test('e2e: --migrate-claudemd --dry-run leaves filesystem inert', async () => {
  const cwd = bootstrapLegacyRepo();

  const result = await execa(
    tsxBin,
    [entry, 'upgrade', '--migrate-claudemd', '--dry-run'],
    { cwd, reject: false, all: true },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /would write/i);

  // No actual writes — the CLI still prints "changed:" lines for the would-be
  // changes (matches existing `forge upgrade --dry-run` behavior), but the
  // filesystem must be byte-identical to bootstrap state.
  assert.equal(
    readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'),
    readFileSync(LEGACY_CLAUDEMD_PATH, 'utf8'),
    'CLAUDE.md must be unchanged after dry-run',
  );
  assert.throws(
    () => readFileSync(join(cwd, 'CLAUDE.md.pre-migration.bak'), 'utf8'),
    { code: 'ENOENT' },
    '.bak must not exist after dry-run',
  );
  assert.throws(
    () => readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8'),
    { code: 'ENOENT' },
    '.forge/CONTEXT.md must not exist after dry-run',
  );
  assert.throws(
    () => readFileSync(join(cwd, '.forge/.version'), 'utf8'),
    { code: 'ENOENT' },
    '.forge/.version must not exist after dry-run',
  );
  assert.throws(
    () => readFileSync(join(cwd, '.gitignore'), 'utf8'),
    { code: 'ENOENT' },
    '.gitignore must not exist after dry-run',
  );
});
