import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { renderContext } from '../../../../src/cli/upgrade/render-context.ts';
import {
  buildPrefixBlock,
  ROOT_FILE_BY_AGENT,
  type AgentKind,
} from '../../../../src/cli/upgrade/agent-root-files.ts';
import { applyGitignoreBlock } from '../../../../src/cli/upgrade/gitignore-block.ts';
import { readBundledMethodologyVersion } from '../../../../src/cli/upgrade/version-check.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../../../../src/cli/registry.ts';
import { applySkillFarm, locatePackageRoot } from '../../../../src/cli/upgrade/skill-farm.ts';
import { upgrade } from '../../../../src/cli/upgrade/upgrade.ts';

const FORGE_REPO_URL = 'https://github.com/firatcand/forge';

interface BootstrapOpts {
  readonly enabledAgents?: AgentKind[];
  readonly primary?: AgentKind;
  readonly versionOverride?: string;
  /** Skip writing CLAUDE.md / AGENTS.md / GEMINI.md root files (defaults to writing them for enabledAgents). */
  readonly skipRootFiles?: boolean;
  /** Skip writing the committed spec/CONTEXT.md stub (to exercise upgrade's create-if-missing path). */
  readonly skipSpecContext?: boolean;
}

/** Create a temp dir that looks exactly like a freshly-init'd Forge repo at the
 * current bundled methodology version. Returns the cwd. */
function bootstrap(opts: BootstrapOpts = {}): string {
  const enabled = opts.enabledAgents ?? ['claude'];
  const primary = opts.primary ?? enabled[0]!;
  const version = opts.versionOverride ?? readBundledMethodologyVersion();

  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-'));
  mkdirSync(join(cwd, '.forge'));

  // settings.yaml — minimal valid shape matching SettingsSchema.
  // Schema constraint: review_host_cli must differ from primary AND must not
  // be 'gemini' unless FORGE_GEMINI_EXPERIMENTAL=1. Pick the other non-gemini
  // value to keep this safely portable across test environments.
  const reviewCli = primary === 'claude' ? 'codex' : 'codex'; // codex is always valid as a reviewer when not primary
  const finalReview = primary === 'codex' ? null : reviewCli;
  // FORGE-161: include the methodology_version pin matching the bundled
  // version so a freshly-bootstrapped repo is a true no-op on upgrade (the pin
  // write only fires when the pin differs from the bundled version).
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: ${primary}\n  review_host_cli: ${finalReview === null ? 'null' : finalReview}\n  enabled_root_files:\n${enabled.map((a) => `    - ${a}`).join('\n')}\ndesign:\n  mode: project_owned\nmethodology_version: ${version}\n`,
  );

  // .forge/.version
  writeFileSync(join(cwd, '.forge/.version'), `${version}\n`);

  // .forge/CONTEXT.md — exactly what renderContext would produce.
  const templatePath = resolve(import.meta.dirname, '../../../../templates/CONTEXT.template.md');
  const template = readFileSync(templatePath, 'utf8');
  const rendered = renderContext(template, {
    version,
    verbs: CLI_VERBS,
    slashCommands: SLASH_COMMANDS,
  });
  writeFileSync(join(cwd, '.forge/CONTEXT.md'), rendered);

  // Root files — marker block only (no product body). Tests that rely on a
  // populated body set it explicitly per-test via writeFileSync after bootstrap.
  if (!opts.skipRootFiles) {
    for (const agent of enabled) {
      const prefix = buildPrefixBlock(agent, { repoUrl: FORGE_REPO_URL });
      writeFileSync(join(cwd, ROOT_FILE_BY_AGENT[agent]), prefix);
    }
  }

  // FORGE: a real init scaffolds a committed spec/CONTEXT.md stub (the
  // @spec/CONTEXT.md import target). Mirror it so "clean repo = no-op" holds;
  // tests exercising the create-if-missing path delete it explicitly.
  if (!opts.skipSpecContext) {
    const stubPath = resolve(import.meta.dirname, '../../../../templates/CONTEXT.project.template.md');
    mkdirSync(join(cwd, 'spec'), { recursive: true });
    writeFileSync(
      join(cwd, 'spec/CONTEXT.md'),
      readFileSync(stubPath, 'utf8').replace(/\{\{PROJECT_NAME\}\}/g, 'test-project'),
    );
  }

  // .gitignore with marker block
  writeFileSync(join(cwd, '.gitignore'), applyGitignoreBlock(''));

  // FORGE-156: pre-create the skill farm so "no-op on clean repo" tests
  // see a truly-clean state. Without this, every upgrade reports the farm
  // creation as a change.
  applySkillFarm({ cwd, packageRoot: locatePackageRoot(), enabledAgents: enabled });

  return cwd;
}

function cleanup(cwd: string): void {
  rmSync(cwd, { recursive: true, force: true });
}

// ============================================================================
// B1 — happy path (no-op)
// ============================================================================

test('upgrade: no-op on clean repo with matching versions', async () => {
  const cwd = bootstrap();
  try {
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.deepEqual([...result.filesChanged], []);
    assert.equal(result.stderr, '');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: creates a missing spec/CONTEXT.md stub (import target must resolve)', async () => {
  const cwd = bootstrap({ skipSpecContext: true });
  try {
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('spec/CONTEXT.md'), 'stub reported changed');
    assert.ok(existsSync(resolve(cwd, 'spec/CONTEXT.md')), 'stub created');
    assert.match(readFileSync(resolve(cwd, 'spec/CONTEXT.md'), 'utf8'), /\/ingest-spec/);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: does not overwrite an existing spec/CONTEXT.md', async () => {
  const cwd = bootstrap();
  try {
    const real = '# test-project — Project Context\n\nReal /ingest-spec output.\n';
    writeFileSync(resolve(cwd, 'spec/CONTEXT.md'), real);
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.ok(!result.filesChanged.includes('spec/CONTEXT.md'), 'populated file untouched');
    assert.equal(readFileSync(resolve(cwd, 'spec/CONTEXT.md'), 'utf8'), real);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --dry-run: does not write the spec/CONTEXT.md stub', async () => {
  const cwd = bootstrap({ skipSpecContext: true });
  try {
    const result = await upgrade({ cwd, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('spec/CONTEXT.md'), 'reported as would-change');
    assert.ok(!existsSync(resolve(cwd, 'spec/CONTEXT.md')), 'dry-run wrote nothing');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: exit 3 when settings.yaml is missing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-'));
  try {
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /settings\.yaml not found/);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: exit 3 BEFORE writes when enabled_root_files contains unknown agent kind', async () => {
  // Codex review (FORGE-153 round 1) caught that an unchecked cast lets
  // settings.agents.enabled_root_files reach the refresh loop with an unknown
  // value, throwing mid-write. With schema validation, this must fail fast
  // (exit 3) before any disk mutation. FORGE-160: `cursor` is now a VALID kind,
  // so this uses a genuinely-unknown value (`windsurf`).
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-'));
  try {
    mkdirSync(join(cwd, '.forge'));
    writeFileSync(
      join(cwd, '.forge/settings.yaml'),
      `version: 1\nproject:\n  name: t\ntracker:\n  type: github\n  config:\n    repo: o/r\nsecrets:\n  manager: env_file\n  env_file_path: ./.env\nagents:\n  primary_host_cli: claude\n  review_host_cli: codex\n  enabled_root_files:\n    - claude\n    - windsurf\ndesign:\n  mode: project_owned\n`,
    );
    writeFileSync(join(cwd, '.forge/.version'), `${readBundledMethodologyVersion()}\n`);
    // Sentinel file — if upgrade writes anything before validating, it would
    // touch CONTEXT.md.
    writeFileSync(join(cwd, '.forge/CONTEXT.md'), 'SENTINEL\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /enabled_root_files|windsurf|invalid/i);
    // No writes: CONTEXT.md still has sentinel.
    assert.equal(readFileSync(join(cwd, '.forge/CONTEXT.md'), 'utf8'), 'SENTINEL\n');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: exit 3 when settings.yaml is malformed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-'));
  try {
    mkdirSync(join(cwd, '.forge'));
    writeFileSync(join(cwd, '.forge/settings.yaml'), 'this: is: not: valid: yaml:\n  - one\n - two\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 3);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B2 — refusal on edited CONTEXT.md
// ============================================================================

test('upgrade: refuses with exit 1 when CONTEXT.md has been edited', async () => {
  const cwd = bootstrap();
  try {
    const contextPath = resolve(cwd, '.forge/CONTEXT.md');
    writeFileSync(contextPath, readFileSync(contextPath, 'utf8') + '\nLOCAL EDIT\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /has local edits/);
    // CONTEXT.md unchanged
    assert.match(readFileSync(contextPath, 'utf8'), /LOCAL EDIT/);
    // No .bak written on refusal
    assert.equal(existsSync(`${contextPath}.bak`), false);
  } finally {
    cleanup(cwd);
  }
});

// GPT-5.5 review F3: the methodology_version pin write must come AFTER every
// refusal/early-exit path. An upgrade that hits the edited-CONTEXT.md refusal
// (exit 1) must leave settings.yaml byte-identical — no pin stamped, honoring
// the refusal/no-write contract.
test('upgrade: edited-CONTEXT refusal (exit 1) leaves settings.yaml byte-identical (no pin stamped)', async () => {
  const cwd = bootstrap();
  try {
    const settingsPath = join(cwd, '.forge/settings.yaml');
    // Remove the pin so a successful run WOULD stamp it — proving the refusal,
    // not a coincidental no-op, is what leaves the file untouched.
    const settingsBefore = readFileSync(settingsPath, 'utf8').replace(
      /methodology_version: .*\n/,
      '',
    );
    writeFileSync(settingsPath, settingsBefore);

    // Edit CONTEXT.md so the upgrade hits the exit-1 local-edit refusal.
    const contextPath = resolve(cwd, '.forge/CONTEXT.md');
    writeFileSync(contextPath, readFileSync(contextPath, 'utf8') + '\nLOCAL EDIT\n');

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /has local edits/);
    assert.deepEqual(result.filesChanged, []);
    // settings.yaml is byte-identical — the pin was NOT stamped on the refusal path.
    assert.equal(readFileSync(settingsPath, 'utf8'), settingsBefore);
    const parsed = yamlParse(settingsBefore) as { methodology_version?: string };
    assert.equal(parsed.methodology_version, undefined);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B3 — --force flag with .bak backup
// ============================================================================

test('upgrade --force: overwrites CONTEXT.md, saves .bak', async () => {
  const cwd = bootstrap();
  try {
    const contextPath = resolve(cwd, '.forge/CONTEXT.md');
    const edited = readFileSync(contextPath, 'utf8') + '\nLOCAL EDIT\n';
    writeFileSync(contextPath, edited);
    const result = await upgrade({ cwd, force: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('.forge/CONTEXT.md'));
    assert.ok(existsSync(`${contextPath}.bak`));
    assert.equal(readFileSync(`${contextPath}.bak`, 'utf8'), edited);
    assert.doesNotMatch(readFileSync(contextPath, 'utf8'), /LOCAL EDIT/);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B6 — --dry-run flag
// ============================================================================

test('upgrade --dry-run: reports changes without writing', async () => {
  const cwd = bootstrap();
  try {
    const contextPath = resolve(cwd, '.forge/CONTEXT.md');
    const corrupted = 'CORRUPTED CONTENT THAT DIFFERS FROM TEMPLATE\n';
    writeFileSync(contextPath, corrupted);
    const result = await upgrade({ cwd, force: true, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('.forge/CONTEXT.md'));
    // File unchanged
    assert.equal(readFileSync(contextPath, 'utf8'), corrupted);
    // No .bak written either
    assert.equal(existsSync(`${contextPath}.bak`), false);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B10 — exit 4 (CLI bundles older methodology than on-disk version)
// ============================================================================

test('upgrade: refuses with exit 4 when on-disk version is newer than CLI bundle', async () => {
  const cwd = bootstrap();
  try {
    writeFileSync(resolve(cwd, '.forge/.version'), '99.0.0\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /DOWNGRADE/);
    assert.match(result.stderr, /npm install -g/);
    assert.deepEqual([...result.filesChanged], []);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --force does NOT bypass cli-too-old refusal', async () => {
  const cwd = bootstrap();
  try {
    writeFileSync(resolve(cwd, '.forge/.version'), '99.0.0\n');
    const result = await upgrade({ cwd, force: true });
    assert.equal(result.exitCode, 4);
    assert.deepEqual([...result.filesChanged], []);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: refuses cleanly when .version=bundled but CONTEXT.md is stale (anomalous state)', async () => {
  // Simulates a state that the NEW write order (CONTEXT.md before .version)
  // can no longer produce, but which could exist if a third-party tool wrote
  // .version directly. Pin the behavior: this looks identical to "user edited
  // CONTEXT.md while versions match" and refuses with exit 1. The user must
  // either restore CONTEXT.md or run --force. Test exists to lock the contract
  // — a future relaxation (e.g., per-version SHAs) must be intentional.
  const cwd = bootstrap();
  try {
    const contextPath = resolve(cwd, '.forge/CONTEXT.md');
    // Mock the post-crash state: .version=bundled, CONTEXT.md=stale.
    writeFileSync(contextPath, 'STALE-CONTENT-FROM-OLD-VERSION\n');
    const result = await upgrade({ cwd });
    // The (versionsMatch && content-differs) path WILL refuse here — that is
    // actually correct behavior under the current rule: from upgrade's view,
    // this looks like the user edited CONTEXT.md while versions match.
    // The test pins this expectation so a future relaxation is intentional.
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /has local edits/);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: write-order is CONTEXT.md then .version (post-crash safety)', async () => {
  // If CONTEXT.md is fresh but .version is stale (crash after CONTEXT.md write
  // but before .version write), the next upgrade should refresh .version
  // silently — no edit-refusal, no rewrite of CONTEXT.md.
  const cwd = bootstrap();
  try {
    // Stale .version, but CONTEXT.md is the current bundled rendering (from bootstrap).
    writeFileSync(resolve(cwd, '.forge/.version'), '0.0.1\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    // .version was bumped; CONTEXT.md was NOT rewritten (SHA already matched).
    assert.ok(result.filesChanged.includes('.forge/.version'));
    assert.equal(
      result.filesChanged.includes('.forge/CONTEXT.md'),
      false,
      `CONTEXT.md should not be in filesChanged when SHA already matches: ${result.filesChanged.join(',')}`,
    );
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: older on-disk version still upgrades (no exit 4)', async () => {
  const cwd = bootstrap({ versionOverride: '0.0.1' });
  try {
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    // .version stamped to bundled
    assert.equal(
      readFileSync(resolve(cwd, '.forge/.version'), 'utf8').trim(),
      readBundledMethodologyVersion(),
    );
    assert.ok(result.filesChanged.includes('.forge/.version'));
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-161 — methodology_version pin
// ============================================================================

test('upgrade: stamps the methodology_version pin when absent (comment-preserving)', async () => {
  const cwd = bootstrap();
  try {
    // Drop the pin and add a user comment to assert byte-survival.
    const before = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')
      .replace(/methodology_version: .*\n/, '');
    const withComment = `# team-owned settings — do not delete\n${before}`;
    writeFileSync(join(cwd, '.forge/settings.yaml'), withComment);

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('.forge/settings.yaml'));

    const after = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');
    const bundled = readBundledMethodologyVersion();
    const parsed = yamlParse(after) as { methodology_version?: string };
    assert.equal(parsed.methodology_version, bundled);
    // Comment survived the surgical setIn (not nuked by a wholesale rewrite).
    assert.match(after, /# team-owned settings — do not delete/);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --dry-run: reports pin change without writing', async () => {
  const cwd = bootstrap();
  try {
    const noPin = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')
      .replace(/methodology_version: .*\n/, '');
    writeFileSync(join(cwd, '.forge/settings.yaml'), noPin);

    const result = await upgrade({ cwd, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.filesChanged.includes('.forge/settings.yaml'));
    // Not actually written in dry-run.
    const onDisk = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')) as {
      methodology_version?: string;
    };
    assert.equal(onDisk.methodology_version, undefined);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade: pin is no-op when already matching bundled version', async () => {
  const cwd = bootstrap();
  try {
    // bootstrap already pins to bundled → upgrade must not re-write settings.
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.filesChanged.includes('.forge/settings.yaml'),
      false,
      `settings should not be in changed: ${result.filesChanged.join(',')}`,
    );
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --add-agent + pin in one run: both writes land, neither clobbers the other', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'] });
  try {
    // Remove the pin so this run must BOTH add codex AND stamp the pin.
    const noPin = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')
      .replace(/methodology_version: .*\n/, '');
    writeFileSync(join(cwd, '.forge/settings.yaml'), noPin);

    const result = await upgrade({ cwd, addAgent: 'codex' });
    assert.equal(result.exitCode, 0);

    const parsed = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')) as {
      agents: { enabled_root_files: AgentKind[] };
      methodology_version?: string;
    };
    // add-agent's enabled_root_files mutation survived the pin write.
    assert.ok(parsed.agents.enabled_root_files.includes('codex'));
    // The pin write survived the add-agent rewrite (ordered AFTER it).
    assert.equal(parsed.methodology_version, readBundledMethodologyVersion());
    // settings.yaml listed (deduped — appears once).
    assert.equal(
      result.filesChanged.filter((f) => f === '.forge/settings.yaml').length,
      1,
    );
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B4 — --add-agent flag
// ============================================================================

test('upgrade --add-agent codex: writes AGENTS.md and updates settings', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'] });
  try {
    const result = await upgrade({ cwd, addAgent: 'codex' });
    assert.equal(result.exitCode, 0);
    assert.ok(existsSync(resolve(cwd, 'AGENTS.md')));
    assert.match(readFileSync(resolve(cwd, 'AGENTS.md'), 'utf8'), /<!-- >>> forge-managed/);
    const settings = yamlParse(readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8')) as {
      agents: { enabled_root_files: AgentKind[] };
    };
    assert.ok(settings.agents.enabled_root_files.includes('codex'));
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --add-agent: idempotent when agent already enabled', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'] });
  try {
    await upgrade({ cwd, addAgent: 'codex' });
    const second = await upgrade({ cwd, addAgent: 'codex' });
    assert.equal(second.exitCode, 0);
    // Second run: AGENTS.md already there, settings already has codex → no further changes.
    assert.deepEqual([...second.filesChanged], []);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --add-agent: does NOT cause double-write of the new root file', async () => {
  // Plan §4a: when --add-agent writes AGENTS.md, the step-6 loop must skip it
  // so we don't see AGENTS.md listed twice in filesChanged.
  const cwd = bootstrap({ enabledAgents: ['claude'] });
  try {
    const result = await upgrade({ cwd, addAgent: 'codex' });
    const occurrences = result.filesChanged.filter((f) => f === 'AGENTS.md').length;
    assert.equal(occurrences, 1, `AGENTS.md should appear once, got ${occurrences}: ${result.filesChanged.join(',')}`);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// B5 — --remove-agent flag
// ============================================================================

test('upgrade --remove-agent: deletes root file, updates settings (clean body)', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'] });
  try {
    const result = await upgrade({ cwd, removeAgent: 'codex' });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(resolve(cwd, 'AGENTS.md')), false);
    // No .pre-removal.bak when body was effectively empty
    assert.equal(existsSync(resolve(cwd, 'AGENTS.md.pre-removal.bak')), false);
    const settings = yamlParse(readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8')) as {
      agents: { enabled_root_files: AgentKind[] };
    };
    assert.equal(settings.agents.enabled_root_files.includes('codex'), false);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent: saves .pre-removal.bak when body has user content (with --confirm)', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'] });
  try {
    const agentsPath = resolve(cwd, 'AGENTS.md');
    const orig = readFileSync(agentsPath, 'utf8') + '\n## User extra\nimportant\n';
    writeFileSync(agentsPath, orig);
    const result = await upgrade({ cwd, removeAgent: 'codex', confirm: true });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(agentsPath), false);
    assert.ok(existsSync(`${agentsPath}.pre-removal.bak`));
    assert.equal(readFileSync(`${agentsPath}.pre-removal.bak`, 'utf8'), orig);
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent: refuses (exit 1) without --confirm if body has user content', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'] });
  try {
    const agentsPath = resolve(cwd, 'AGENTS.md');
    writeFileSync(agentsPath, readFileSync(agentsPath, 'utf8') + '\n## User extra\n');
    const result = await upgrade({ cwd, removeAgent: 'codex' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /user content below the marker block/);
    assert.ok(existsSync(agentsPath));
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent: refuses (exit 1) when removing primary_host_cli', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'], primary: 'claude' });
  try {
    const result = await upgrade({ cwd, removeAgent: 'claude', confirm: true });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /primary_host_cli/);
    assert.ok(existsSync(resolve(cwd, 'CLAUDE.md')));
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent: refuses when removal would empty enabled_root_files', async () => {
  // Plan §4b: don't let --remove-agent drop the schema below its min(1) floor.
  // Set up an unusual state: primary is codex but only claude is in enabled.
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'codex' });
  try {
    const result = await upgrade({ cwd, removeAgent: 'claude', confirm: true });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /enabled_root_files empty/);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-208 — symlink-safe writes
// ============================================================================

import { lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, linkSync } from 'node:fs';

type FsKind = 'file' | 'dir' | 'symlink' | 'other';

/** Recursively record the lstat TYPE of every path under root (relative paths). */
function lstatTypes(root: string): Map<string, FsKind> {
  const out = new Map<string, FsKind>();
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(abs)) {
      const childRel = rel === '' ? entry : `${rel}/${entry}`;
      const st = lstatSync(join(root, childRel));
      const kind: FsKind = st.isSymbolicLink()
        ? 'symlink'
        : st.isDirectory()
          ? 'dir'
          : st.isFile()
            ? 'file'
            : 'other';
      out.set(childRel, kind);
      if (kind === 'dir') walk(childRel);
    }
  };
  walk('');
  return out;
}

/** Recursively snapshot bytes of every regular file + link target of every
 * symlink under root. */
function byteSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, kind] of lstatTypes(root)) {
    if (kind === 'file') out.set(rel, readFileSync(join(root, rel), 'utf8'));
    if (kind === 'symlink') out.set(rel, `-> ${readlinkSync(join(root, rel))}`);
  }
  return out;
}

/** Bootstrap the CLAUDE.md → AGENTS.md parity topology: AGENTS.md is the real
 * file, CLAUDE.md is a symlink to it, both agents enabled. When
 * `agentsNeedsRefresh`, AGENTS.md is written WITHOUT its prefix block so the
 * upgrade has a real change to apply to the symlink TARGET. */
function bootstrapSymlinkTopology(opts: { agentsNeedsRefresh?: boolean } = {}): string {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'], primary: 'claude', skipRootFiles: true });
  const agentsBody = opts.agentsNeedsRefresh
    ? '# my-product\n\nuser body without a forge prefix block\n'
    : buildPrefixBlock('codex', { repoUrl: FORGE_REPO_URL });
  writeFileSync(join(cwd, 'AGENTS.md'), agentsBody);
  symlinkSync('AGENTS.md', join(cwd, 'CLAUDE.md'));
  return cwd;
}

// --- scenario 1: type-preservation property ---------------------------------

test('upgrade (FORGE-208 #1): lstat type of every pre-existing path is preserved across upgrade on the symlink topology', async () => {
  const cwd = bootstrapSymlinkTopology({ agentsNeedsRefresh: true });
  try {
    const before = lstatTypes(cwd);
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    // Property: every path that existed before still exists with the SAME
    // lstat type (file stays file, symlink stays symlink, dir stays dir).
    const after = lstatTypes(cwd);
    for (const [rel, kind] of before) {
      assert.equal(after.get(rel), kind, `lstat type changed for ${rel}: ${kind} → ${after.get(rel)}`);
    }

    // AGENTS.md (the real file) got its prefix block.
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- >>> forge-managed/, 'AGENTS.md got the prefix block');
    assert.match(agents, /user body without a forge prefix block/, 'user body preserved');
    assert.ok(result.filesChanged.includes('AGENTS.md'));

    // CLAUDE.md is STILL a symlink pointing at AGENTS.md.
    assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'AGENTS.md');

    // Skip notice on stderr; CLAUDE.md never enters `changed`.
    assert.match(result.stderr, /skipped: CLAUDE\.md \(symlink → AGENTS\.md\)/);
    assert.equal(result.filesChanged.includes('CLAUDE.md'), false, 'skipped symlink must not enter changed');
  } finally {
    cleanup(cwd);
  }
});

// --- scenario 2: idempotency property ----------------------------------------

test('upgrade (FORGE-208 #2a): twice == once on regular topology — zero changed + byte-identical on second run', async () => {
  const cwd = bootstrap({ versionOverride: '0.0.1' }); // stale → first run writes
  try {
    const first = await upgrade({ cwd });
    assert.equal(first.exitCode, 0);
    assert.ok(first.filesChanged.length > 0, 'first run applies the pending change');
    const snapshot = byteSnapshot(cwd);

    const second = await upgrade({ cwd });
    assert.equal(second.exitCode, 0);
    assert.deepEqual([...second.filesChanged], [], 'second run reports zero changed');
    assert.deepEqual(byteSnapshot(cwd), snapshot, 'second run leaves every byte identical');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade (FORGE-208 #2b): twice == once on symlink topology — zero changed, byte-identical, identical notice', async () => {
  const cwd = bootstrapSymlinkTopology({ agentsNeedsRefresh: true });
  try {
    const first = await upgrade({ cwd });
    assert.equal(first.exitCode, 0);
    assert.ok(first.filesChanged.includes('AGENTS.md'));
    const snapshot = byteSnapshot(cwd);

    const second = await upgrade({ cwd });
    assert.equal(second.exitCode, 0);
    assert.deepEqual([...second.filesChanged], [], 'second run reports zero changed');
    assert.deepEqual(byteSnapshot(cwd), snapshot, 'second run leaves every byte identical');
    assert.equal(second.stderr, first.stderr, 'skip notice identical across runs');
    assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), true, 'link survives both runs');
  } finally {
    cleanup(cwd);
  }
});

// --- scenario 3: dry-run parity ----------------------------------------------

test('upgrade (FORGE-208 #3): dry-run changed list + skip notices are IDENTICAL to the real run on the symlink topology', async () => {
  const cwd = bootstrapSymlinkTopology({ agentsNeedsRefresh: true });
  try {
    const dry = await upgrade({ cwd, dryRun: true });
    assert.equal(dry.exitCode, 0);
    // Dry-run wrote nothing.
    assert.doesNotMatch(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /forge-managed/);

    const real = await upgrade({ cwd });
    assert.equal(real.exitCode, 0);
    assert.deepEqual([...dry.filesChanged], [...real.filesChanged], 'changed lists identical');
    assert.equal(dry.stderr, real.stderr, 'skip notices identical');
    assert.match(dry.stderr, /skipped: CLAUDE\.md \(symlink → AGENTS\.md\)/);
  } finally {
    cleanup(cwd);
  }
});

// --- scenario 5: --add-agent onto a symlinked root file -----------------------

test('upgrade --add-agent (FORGE-208 #5): refuses (exit 1) when the agent root file is a symlink; nothing written', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'] });
  try {
    writeFileSync(join(cwd, 'real-agents.md'), 'real target\n');
    symlinkSync('real-agents.md', join(cwd, 'AGENTS.md'));
    const settingsBefore = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');

    const result = await upgrade({ cwd, addAgent: 'codex' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--add-agent: AGENTS\.md is a symbolic link/);
    assert.match(result.stderr, /Resolve the symlink or replace with a regular file first/);
    assert.deepEqual([...result.filesChanged], []);

    // No write: settings unchanged, link + target intact.
    assert.equal(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8'), settingsBefore);
    assert.equal(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(cwd, 'real-agents.md'), 'utf8'), 'real target\n');
  } finally {
    cleanup(cwd);
  }
});

// --- scenarios 6 + 10: symlinked .forge/settings.yaml -------------------------

/** Replace .forge/settings.yaml with a symlink to a real copy in the repo. */
function symlinkSettings(cwd: string): void {
  const content = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');
  writeFileSync(join(cwd, 'real-settings.yaml'), content);
  unlinkSync(join(cwd, '.forge/settings.yaml'));
  symlinkSync('../real-settings.yaml', join(cwd, '.forge/settings.yaml'));
}

test('upgrade (FORGE-208 #6): refuses (exit 1) upfront when .forge/settings.yaml is a symlink', async () => {
  const cwd = bootstrap();
  try {
    symlinkSettings(cwd);
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /settings\.yaml is a symbolic link/);
    assert.deepEqual([...result.filesChanged], []);
    assert.equal(lstatSync(join(cwd, '.forge/settings.yaml')).isSymbolicLink(), true, 'link intact');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade (FORGE-208 #10): symlinked settings.yaml refusal happens before ANY mutation, even with pending changes', async () => {
  // Stale version → without the refusal, this run WOULD rewrite CONTEXT.md +
  // .version + root files. Assert none of that happened.
  const cwd = bootstrap({ versionOverride: '0.0.1' });
  try {
    symlinkSettings(cwd);
    const before = byteSnapshot(cwd);
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /settings\.yaml is a symbolic link/);
    assert.deepEqual([...result.filesChanged], []);
    assert.deepEqual(byteSnapshot(cwd), before, 'NOTHING written: CONTEXT.md/.version/root files/.gitignore all untouched');
    assert.equal(existsSync(join(cwd, '.forge/CONTEXT.md.bak')), false, 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

// --- FORGE-160: symlinked `.forge` DIRECTORY (not just the settings.yaml leaf) -

/** Move the whole `.forge` dir out of tree and replace it with a symlink to the
 * relocated real dir — the escape vector a leaf-only check misses. */
function symlinkForgeDir(cwd: string): string {
  const realForge = join(cwd, 'real-forge');
  renameSync(join(cwd, '.forge'), realForge);
  symlinkSync('real-forge', join(cwd, '.forge'));
  return realForge;
}

test('upgrade (FORGE-160): refuses (exit 1) upfront when `.forge` is a symlinked directory; nothing written through the link', async () => {
  // Stale version → without the refusal this WOULD rewrite CONTEXT.md + .version
  // THROUGH the link into the relocated real dir. Assert none of that happened.
  const cwd = bootstrap({ versionOverride: '0.0.1' });
  try {
    const realForge = symlinkForgeDir(cwd);
    const before = byteSnapshot(realForge);
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\.forge is a symbolic link/);
    assert.deepEqual([...result.filesChanged], []);
    assert.equal(lstatSync(join(cwd, '.forge')).isSymbolicLink(), true, 'link intact');
    assert.equal(readlinkSync(join(cwd, '.forge')), 'real-forge');
    assert.deepEqual(byteSnapshot(realForge), before, 'NOTHING written through the link');
  } finally {
    cleanup(cwd);
  }
});

// --- scenario 7: symlinked .gitignore -----------------------------------------

test('upgrade (FORGE-208 #7): symlinked .gitignore is skipped with notice, exit 0, link intact', async () => {
  const cwd = bootstrap();
  try {
    // Replace .gitignore with a symlink to a file WITHOUT the marker block,
    // so the step-8 refresh would otherwise have a change to write.
    unlinkSync(join(cwd, '.gitignore'));
    writeFileSync(join(cwd, 'real-gitignore'), 'node_modules\n');
    symlinkSync('real-gitignore', join(cwd, '.gitignore'));

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /skipped: \.gitignore \(symlink → real-gitignore\)/);
    assert.equal(result.filesChanged.includes('.gitignore'), false, 'skipped symlink must not enter changed');
    assert.equal(lstatSync(join(cwd, '.gitignore')).isSymbolicLink(), true, 'link intact');
    assert.equal(readFileSync(join(cwd, 'real-gitignore'), 'utf8'), 'node_modules\n', 'target untouched');
  } finally {
    cleanup(cwd);
  }
});

// --- scenario 11: --remove-agent on a symlinked root file ---------------------

test('upgrade --remove-agent (FORGE-208 #11): refuses (exit 1) when the root file is a symlink; link intact', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude', 'codex'] });
  try {
    const orig = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    unlinkSync(join(cwd, 'AGENTS.md'));
    writeFileSync(join(cwd, 'real-agents.md'), orig);
    symlinkSync('real-agents.md', join(cwd, 'AGENTS.md'));
    const settingsBefore = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');

    const result = await upgrade({ cwd, removeAgent: 'codex', confirm: true });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--remove-agent: AGENTS\.md is a symbolic link/);
    assert.equal(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink(), true, 'link intact');
    assert.equal(readFileSync(join(cwd, 'real-agents.md'), 'utf8'), orig, 'target untouched');
    assert.equal(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8'), settingsBefore, 'settings untouched');
    assert.equal(existsSync(join(cwd, 'AGENTS.md.pre-removal.bak')), false, 'no .bak');
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-160 — cursor host upgrade topology
// ============================================================================

test('FORGE-160 — add-agent cursor materializes .cursor/rules/forge-context.mdc (frontmatter-first + inlined context)', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude' });
  try {
    const result = await upgrade({ cwd, addAgent: 'cursor' });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const mdcPath = join(cwd, '.cursor/rules/forge-context.mdc');
    assert.ok(existsSync(mdcPath), '.mdc materialized');
    const body = readFileSync(mdcPath, 'utf8');
    assert.ok(body.startsWith('---\n'), 'frontmatter is first bytes');
    assert.match(body, /^---\nalwaysApply: true\n/);
    assert.match(body, /<!-- >>> forge-managed/, 'marker block present');
    // inlined context: the rendered CONTEXT.md heading should appear inside.
    assert.match(body, /Forge methodology|forge methodology|CLI surface/i);
    assert.ok(result.filesChanged.includes('.cursor/rules/forge-context.mdc'));
  } finally {
    cleanup(cwd);
  }
});

test('FORGE-160 — cursor upgrade twice == once (idempotent, byte-identical, zero changed on 2nd run)', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude' });
  try {
    // First: add cursor (materializes the .mdc + farm).
    const add = await upgrade({ cwd, addAgent: 'cursor' });
    assert.equal(add.exitCode, 0);
    const snapshot = byteSnapshot(cwd);

    // Second: plain upgrade (no flags) must be a no-op.
    const second = await upgrade({ cwd });
    assert.equal(second.exitCode, 0);
    assert.equal(
      second.filesChanged.length,
      0,
      `second run should be a no-op, changed: ${JSON.stringify(second.filesChanged)}`,
    );
    const after = byteSnapshot(cwd);
    assert.deepEqual([...after.entries()].sort(), [...snapshot.entries()].sort());
  } finally {
    cleanup(cwd);
  }
});

test('FORGE-160 — remove-agent cursor deletes the .mdc with no --confirm and leaves no forge-owned residue', async () => {
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude' });
  try {
    await upgrade({ cwd, addAgent: 'cursor' });
    assert.ok(existsSync(join(cwd, '.cursor/rules/forge-context.mdc')));
    assert.ok(existsSync(join(cwd, '.agents/skills')), 'cursor farm created');

    // remove-agent cursor: no --confirm needed (the .mdc is fully forge-owned).
    const rm = await upgrade({ cwd, removeAgent: 'cursor' });
    assert.equal(rm.exitCode, 0, `stderr: ${rm.stderr}`);
    assert.equal(existsSync(join(cwd, '.cursor/rules/forge-context.mdc')), false, '.mdc removed');

    // Farm entries pruned (cursor was the only host on .agents/skills).
    const agentsSkills = join(cwd, '.agents/skills');
    if (existsSync(agentsSkills)) {
      assert.equal(readdirSync(agentsSkills).length, 0, '.agents/skills emptied of forge entries');
    }
    // settings no longer lists cursor.
    const settings = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8')) as {
      agents: { enabled_root_files: string[] };
    };
    assert.equal(settings.agents.enabled_root_files.includes('cursor'), false);
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-208 (one level up) — symlinked PARENT directory of cursor's nested .mdc
// ============================================================================

/** Enable cursor in settings (so the refresh loop tries to write its .mdc) but
 * DON'T create root files — the test installs a symlinked .cursor parent
 * instead, and CLAUDE.md is irrelevant here. `skipRootFiles` also avoids the
 * bootstrap helper calling buildPrefixBlock('cursor') (which throws by design).
 * CLAUDE.md is written explicitly so the claude refresh-loop iteration is a
 * no-op and the only stderr line is the cursor parent-symlink skip notice. */
function bootstrapCursorEnabled(): string {
  const cwd = bootstrap({ enabledAgents: ['claude', 'cursor'], primary: 'claude', skipRootFiles: true });
  writeFileSync(join(cwd, 'CLAUDE.md'), buildPrefixBlock('claude', { repoUrl: FORGE_REPO_URL }));
  return cwd;
}

test('upgrade (FORGE-208 parent #1): symlinked `.cursor` dir → cursor refresh skips with notice, nothing written through the link, link intact', async () => {
  const cwd = bootstrapCursorEnabled();
  try {
    // Replace the bootstrap's real .cursor (farm dir) with a symlink to an
    // out-of-tree real directory — the escape vector under test.
    rmSync(join(cwd, '.cursor'), { recursive: true, force: true });
    const escapeRoot = mkdtempSync(join(tmpdir(), 'forge-escape-'));
    symlinkSync(escapeRoot, join(cwd, '.cursor'));

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    // Skip notice naming the symlinked parent; .mdc never enters `changed`.
    assert.match(result.stderr, /\.cursor\/rules\/forge-context\.mdc \(parent \.cursor is a symlink/);
    assert.equal(
      result.filesChanged.includes('.cursor/rules/forge-context.mdc'),
      false,
      'skipped cursor artifact must not enter changed',
    );

    // The link is intact and NOTHING was written through it.
    assert.equal(lstatSync(join(cwd, '.cursor')).isSymbolicLink(), true, '.cursor still a symlink');
    assert.equal(readlinkSync(join(cwd, '.cursor')), escapeRoot);
    assert.equal(existsSync(join(escapeRoot, 'rules')), false, 'no write-through to the link target');
    rmSync(escapeRoot, { recursive: true, force: true });
  } finally {
    cleanup(cwd);
  }
});

test('upgrade (FORGE-208 parent #2): symlinked `.cursor/rules` dir → cursor refresh skips with notice, link intact, no write-through', async () => {
  const cwd = bootstrapCursorEnabled();
  try {
    // .cursor is a real dir; .cursor/rules is a symlink to an out-of-tree dir.
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const escapeRoot = mkdtempSync(join(tmpdir(), 'forge-escape-'));
    symlinkSync(escapeRoot, join(cwd, '.cursor/rules'));

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    assert.match(
      result.stderr,
      /\.cursor\/rules\/forge-context\.mdc \(parent \.cursor\/rules is a symlink/,
    );
    assert.equal(result.filesChanged.includes('.cursor/rules/forge-context.mdc'), false);

    assert.equal(lstatSync(join(cwd, '.cursor/rules')).isSymbolicLink(), true, '.cursor/rules still a symlink');
    assert.equal(
      existsSync(join(escapeRoot, 'forge-context.mdc')),
      false,
      'no write-through to the link target',
    );
    rmSync(escapeRoot, { recursive: true, force: true });
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-160 (round 2) — --remove-agent cursor with a symlinked PARENT directory
// of the nested .mdc. The leaf check alone would let unlinkSync reach THROUGH
// the link and delete a file outside the working tree. The parent guard must
// fire FIRST: skip the deletion with a notice, leave the link + target intact,
// but still remove cursor from enabled_root_files.
// ============================================================================

/** Enable claude (primary) + cursor; place a REAL forge-context.mdc at an
 * out-of-tree target and symlink `parentRel` to that target's tree, proving a
 * through-symlink delete would destroy the target file if the guard regressed. */
function bootstrapRemoveCursorSymlinkedParent(parentRel: '.cursor' | '.cursor/rules'): {
  cwd: string;
  escapeRoot: string;
  mdcAtTarget: string;
} {
  const cwd = bootstrap({ enabledAgents: ['claude', 'cursor'], primary: 'claude', skipRootFiles: true });
  writeFileSync(join(cwd, 'CLAUDE.md'), buildPrefixBlock('claude', { repoUrl: FORGE_REPO_URL }));
  const escapeRoot = mkdtempSync(join(tmpdir(), 'forge-escape-'));

  if (parentRel === '.cursor') {
    mkdirSync(join(escapeRoot, 'rules'), { recursive: true });
    writeFileSync(join(escapeRoot, 'rules', 'forge-context.mdc'), '---\nforge: owned\n---\n');
    rmSync(join(cwd, '.cursor'), { recursive: true, force: true });
    symlinkSync(escapeRoot, join(cwd, '.cursor'));
    return { cwd, escapeRoot, mdcAtTarget: join(escapeRoot, 'rules', 'forge-context.mdc') };
  }
  writeFileSync(join(escapeRoot, 'forge-context.mdc'), '---\nforge: owned\n---\n');
  mkdirSync(join(cwd, '.cursor'), { recursive: true });
  symlinkSync(escapeRoot, join(cwd, '.cursor/rules'));
  return { cwd, escapeRoot, mdcAtTarget: join(escapeRoot, 'forge-context.mdc') };
}

test('upgrade --remove-agent cursor (FORGE-160 parent #1): symlinked `.cursor` → nothing deleted through the link, link intact, notice emitted', async () => {
  const { cwd, escapeRoot, mdcAtTarget } = bootstrapRemoveCursorSymlinkedParent('.cursor');
  try {
    const result = await upgrade({ cwd, removeAgent: 'cursor' });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    assert.match(result.stderr, /\.cursor\/rules\/forge-context\.mdc \(parent \.cursor is a symlink/);
    assert.equal(result.filesChanged.includes('.cursor/rules/forge-context.mdc'), false);

    assert.equal(lstatSync(join(cwd, '.cursor')).isSymbolicLink(), true, '.cursor still a symlink');
    assert.equal(readlinkSync(join(cwd, '.cursor')), escapeRoot);
    assert.equal(existsSync(mdcAtTarget), true, 'target .mdc must survive — no delete-through');

    const settings = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8'));
    assert.equal(settings.agents.enabled_root_files.includes('cursor'), false);

    rmSync(escapeRoot, { recursive: true, force: true });
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent cursor (FORGE-160 parent #2): symlinked `.cursor/rules` → nothing deleted through the link, link intact, notice emitted', async () => {
  const { cwd, escapeRoot, mdcAtTarget } = bootstrapRemoveCursorSymlinkedParent('.cursor/rules');
  try {
    const result = await upgrade({ cwd, removeAgent: 'cursor' });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);

    assert.match(
      result.stderr,
      /\.cursor\/rules\/forge-context\.mdc \(parent \.cursor\/rules is a symlink/,
    );
    assert.equal(result.filesChanged.includes('.cursor/rules/forge-context.mdc'), false);

    assert.equal(lstatSync(join(cwd, '.cursor/rules')).isSymbolicLink(), true, '.cursor/rules still a symlink');
    assert.equal(existsSync(mdcAtTarget), true, 'target .mdc must survive — no delete-through');

    const settings = yamlParse(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8'));
    assert.equal(settings.agents.enabled_root_files.includes('cursor'), false);

    rmSync(escapeRoot, { recursive: true, force: true });
  } finally {
    cleanup(cwd);
  }
});

test('upgrade --remove-agent cursor (FORGE-160 parent #3): dry-run parity — notice + changed identical to real run, target untouched', async () => {
  const { cwd, escapeRoot, mdcAtTarget } = bootstrapRemoveCursorSymlinkedParent('.cursor');
  try {
    const dry = await upgrade({ cwd, removeAgent: 'cursor', dryRun: true });
    assert.equal(dry.exitCode, 0, `stderr: ${dry.stderr}`);
    assert.match(dry.stderr, /\.cursor\/rules\/forge-context\.mdc \(parent \.cursor is a symlink/);
    assert.equal(dry.filesChanged.includes('.cursor/rules/forge-context.mdc'), false);
    assert.equal(existsSync(mdcAtTarget), true, 'dry-run must not delete the target');
    assert.equal(lstatSync(join(cwd, '.cursor')).isSymbolicLink(), true);
    rmSync(escapeRoot, { recursive: true, force: true });
  } finally {
    cleanup(cwd);
  }
});

// ============================================================================
// FORGE-197 — statusLine host-config (opt-in gated; injected fake home)
// ============================================================================

/** Append a `hosts.claude.status_line` block to a bootstrapped repo's settings. */
function setStatusLineOptIn(cwd: string, value: boolean): void {
  const settingsPath = join(cwd, '.forge/settings.yaml');
  const current = readFileSync(settingsPath, 'utf8');
  writeFileSync(
    settingsPath,
    `${current}hosts:\n  claude:\n    status_line: ${value}\n`,
    'utf8',
  );
}

test('FORGE-197: opt-in true → upgrade writes statusLine into the injected fake home', async () => {
  const cwd = bootstrap();
  const fakeHome = mkdtempSync(join(tmpdir(), 'forge-upgrade-home-'));
  try {
    setStatusLineOptIn(cwd, true);
    const result = await upgrade({ cwd, hostConfigHomeDir: fakeHome });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const settingsJson = join(fakeHome, '.claude', 'settings.json');
    assert.equal(existsSync(settingsJson), true, 'statusLine must be written into the fake home');
    const parsed = JSON.parse(readFileSync(settingsJson, 'utf8'));
    assert.deepEqual(parsed.statusLine, { type: 'command', command: 'forge statusline' });
    assert.match(result.stderr, /statusLine/);
  } finally {
    cleanup(cwd);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('FORGE-197: opt-in false (default) → NO write, discovery notice surfaced', async () => {
  const cwd = bootstrap();
  const fakeHome = mkdtempSync(join(tmpdir(), 'forge-upgrade-home-'));
  try {
    // No hosts block at all → status_line defaults false.
    const result = await upgrade({ cwd, hostConfigHomeDir: fakeHome });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const settingsJson = join(fakeHome, '.claude', 'settings.json');
    assert.equal(existsSync(settingsJson), false, 'must NOT write the global config when opt-out');
    // The discovery offer is on the dedicated field, NOT in the pinned stderr.
    assert.match(result.discoveryNotice ?? '', /status_line: true/);
    assert.equal(result.stderr, '', 'discovery notice must not pollute the deterministic stderr');
  } finally {
    cleanup(cwd);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('FORGE-197: opt-in false + FORGE_QUIET=1 → no discovery notice', async () => {
  const cwd = bootstrap();
  const fakeHome = mkdtempSync(join(tmpdir(), 'forge-upgrade-home-'));
  const prior = process.env.FORGE_QUIET;
  process.env.FORGE_QUIET = '1';
  try {
    const result = await upgrade({ cwd, hostConfigHomeDir: fakeHome });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.discoveryNotice, undefined);
    assert.equal(existsSync(join(fakeHome, '.claude', 'settings.json')), false);
  } finally {
    if (prior === undefined) delete process.env.FORGE_QUIET;
    else process.env.FORGE_QUIET = prior;
    cleanup(cwd);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('FORGE-197: opt-in true + dryRun → no write, dry-run notice', async () => {
  const cwd = bootstrap();
  const fakeHome = mkdtempSync(join(tmpdir(), 'forge-upgrade-home-'));
  try {
    setStatusLineOptIn(cwd, true);
    const result = await upgrade({ cwd, dryRun: true, hostConfigHomeDir: fakeHome });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(existsSync(join(fakeHome, '.claude', 'settings.json')), false);
    assert.match(result.stderr, /would write statusLine/);
  } finally {
    cleanup(cwd);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ============================================================================
// FORGE-209 — readlink-guarded notices, enabled-set awareness, hardlink skips
// ============================================================================

// --- 209-(4): symlinkSkipNotice enabled-set awareness -------------------------

test('upgrade (FORGE-209-(4)): CLAUDE.md → AGENTS.md but codex NOT enabled → notice says target is NOT managed by any enabled host', async () => {
  // ONLY claude enabled. CLAUDE.md is a symlink to AGENTS.md, whose host (codex)
  // is NOT enabled — so no loop iteration maintains a methodology block anywhere.
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude', skipRootFiles: true });
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), '# external target, not forge-managed\n');
    symlinkSync('AGENTS.md', join(cwd, 'CLAUDE.md'));

    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /skipped: CLAUDE\.md \(symlink → AGENTS\.md\)/);
    assert.match(result.stderr, /NOT managed by any enabled host/);
    assert.match(result.stderr, /no methodology block is maintained anywhere/);
    assert.equal(result.filesChanged.includes('CLAUDE.md'), false);
    // Link + target untouched.
    assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), '# external target, not forge-managed\n');
  } finally {
    cleanup(cwd);
  }
});

test('upgrade (FORGE-209-(4)): CLAUDE.md → AGENTS.md with codex ENABLED → notice says target is managed by host codex', async () => {
  // Both claude + codex enabled, CLAUDE.md → AGENTS.md (codex's real root file).
  const cwd = bootstrapSymlinkTopology({ agentsNeedsRefresh: true });
  try {
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /skipped: CLAUDE\.md \(symlink → AGENTS\.md\)/);
    assert.match(result.stderr, /target AGENTS\.md is managed by host codex/);
    assert.doesNotMatch(result.stderr, /NOT managed by any enabled host/);
  } finally {
    cleanup(cwd);
  }
});

// --- 209-(1): readlink guard — vanished link degrades gracefully --------------

test('upgrade (FORGE-209-(1)): a dangling root-file symlink (readlink ok but target absent) still skips with a notice, exit 0', async () => {
  // A dangling symlink: lstat sees a symlink, readlink succeeds (returns the
  // missing target name). The notice is produced without crashing; upgrade
  // exits 0. (The unguarded crash path is readlink itself failing — covered by
  // the host-config/guard unit tests; here we assert the upgrade stays green.)
  const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude', skipRootFiles: true });
  try {
    symlinkSync('vanished-target.md', join(cwd, 'CLAUDE.md')); // dangling
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /skipped: CLAUDE\.md \(symlink/);
    assert.equal(result.filesChanged.includes('CLAUDE.md'), false);
    assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), true, 'dangling link survives');
  } finally {
    cleanup(cwd);
  }
});

// --- 209-(5): hardlinked root file / .gitignore skip-with-notice --------------

test('upgrade (FORGE-209-(5)): a hard-linked root file is skipped with a notice; no partial write; exit 0', (t) => {
  return (async () => {
    const cwd = bootstrap({ enabledAgents: ['claude'], primary: 'claude', skipRootFiles: true, versionOverride: '0.0.1' });
    try {
      // CLAUDE.md WITHOUT its prefix block, hard-linked to a sibling. The stale
      // version forces a pending refresh, so without the precheck writeAtomic
      // would HARDLINK_TARGET_REFUSED mid-run (after CONTEXT.md/.version writes).
      writeFileSync(join(cwd, 'claude-twin.md'), '# user body, no forge block\n');
      try {
        linkSync(join(cwd, 'claude-twin.md'), join(cwd, 'CLAUDE.md'));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(code)) {
          return t.skip('hard links unsupported on this filesystem');
        }
        throw err;
      }
      assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).nlink, 2);

      const result = await upgrade({ cwd });
      assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /skipped: CLAUDE\.md \(hard link\)/);
      assert.equal(result.filesChanged.includes('CLAUDE.md'), false, 'hardlink must not enter changed');
      // Both names still hold the original content, still linked (no detach).
      assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), '# user body, no forge block\n');
      assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).nlink, 2, 'link relationship intact');
      // The version refresh STILL happened (CONTEXT.md/.version got written) —
      // proving the skip is surgical, not an abort.
      assert.ok(result.filesChanged.includes('.forge/CONTEXT.md'));
    } finally {
      cleanup(cwd);
    }
  })();
});

test('upgrade (FORGE-209-(5)): a hard-linked .gitignore is skipped with a notice; exit 0; link intact', (t) => {
  return (async () => {
    const cwd = bootstrap();
    try {
      unlinkSync(join(cwd, '.gitignore'));
      writeFileSync(join(cwd, 'gitignore-twin'), 'node_modules\n'); // no marker block
      try {
        linkSync(join(cwd, 'gitignore-twin'), join(cwd, '.gitignore'));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(code)) {
          return t.skip('hard links unsupported on this filesystem');
        }
        throw err;
      }
      const result = await upgrade({ cwd });
      assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /skipped: \.gitignore \(hard link\)/);
      assert.equal(result.filesChanged.includes('.gitignore'), false);
      assert.equal(lstatSync(join(cwd, '.gitignore')).nlink, 2, 'link relationship intact');
      assert.equal(readFileSync(join(cwd, 'gitignore-twin'), 'utf8'), 'node_modules\n', 'twin untouched');
    } finally {
      cleanup(cwd);
    }
  })();
});

test('upgrade --add-agent (FORGE-209-(5)): refuses (exit 1) when the agent root file is a hard link; nothing written', (t) => {
  return (async () => {
    const cwd = bootstrap({ enabledAgents: ['claude'] });
    try {
      writeFileSync(join(cwd, 'agents-twin.md'), 'real target\n');
      try {
        linkSync(join(cwd, 'agents-twin.md'), join(cwd, 'AGENTS.md'));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(code)) {
          return t.skip('hard links unsupported on this filesystem');
        }
        throw err;
      }
      const settingsBefore = readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8');
      const result = await upgrade({ cwd, addAgent: 'codex' });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--add-agent: AGENTS\.md is a hard link/);
      assert.deepEqual([...result.filesChanged], []);
      assert.equal(readFileSync(join(cwd, '.forge/settings.yaml'), 'utf8'), settingsBefore, 'settings untouched');
    } finally {
      cleanup(cwd);
    }
  })();
});

test('upgrade (FORGE-209-(5), GPT-5.5 B1): a hard-linked .forge/CONTEXT.md refuses UPFRONT (exit 1); no partial write', (t) => {
  return (async () => {
    const cwd = bootstrap();
    try {
      // CONTEXT.md is written unconditionally early; a hardlinked one would make
      // writeAtomic HARDLINK_TARGET_REFUSED mid-run after other writes. The
      // upfront forge-owned-file guard must refuse before ANY mutation.
      // bootstrap() may already have materialized CONTEXT.md — remove it so the
      // hardlink (which requires a non-existent destination) can be created.
      if (existsSync(join(cwd, '.forge/CONTEXT.md'))) unlinkSync(join(cwd, '.forge/CONTEXT.md'));
      writeFileSync(join(cwd, '.forge/context-twin.md'), 'shared\n');
      try {
        linkSync(join(cwd, '.forge/context-twin.md'), join(cwd, '.forge/CONTEXT.md'));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(code)) {
          return t.skip('hard links unsupported on this filesystem');
        }
        throw err;
      }
      const result = await upgrade({ cwd });
      assert.equal(result.exitCode, 1, `stderr: ${result.stderr}`);
      assert.match(result.stderr, /\.forge\/CONTEXT\.md is a hard link/);
      assert.deepEqual([...result.filesChanged], [], 'nothing written on refusal');
      assert.equal(lstatSync(join(cwd, '.forge/CONTEXT.md')).nlink, 2, 'link relationship intact');
      assert.equal(readFileSync(join(cwd, '.forge/context-twin.md'), 'utf8'), 'shared\n', 'twin untouched');
    } finally {
      cleanup(cwd);
    }
  })();
});
