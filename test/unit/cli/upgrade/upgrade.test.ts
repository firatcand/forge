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
  const settings = {
    version: 1,
    project: { name: 'test-project' },
    tracker: { type: 'github', config: { repo: 'org/repo' } },
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {
      primary_host_cli: primary,
      review_host_cli: primary === 'codex' ? 'gemini' : 'codex',
      enabled_root_files: enabled,
    },
    design: { mode: 'project_owned' },
  };
  writeFileSync(
    join(cwd, '.forge/settings.yaml'),
    `version: 1\nproject:\n  name: test-project\ntracker:\n  type: github\n  config:\n    repo: org/repo\nsecrets:\n  manager: env_file\n  env_file_path: ./.env.local\nagents:\n  primary_host_cli: ${settings.agents.primary_host_cli}\n  review_host_cli: ${settings.agents.review_host_cli}\n  enabled_root_files:\n${enabled.map((a) => `    - ${a}`).join('\n')}\ndesign:\n  mode: project_owned\n`,
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
