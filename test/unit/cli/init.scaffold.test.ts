import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import {
  scaffoldProject,
  appendLineIfMissing,
  appendToolingExcludes,
  toMinimalYamlObject,
} from '../../../src/cli/init/scaffold.ts';
import { SettingsSchema } from '../../../src/schemas/index.ts';
import type { InitAnswers } from '../../../src/cli/init/prompts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const templatesDir = resolve(repoRoot, 'templates');
const goldenPath = resolve(repoRoot, 'test/fixtures/init/golden-settings.yaml');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-scaffold-'));
}

function fixtureAnswers(): InitAnswers {
  return {
    project: { name: 'sample-app', description: 'a sample app' },
    goal: 'ship a sample app with forge',
    tracker: { type: 'linear', config: { team_id: 'TEAM-1' } },
    github_connected: false,
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude'],
    },
    design: { mode: 'project_owned' },
  };
}

test('scaffoldProject writes all expected artefacts', () => {
  const cwd = tmp();
  const result = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  for (const f of [
    'spec/BRIEF.md',
    'spec/PRD.md',
    'spec/SPEC.md',
    'spec/DESIGN.md',
    'CRITICAL.md',
    'CLAUDE.md',
    'plans/tasks/.gitkeep',
    '.forge/settings.yaml',
  ]) {
    assert.ok(existsSync(resolve(cwd, f)), `expected ${f}`);
  }
  assert.ok(result.written.includes('.gitignore'));
});

test('scaffold writes a .forge/.env credentials seed with the allowlisted keys', () => {
  const cwd = tmp();
  const result = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const envPath = resolve(cwd, '.forge/.env');
  assert.ok(existsSync(envPath), 'expected .forge/.env');
  assert.ok(result.written.includes('.forge/.env'));
  const env = readFileSync(envPath, 'utf8');
  assert.match(env, /LINEAR_API_KEY/);
  assert.match(env, /git-ignored/);
});

test('scaffold never clobbers an existing .forge/.env (create-once — real secret survives)', () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  const real = 'LINEAR_API_KEY=lin_real_user_secret\n';
  writeFileSync(resolve(cwd, '.forge/.env'), real, 'utf8');
  const result = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  assert.equal(readFileSync(resolve(cwd, '.forge/.env'), 'utf8'), real, 'user secret must be preserved');
  assert.ok(result.skipped.includes('.forge/.env'), '.forge/.env should be skipped when it already exists');
});

test('scaffolded settings.yaml round-trips through SettingsSchema', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const raw = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8');
  const parsed = SettingsSchema.safeParse(yamlParse(raw));
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.project.name, 'sample-app');
    assert.equal(parsed.data.tracker.type, 'linear');
  }
});

test('scaffolded settings.yaml matches golden fixture (byte-for-byte minus trailing whitespace)', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const actual = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8').trim();
  const expected = readFileSync(goldenPath, 'utf8').trim();
  assert.equal(actual, expected, `\nEXPECTED:\n${expected}\n\nACTUAL:\n${actual}\n`);
});

test('scaffold injects goal into spec/BRIEF.md ## Product section', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const brief = readFileSync(resolve(cwd, 'spec/BRIEF.md'), 'utf8');
  assert.match(brief, /## Product\nship a sample app with forge/);
  // The original REQUIRED comment should be replaced (not duplicated).
  assert.equal(/<!-- REQUIRED: One or two sentences. What does this product DO\? -->/.test(brief), false);
});

test('scaffold renders {{PROJECT_NAME}} in CLAUDE.md and templates', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const claude = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /# sample-app/);
  const prd = readFileSync(resolve(cwd, 'spec/PRD.md'), 'utf8');
  assert.match(prd, /sample-app — PRD/);
});

test('scaffold renders {{ISO_DATE}}', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const brief = readFileSync(resolve(cwd, 'spec/BRIEF.md'), 'utf8');
  assert.match(brief, /Forged: 2026-05-12/);
});

test('.gitignore append is idempotent', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const after1 = readFileSync(resolve(cwd, '.gitignore'), 'utf8');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12', overwrite: { 'CLAUDE.md': true, 'CRITICAL.md': true, 'spec/BRIEF.md': true, 'spec/PRD.md': true, 'spec/SPEC.md': true, 'spec/DESIGN.md': true, 'plans/tasks/.gitkeep': true } });
  const after2 = readFileSync(resolve(cwd, '.gitignore'), 'utf8');
  assert.equal(after1, after2);
});

// FORGE-152: appendGitignoreBlock removed; the new .gitignore writer is
// applyGitignoreBlock in src/cli/upgrade/gitignore-block.ts. Its unit tests
// live in test/unit/cli/upgrade/gitignore-block.test.ts.

test('FORGE-152: scaffold writes CLAUDE.md only when claude is enabled', () => {
  const cwd = tmp();
  const answers = fixtureAnswers();
  scaffoldProject({ cwd, answers, templatesDir, isoDate: '2026-05-12' });
  assert.ok(existsSync(resolve(cwd, 'CLAUDE.md')), 'CLAUDE.md should exist');
  assert.ok(!existsSync(resolve(cwd, 'AGENTS.md')), 'AGENTS.md should NOT exist');
  assert.ok(!existsSync(resolve(cwd, 'GEMINI.md')), 'GEMINI.md should NOT exist');
});

test('FORGE-152: scaffold writes all three root files when all enabled', () => {
  const cwd = tmp();
  const answers: InitAnswers = {
    ...fixtureAnswers(),
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude', 'codex', 'gemini'],
    },
  };
  scaffoldProject({ cwd, answers, templatesDir, isoDate: '2026-05-12' });
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    const p = resolve(cwd, name);
    assert.ok(existsSync(p), `${name} should exist`);
    const contents = readFileSync(p, 'utf8');
    assert.match(contents, /<!-- >>> forge-managed/, `${name} should have marker block`);
  }
});

test('FORGE-152: scaffold writes only AGENTS.md when codex is the only enabled root', () => {
  const cwd = tmp();
  const answers: InitAnswers = {
    ...fixtureAnswers(),
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'codex',
      review_host_cli: null,
      enabled_root_files: ['codex'],
    },
  };
  scaffoldProject({ cwd, answers, templatesDir, isoDate: '2026-05-12' });
  assert.ok(existsSync(resolve(cwd, 'AGENTS.md')));
  assert.ok(!existsSync(resolve(cwd, 'CLAUDE.md')));
  assert.ok(!existsSync(resolve(cwd, 'GEMINI.md')));
});

test('FORGE-152: scaffold writes .forge/CONTEXT.md with methodology + CLI surface', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const p = resolve(cwd, '.forge/CONTEXT.md');
  assert.ok(existsSync(p), '.forge/CONTEXT.md should exist');
  const contents = readFileSync(p, 'utf8');
  assert.match(contents, /# Forge methodology/);
  assert.match(contents, /forge orchestrate/);
  // The rendered CLI surface must include at least one slash command bullet.
  assert.match(contents, /- `\/pickup-task`/);
});

test('FORGE-152: scaffold writes .forge/.version with a semver string', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const v = readFileSync(resolve(cwd, '.forge/.version'), 'utf8').trim();
  assert.match(v, /^\d+\.\d+\.\d+/, `.forge/.version should be semver, got: ${JSON.stringify(v)}`);
});

test('FORGE-152: .gitignore has the new marker block with selective negation', () => {
  const cwd = tmp();
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const gi = readFileSync(resolve(cwd, '.gitignore'), 'utf8');
  assert.match(gi, /# >>> forge-managed/);
  assert.match(gi, /\/\.forge\/\*/);
  assert.match(gi, /!\/\.forge\/settings\.yaml/);
});

test('scaffold skips overwriting existing files by default', () => {
  const cwd = tmp();
  // Pre-create a different CLAUDE.md
  writeFileSync(resolve(cwd, 'CLAUDE.md'), '# existing user content\n');
  const r = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  assert.ok(r.skipped.includes('CLAUDE.md'));
  const after = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.equal(after, '# existing user content\n');
});

test('scaffold overwrites when explicitly opted in via overwrite map', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'CLAUDE.md'), 'old');
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    overwrite: { 'CLAUDE.md': true },
  });
  assert.ok(r.written.includes('CLAUDE.md'));
  const after = readFileSync(resolve(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(after, /# sample-app/);
});

test('scaffold always overwrites .forge/settings.yaml (mustOverwrite)', () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'invalid: stale\n');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  const out = readFileSync(resolve(cwd, '.forge/settings.yaml'), 'utf8');
  assert.ok(out.includes('version: 1'));
});

test('scaffold cleans orphaned .forge/.init-staging dir from prior crash', () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge/.init-staging/half'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/.init-staging/half/leftover.txt'), 'old');
  scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });
  // Staging should be cleaned at the end.
  assert.equal(existsSync(resolve(cwd, '.forge/.init-staging')), false);
});

test('scaffold writes init-warnings.md when unverified is non-empty', () => {
  const cwd = tmp();
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    unverified: ['primary_host', 'linear_mcp'],
  });
  assert.ok(r.warningsPath);
  const body = readFileSync(resolve(cwd, '.forge/init-warnings.md'), 'utf8');
  assert.match(body, /primary_host/);
  assert.match(body, /linear_mcp/);
});

test('scaffold omits init-warnings.md when unverified is empty', () => {
  const cwd = tmp();
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    unverified: [],
  });
  assert.equal(r.warningsPath, undefined);
  assert.equal(existsSync(resolve(cwd, '.forge/init-warnings.md')), false);
});

// --- appendLineIfMissing (FORGE-115 / P2.5-T19) ---

test('appendLineIfMissing appends when file exists and line absent', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.eslintignore');
  writeFileSync(p, 'node_modules\ndist\n');
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.existed, true);
  assert.equal(r.appended, true);
  const after = readFileSync(p, 'utf8');
  assert.equal(after, 'node_modules\ndist\n.forge/worktrees/\n');
});

test('appendLineIfMissing is idempotent when line already present', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.eslintignore');
  writeFileSync(p, 'node_modules\n.forge/worktrees/\ndist\n');
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.existed, true);
  assert.equal(r.appended, false);
  const after = readFileSync(p, 'utf8');
  assert.equal(after, 'node_modules\n.forge/worktrees/\ndist\n');
});

test('appendLineIfMissing no-ops when file is missing', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.eslintignore'); // never created
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.existed, false);
  assert.equal(r.appended, false);
  assert.equal(existsSync(p), false);
});

test('appendLineIfMissing handles file without trailing newline', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.prettierignore');
  writeFileSync(p, 'node_modules'); // no trailing newline
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.appended, true);
  const after = readFileSync(p, 'utf8');
  assert.equal(after, 'node_modules\n.forge/worktrees/\n');
});

test('appendLineIfMissing is idempotent under CRLF line endings (Windows / autocrlf)', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.eslintignore');
  // File checked out on Windows or with core.autocrlf=true uses CRLF separators.
  // Naive split('\n') would leave '\r' on each entry and miss the match.
  writeFileSync(p, 'node_modules\r\n.forge/worktrees/\r\ndist\r\n');
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.existed, true);
  assert.equal(r.appended, false, 'CRLF-encoded file should not double-append');
  // Original content must be preserved byte-for-byte when we skip.
  assert.equal(readFileSync(p, 'utf8'), 'node_modules\r\n.forge/worktrees/\r\ndist\r\n');
});

test('appendLineIfMissing treats oversized file as missing (size cap)', () => {
  const cwd = tmp();
  const p = resolve(cwd, '.eslintignore');
  // Just over 1 MiB — config files have no legitimate reason to be this big,
  // and a symlink-to-/dev/zero or pathological generated config could OOM init.
  writeFileSync(p, 'x'.repeat(1_048_577));
  const r = appendLineIfMissing(p, '.forge/worktrees/');
  assert.equal(r.existed, false);
  assert.equal(r.appended, false);
  // File must not have been mutated.
  assert.equal(readFileSync(p, 'utf8').length, 1_048_577);
});

// --- appendToolingExcludes (FORGE-115 / P2.5-T19) ---

test('appendToolingExcludes appends to .eslintignore and .prettierignore when present', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, '.eslintignore'), 'node_modules\n');
  writeFileSync(resolve(cwd, '.prettierignore'), 'dist\n');
  const r = appendToolingExcludes(cwd);
  assert.deepEqual(r.written.sort(), ['.eslintignore', '.prettierignore']);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.warned, []);
  assert.match(readFileSync(resolve(cwd, '.eslintignore'), 'utf8'), /\.forge\/worktrees\//);
  assert.match(readFileSync(resolve(cwd, '.prettierignore'), 'utf8'), /\.forge\/worktrees\//);
});

test('appendToolingExcludes skips flat-ignore files that already have the entry', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, '.eslintignore'), 'node_modules\n.forge/worktrees/\n');
  const r = appendToolingExcludes(cwd);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.skipped, ['.eslintignore']);
  assert.deepEqual(r.warned, []);
});

test('appendToolingExcludes silently skips flat-ignore files that do not exist', () => {
  const cwd = tmp();
  // neither .eslintignore nor .prettierignore exists
  const r = appendToolingExcludes(cwd);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.warned, []);
});

test('appendToolingExcludes warns (does not mutate) when tsconfig.json is present', () => {
  const cwd = tmp();
  const original = '{\n  "compilerOptions": { "strict": true }\n}\n';
  writeFileSync(resolve(cwd, 'tsconfig.json'), original);
  const r = appendToolingExcludes(cwd);
  assert.equal(r.warned.length, 1);
  assert.equal(r.warned[0]?.target, 'tsconfig.json');
  assert.match(r.warned[0]?.snippet ?? '', /\.forge\/worktrees/);
  // Crucially: file is NOT mutated.
  assert.equal(readFileSync(resolve(cwd, 'tsconfig.json'), 'utf8'), original);
});

test('appendToolingExcludes skips tsconfig.json that already mentions the path', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'tsconfig.json'), '{ "exclude": [".forge/worktrees"] }\n');
  const r = appendToolingExcludes(cwd);
  assert.deepEqual(r.warned, []);
  assert.ok(r.skipped.includes('tsconfig.json'));
});

test('appendToolingExcludes warns (does not mutate) when vitest.config.ts is present', () => {
  const cwd = tmp();
  const original = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n";
  writeFileSync(resolve(cwd, 'vitest.config.ts'), original);
  const r = appendToolingExcludes(cwd);
  assert.equal(r.warned.length, 1);
  assert.equal(r.warned[0]?.target, 'vitest.config.ts');
  assert.match(r.warned[0]?.snippet ?? '', /\.forge\/worktrees\/\*\*/);
  assert.equal(readFileSync(resolve(cwd, 'vitest.config.ts'), 'utf8'), original);
});

test('scaffoldProject end-to-end with all four tooling targets present', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, '.eslintignore'), 'node_modules\n');
  writeFileSync(resolve(cwd, '.prettierignore'), 'dist\n');
  writeFileSync(resolve(cwd, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  writeFileSync(resolve(cwd, 'vitest.config.ts'), 'export default {};\n');
  const r = scaffoldProject({ cwd, answers: fixtureAnswers(), templatesDir, isoDate: '2026-05-12' });

  // Flat ignores → written.
  assert.ok(r.written.includes('.eslintignore'));
  assert.ok(r.written.includes('.prettierignore'));

  // Code configs → warned (not in written, not in skipped).
  assert.equal(r.written.includes('tsconfig.json'), false);
  assert.equal(r.skipped.includes('tsconfig.json'), false);

  // init-warnings.md exists with both warning sections.
  assert.ok(r.warningsPath);
  const body = readFileSync(resolve(cwd, '.forge/init-warnings.md'), 'utf8');
  assert.match(body, /## Tooling-exclude entries needed/);
  assert.match(body, /### tsconfig\.json/);
  assert.match(body, /### vitest\.config\.ts/);
});

test('scaffoldProject merges unverified probes + tooling warnings into one sidecar', () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'tsconfig.json'), '{}\n');
  const r = scaffoldProject({
    cwd,
    answers: fixtureAnswers(),
    templatesDir,
    isoDate: '2026-05-12',
    unverified: ['primary_host'],
  });
  assert.ok(r.warningsPath);
  const body = readFileSync(resolve(cwd, '.forge/init-warnings.md'), 'utf8');
  assert.match(body, /## Unverified tooling probes/);
  assert.match(body, /primary_host/);
  assert.match(body, /## Tooling-exclude entries needed/);
  assert.match(body, /tsconfig\.json/);
});

test('toMinimalYamlObject omits description when absent', () => {
  const obj = toMinimalYamlObject({
    ...fixtureAnswers(),
    project: { name: 'plain' },
  });
  const project = obj.project as Record<string, unknown>;
  assert.equal(project.description, undefined);
});
