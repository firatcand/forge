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
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: ${primary}\n  review_host_cli: ${finalReview === null ? 'null' : finalReview}\n  enabled_root_files:\n${enabled.map((a) => `    - ${a}`).join('\n')}\ndesign:\n  mode: project_owned\n`,
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
  // value like "cursor", throwing mid-write. With schema validation, this
  // must fail fast (exit 3) before any disk mutation.
  const cwd = mkdtempSync(join(tmpdir(), 'forge-upgrade-'));
  try {
    mkdirSync(join(cwd, '.forge'));
    writeFileSync(
      join(cwd, '.forge/settings.yaml'),
      `version: 1\nproject:\n  name: t\ntracker:\n  type: github\n  config:\n    repo: o/r\nsecrets:\n  manager: env_file\n  env_file_path: ./.env\nagents:\n  primary_host_cli: claude\n  review_host_cli: codex\n  enabled_root_files:\n    - claude\n    - cursor\ndesign:\n  mode: project_owned\n`,
    );
    writeFileSync(join(cwd, '.forge/.version'), `${readBundledMethodologyVersion()}\n`);
    // Sentinel file — if upgrade writes anything before validating, it would
    // touch CONTEXT.md.
    writeFileSync(join(cwd, '.forge/CONTEXT.md'), 'SENTINEL\n');
    const result = await upgrade({ cwd });
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /enabled_root_files|cursor|invalid/i);
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

import { lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';

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
