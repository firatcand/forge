import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import * as fsExtra from 'node:fs';
import { parse as parseYaml } from 'yaml';

import {
  detectDrift,
  rewriteCommandRefs,
  SCAN_FILE_MAX_BYTES,
  SCAN_MAX_FILES,
  SETTINGS_DEFAULT_BLOCKS,
} from '../../../../src/cli/migrate/drift-detect.ts';
import { chooseBackupDir, runMigrate } from '../../../../src/cli/migrate/migrate.ts';
import { SettingsSchema } from '../../../../src/schemas/settings.ts';

// ── capture helper: record + forward (see amend-roadmap.test.ts for why a
// swallow-only hook is unsafe under the node:test child-process reporter) ────
function makeSink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _enc: string, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

// v0.2.x-flavored settings: valid v0.4 core blocks, but missing
// codex/decisions/doctor (init never serialized them; stale files won't have
// them). Includes a comment to assert comment preservation.
const STALE_SETTINGS = `version: 1
# project block — user-edited, must survive migration
project:
  name: demo
tracker:
  type: github
  config:
    owner: acme
    repo: demo
secrets:
  manager: env_file
  env_file_path: ./.env.local
agents:
  max_concurrent: 4
  retry_attempts: 3
design:
  mode: project_owned
`;

const STALE_DESIGN = `# Design System
@inherit firatcand/forge-brand-book

## Project overrides
- Primary color: #FF5733
`;

const STALE_CLAUDEMD = `# Project

Use /push-to-linear after /decompose. Then /push-to-linear again if needed.
`;

const STALE_SKILL = `---
name: custom-flow
---
Run \`forge orchestrate next\` to grab work.
Then check suggest-next for candidates.
If confused, session-check helps.
`;

function bootstrapV02x(opts: { settings?: string | null } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-'));
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  mkdirSync(join(cwd, 'spec'), { recursive: true });
  mkdirSync(join(cwd, '.claude', 'skills', 'custom-flow'), { recursive: true });
  if (opts.settings !== null) {
    writeFileSync(join(cwd, '.forge', 'settings.yaml'), opts.settings ?? STALE_SETTINGS, 'utf8');
  }
  writeFileSync(join(cwd, 'spec', 'DESIGN.md'), STALE_DESIGN, 'utf8');
  writeFileSync(join(cwd, 'CLAUDE.md'), STALE_CLAUDEMD, 'utf8');
  writeFileSync(join(cwd, '.claude', 'skills', 'custom-flow', 'SKILL.md'), STALE_SKILL, 'utf8');
  // Legacy v1 orchestrator state (gc's Phase-0 markers) + .tmp residue that
  // must be ignored (mirrors gc's filter).
  mkdirSync(join(cwd, '.forge', 'questions'), { recursive: true });
  writeFileSync(join(cwd, '.forge', 'questions', 'q1.json'), '{}', 'utf8');
  writeFileSync(join(cwd, '.forge', 'questions', 'q2.json.tmp'), '{', 'utf8');
  // No templates/adr.template.md → missing-adr-template fires.
  return cwd;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('SETTINGS_DEFAULT_BLOCKS matches SettingsSchema defaults exactly', () => {
  const parsed = SettingsSchema.parse({
    version: 1,
    project: { name: 'x' },
    tracker: { type: 'github', config: { owner: 'a', repo: 'b' } },
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {},
    design: { mode: 'project_owned' },
  });
  assert.deepEqual(parsed.codex, SETTINGS_DEFAULT_BLOCKS.codex);
  assert.deepEqual(parsed.decisions, SETTINGS_DEFAULT_BLOCKS.decisions);
  assert.deepEqual(parsed.doctor, SETTINGS_DEFAULT_BLOCKS.doctor);
});

test('rewriteCommandRefs: targeted rewrites only', () => {
  const r = rewriteCommandRefs(
    'run forge orchestrate next, see suggest-next; the next step; /push-to-linear; session-check',
  );
  assert.match(r.after, /forge orchestrate claim/);
  assert.match(r.after, /phases --ready/);
  assert.match(r.after, /\/push-to-tracker/);
  assert.match(r.after, /the next step/); // bare 'next' untouched
  assert.deepEqual(r.removedVerbs, ['session-check']);
});

test('chooseBackupDir: windows-safe stamp + collision suffix', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-bk-'));
  const iso = '2026-06-11T10:30:00.000Z';
  const first = chooseBackupDir(cwd, iso);
  assert.ok(!first.includes(':'), 'no colons in backup dir name');
  mkdirSync(first, { recursive: true });
  const second = chooseBackupDir(cwd, iso);
  assert.notEqual(second, first);
  assert.ok(second.endsWith('-2'));
});

// ── detection ────────────────────────────────────────────────────────────────

test('detectDrift finds every v0.2.x signature on the fixture (AC 1)', () => {
  const cwd = bootstrapV02x();
  const report = detectDrift(cwd);
  const kinds = report.findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, [
    'design-inherit',
    'dropped-verbs-removed',
    'dropped-verbs-renamed',
    'legacy-orchestrator-state',
    'missing-adr-template',
    'push-to-linear-refs',
    'settings-missing-blocks',
  ]);
});

test('detectDrift: missing settings.yaml is a delegated follow-up, not an edit', () => {
  const cwd = bootstrapV02x({ settings: null });
  const report = detectDrift(cwd);
  const f = report.findings.find((x) => x.kind === 'missing-settings');
  assert.ok(f);
  assert.equal(f!.class, 'followup');
  assert.equal(f!.edit, undefined);
  assert.match(f!.detail, /forge init/);
});

test('detectDrift: malformed settings YAML → warning, no edit', () => {
  const cwd = bootstrapV02x({ settings: 'version: 1\nproject: [unclosed' });
  const report = detectDrift(cwd);
  const f = report.findings.find((x) => x.kind === 'settings-invalid');
  assert.ok(f);
  assert.equal(f!.class, 'warning');
  assert.equal(f!.edit, undefined);
});

test('detectDrift: settings that would still fail the v0.4 schema → warning, no edit', () => {
  const cwd = bootstrapV02x({
    settings: 'version: 1\nproject:\n  name: demo\ntracker:\n  type: jira\n',
  });
  const report = detectDrift(cwd);
  const f = report.findings.find((x) => x.kind === 'settings-invalid');
  assert.ok(f, 'expected settings-invalid warning');
  assert.match(f!.detail, /manual/i);
});

test('detectDrift: partial blocks — only the missing ones are added', () => {
  const cwd = bootstrapV02x({
    settings: `${STALE_SETTINGS}codex:\n  auto_codex_enabled: false\n`,
  });
  const report = detectDrift(cwd);
  const f = report.findings.find((x) => x.kind === 'settings-missing-blocks');
  assert.ok(f?.edit);
  const after = parseYaml(f!.edit!.after) as Record<string, unknown>;
  // User's codex block untouched; decisions/doctor added with defaults.
  assert.deepEqual(after.codex, { auto_codex_enabled: false });
  assert.deepEqual(after.decisions, SETTINGS_DEFAULT_BLOCKS.decisions);
  assert.deepEqual(after.doctor, SETTINGS_DEFAULT_BLOCKS.doctor);
});

test('detectDrift: symlinked DESIGN.md is skipped, never followed', () => {
  const cwd = bootstrapV02x();
  const target = join(cwd, 'elsewhere.md');
  writeFileSync(target, '@inherit something\n', 'utf8');
  const designPath = join(cwd, 'spec', 'DESIGN.md');
  // Replace the real file with a symlink.
  unlinkSync(designPath);
  symlinkSync(target, designPath);

  const report = detectDrift(cwd);
  assert.ok(report.skipped.some((s) => s.relPath === join('spec', 'DESIGN.md') && s.reason === 'symlink'));
  assert.ok(!report.findings.some((f) => f.kind === 'design-inherit'));
});

// ── Codex impl-review hardening (fix loop 1) ─────────────────────────────────

test('symlinked settings.yaml is refused (warning), never followed', () => {
  const cwd = bootstrapV02x();
  const target = join(cwd, 'elsewhere-settings.yaml');
  writeFileSync(target, STALE_SETTINGS, 'utf8');
  unlinkSync(join(cwd, '.forge', 'settings.yaml'));
  symlinkSync(target, join(cwd, '.forge', 'settings.yaml'));

  const report = detectDrift(cwd);
  const f = report.findings.find((x) => x.kind === 'settings-invalid');
  assert.ok(f);
  assert.match(f!.detail, /symlink/);
  assert.ok(!report.findings.some((x) => x.kind === 'settings-missing-blocks'));
});

test('oversized scanned file is skipped with a note', () => {
  const cwd = bootstrapV02x();
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'huge.md'), `/push-to-linear\n${'x'.repeat(SCAN_FILE_MAX_BYTES + 1)}`, 'utf8');
  const report = detectDrift(cwd);
  assert.ok(report.skipped.some((s) => s.relPath === join('docs', 'huge.md') && s.reason === 'too-large'));
  assert.ok(!report.findings.some((f) => f.relPath === join('docs', 'huge.md')));
});

test('scan file-count budget truncates deterministically and reports it', () => {
  const cwd = bootstrapV02x();
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  for (let i = 0; i < SCAN_MAX_FILES + 5; i++) {
    writeFileSync(join(cwd, 'docs', `f${i}.md`), 'clean\n', 'utf8');
  }
  const report = detectDrift(cwd);
  assert.equal(report.scanTruncated, true);
});

test('symlinked .forge: settings/legacy scan refused; apply refuses backups through it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-symforge-'));
  const realForge = join(cwd, 'real-forge');
  mkdirSync(realForge, { recursive: true });
  symlinkSync(realForge, join(cwd, '.forge'));
  mkdirSync(join(cwd, 'spec'), { recursive: true });
  writeFileSync(join(cwd, 'spec', 'DESIGN.md'), STALE_DESIGN, 'utf8');

  const report = detectDrift(cwd);
  const warn = report.findings.find((f) => f.relPath === '.forge');
  assert.ok(warn, 'expected the .forge symlink warning');
  assert.equal(warn!.class, 'warning');

  // Apply path: actionable DESIGN edit exists, but backups must refuse the
  // symlinked .forge.
  const err = makeSink();
  const result = await runMigrate({
    cwd,
    argv: ['--yes'],
    stdout: makeSink().stream,
    stderr: err.stream,
  });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /\.forge is not a real directory/);
  assert.equal(readFileSync(join(cwd, 'spec', 'DESIGN.md'), 'utf8'), STALE_DESIGN);
});

test('symlinked scan root (docs/) is skipped wholesale, never followed', () => {
  const cwd = bootstrapV02x();
  const outside = mkdtempSync(join(tmpdir(), 'forge-migrate-outside-'));
  writeFileSync(join(outside, 'evil.md'), '/push-to-linear\n', 'utf8');
  symlinkSync(outside, join(cwd, 'docs'));

  const report = detectDrift(cwd);
  assert.ok(report.skipped.some((s) => s.relPath === 'docs' && s.reason === 'symlink'));
  assert.ok(!report.findings.some((f) => f.relPath?.includes('evil')));
});

test('symlinked spec/ ancestor: DESIGN.md outside the repo is never read', () => {
  const cwd = bootstrapV02x();
  const outside = mkdtempSync(join(tmpdir(), 'forge-migrate-spec-out-'));
  writeFileSync(join(outside, 'DESIGN.md'), '@inherit evil/brand\n', 'utf8');
  // Replace the real spec/ dir with a symlink to the outside tree.
  const { rmSync } = fsExtra;
  rmSync(join(cwd, 'spec'), { recursive: true, force: true });
  symlinkSync(outside, join(cwd, 'spec'));

  const report = detectDrift(cwd);
  assert.ok(!report.findings.some((f) => f.kind === 'design-inherit'));
  assert.ok(report.skipped.some((s) => s.relPath === join('spec', 'DESIGN.md') && s.reason === 'symlink'));
});

test('file changed between preview and accept aborts the whole apply (TOCTOU)', async () => {
  const cwd = bootstrapV02x();
  const out = makeSink();
  const err = makeSink();
  const result = await runMigrate({
    cwd,
    argv: [],
    stdout: out.stream,
    stderr: err.stream,
    isTTYOverride: true,
    confirmOverride: async () => {
      // Mutate a previewed file DURING the confirmation prompt.
      writeFileSync(join(cwd, 'CLAUDE.md'), 'changed while you were reading the prompt\n', 'utf8');
      return true;
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /changed since the preview/);
  // Whole apply aborted: DESIGN.md untouched, no backup dir.
  assert.equal(readFileSync(join(cwd, 'spec', 'DESIGN.md'), 'utf8'), STALE_DESIGN);
  assert.ok(!readdirSync(join(cwd, '.forge')).some((n) => n.startsWith('backup-')));
});

test('edit target replaced by a symlink after preview aborts the apply', async () => {
  const cwd = bootstrapV02x();
  const err = makeSink();
  const result = await runMigrate({
    cwd,
    argv: [],
    stdout: makeSink().stream,
    stderr: err.stream,
    isTTYOverride: true,
    confirmOverride: async () => {
      const real = join(cwd, 'CLAUDE.md');
      const lure = join(cwd, 'lure.md');
      writeFileSync(lure, STALE_CLAUDEMD, 'utf8');
      unlinkSync(real);
      symlinkSync(lure, real);
      return true;
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /aborting before any write/);
  assert.ok(!readdirSync(join(cwd, '.forge')).some((n) => n.startsWith('backup-')));
});

test('adr template appearing after preview aborts the apply', async () => {
  const cwd = bootstrapV02x();
  const err = makeSink();
  const result = await runMigrate({
    cwd,
    argv: [],
    stdout: makeSink().stream,
    stderr: err.stream,
    isTTYOverride: true,
    confirmOverride: async () => {
      mkdirSync(join(cwd, 'templates'), { recursive: true });
      writeFileSync(join(cwd, 'templates', 'adr.template.md'), 'user-authored\n', 'utf8');
      return true;
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /appeared since the preview/);
  // The user's file was NOT overwritten.
  assert.equal(readFileSync(join(cwd, 'templates', 'adr.template.md'), 'utf8'), 'user-authored\n');
});

// ── full flow ────────────────────────────────────────────────────────────────

test('--dry-run previews everything and writes nothing', async () => {
  const cwd = bootstrapV02x();
  const out = makeSink();
  const result = await runMigrate({ cwd, argv: ['--dry-run'], stdout: out.stream, stderr: out.stream });
  assert.equal(result.exitCode, 0);
  assert.match(out.text(), /Planned changes/);
  assert.match(out.text(), /--dry-run: nothing written/);
  // No writes: originals intact, no backup dir.
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), STALE_CLAUDEMD);
  assert.ok(!readdirSync(join(cwd, '.forge')).some((n) => n.startsWith('backup-')));
});

test('non-TTY without --yes refuses: exit 1, zero writes, no backup (AC 5)', async () => {
  const cwd = bootstrapV02x();
  const out = makeSink();
  const err = makeSink();
  const result = await runMigrate({
    cwd,
    argv: [],
    stdout: out.stream,
    stderr: err.stream,
    isTTYOverride: false,
  });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /--yes/);
  assert.equal(readFileSync(join(cwd, 'spec', 'DESIGN.md'), 'utf8'), STALE_DESIGN);
  assert.ok(!readdirSync(join(cwd, '.forge')).some((n) => n.startsWith('backup-')));
});

test('interactive reject (and Ctrl-C cancellation) → abort clean (AC 5)', async () => {
  for (const override of [
    async () => false,
    async () => {
      throw new Error('User force closed the prompt');
    },
  ]) {
    const cwd = bootstrapV02x();
    const out = makeSink();
    const result = await runMigrate({
      cwd,
      argv: [],
      stdout: out.stream,
      stderr: out.stream,
      isTTYOverride: true,
      confirmOverride: override as () => Promise<boolean>,
    });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /aborted/);
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), STALE_CLAUDEMD);
    assert.ok(!readdirSync(join(cwd, '.forge')).some((n) => n.startsWith('backup-')));
  }
});

test('apply --yes migrates everything; backups pristine (ACs 2,3,4)', async () => {
  const cwd = bootstrapV02x();
  const out = makeSink();
  const result = await runMigrate({ cwd, argv: ['--yes'], stdout: out.stream, stderr: out.stream });
  assert.equal(result.exitCode, 0);
  assert.ok(result.backupDir);

  // Settings gained exactly the three blocks; comment preserved; schema-valid.
  const settingsRaw = readFileSync(join(cwd, '.forge', 'settings.yaml'), 'utf8');
  assert.match(settingsRaw, /# project block — user-edited, must survive migration/);
  const settings = SettingsSchema.parse(parseYaml(settingsRaw));
  assert.deepEqual(settings.codex, SETTINGS_DEFAULT_BLOCKS.codex);
  assert.deepEqual(settings.decisions, SETTINGS_DEFAULT_BLOCKS.decisions);
  assert.deepEqual(settings.doctor, SETTINGS_DEFAULT_BLOCKS.doctor);

  // DESIGN.md: @inherit stripped, marker present.
  const design = readFileSync(join(cwd, 'spec', 'DESIGN.md'), 'utf8');
  assert.ok(!/^@inherit/m.test(design));
  assert.match(design, /forge-migrate: '@inherit firatcand\/forge-brand-book'/);
  assert.match(design, /\/draft-design/);

  // CLAUDE.md: every /push-to-linear rewritten.
  const claude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(!claude.includes('/push-to-linear'));
  assert.equal((claude.match(/\/push-to-tracker/g) ?? []).length, 2);

  // Skill: renamed verbs rewritten; dropped verb left (warn-only).
  const skill = readFileSync(join(cwd, '.claude', 'skills', 'custom-flow', 'SKILL.md'), 'utf8');
  assert.match(skill, /forge orchestrate claim/);
  assert.match(skill, /phases --ready/);
  assert.match(skill, /session-check/); // not auto-rewritten
  assert.match(out.text(), /session-check/); // but warned

  // ADR template copied byte-identical to the bundled scaffold.
  const copied = readFileSync(join(cwd, 'templates', 'adr.template.md'), 'utf8');
  const bundled = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'templates', 'adr.template.md'),
    'utf8',
  );
  assert.equal(copied, bundled);

  // Backups byte-identical to pristine originals (AC 4).
  assert.equal(readFileSync(join(result.backupDir!, 'CLAUDE.md'), 'utf8'), STALE_CLAUDEMD);
  assert.equal(readFileSync(join(result.backupDir!, 'spec', 'DESIGN.md'), 'utf8'), STALE_DESIGN);
  assert.equal(readFileSync(join(result.backupDir!, '.forge', 'settings.yaml'), 'utf8'), STALE_SETTINGS);
  assert.equal(
    readFileSync(join(result.backupDir!, '.claude', 'skills', 'custom-flow', 'SKILL.md'), 'utf8'),
    STALE_SKILL,
  );

  // Legacy state untouched (delegated to gc); follow-up printed.
  assert.ok(existsSync(join(cwd, '.forge', 'questions', 'q1.json')));
  assert.match(out.text(), /forge orchestrate gc/);
});

test('idempotent: second --yes run plans zero writes; only follow-ups remain (AC 6)', async () => {
  const cwd = bootstrapV02x();
  const first = await runMigrate({ cwd, argv: ['--yes'], stdout: makeSink().stream, stderr: makeSink().stream });
  assert.equal(first.exitCode, 0);

  const out = makeSink();
  const second = await runMigrate({ cwd, argv: ['--yes'], stdout: out.stream, stderr: out.stream });
  assert.equal(second.exitCode, 0);
  assert.equal(second.backupDir, undefined); // nothing applied → no new backup
  assert.match(out.text(), /nothing for forge migrate to write/);
  // Persistent follow-ups by design: marker (until /draft-design), legacy gc,
  // dropped-verb warning.
  assert.match(out.text(), /\/draft-design/);
  assert.match(out.text(), /forge orchestrate gc/);
  // Exactly one backup dir from the first run.
  assert.equal(readdirSync(join(cwd, '.forge')).filter((n) => n.startsWith('backup-')).length, 1);
});

test('missing settings: delegated, but every other signature still applies', async () => {
  const cwd = bootstrapV02x({ settings: null });
  const out = makeSink();
  const result = await runMigrate({ cwd, argv: ['--yes'], stdout: out.stream, stderr: out.stream });
  assert.equal(result.exitCode, 0);
  assert.match(out.text(), /forge init/);
  assert.ok(!existsSync(join(cwd, '.forge', 'settings.yaml'))); // NOT fabricated
  assert.ok(!readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').includes('/push-to-linear'));
});

test('non-forge directory: exit 0, "not a forge project" message', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-nonforge-'));
  const out = makeSink();
  const result = await runMigrate({ cwd, argv: [], stdout: out.stream, stderr: out.stream, isTTYOverride: false });
  assert.equal(result.exitCode, 0);
  assert.match(out.text(), /not a forge project/);
});

test('clean v0.4 project: exit 0, "no drift" message, no writes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-clean-'));
  mkdirSync(join(cwd, '.forge'), { recursive: true });
  mkdirSync(join(cwd, 'templates'), { recursive: true });
  writeFileSync(
    join(cwd, '.forge', 'settings.yaml'),
    `${STALE_SETTINGS}codex:\n  auto_codex_enabled: true\ndecisions:\n  decision_dir: ./spec/decisions\n  stale_draft_threshold_days: 7\ndoctor:\n  spec_code_check_enabled: true\n`,
    'utf8',
  );
  writeFileSync(join(cwd, 'templates', 'adr.template.md'), '# ADR\n', 'utf8');
  const out = makeSink();
  const result = await runMigrate({ cwd, argv: [], stdout: out.stream, stderr: out.stream, isTTYOverride: false });
  assert.equal(result.exitCode, 0);
  assert.match(out.text(), /no v0\.2\.x drift detected/);
});

test('unknown argument is rejected with usage (exit 1)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-migrate-args-'));
  const err = makeSink();
  const result = await runMigrate({ cwd, argv: ['--apply'], stdout: makeSink().stream, stderr: err.stream });
  assert.equal(result.exitCode, 1);
  assert.match(err.text(), /unknown argument '--apply'/);
  assert.match(err.text(), /Usage: forge migrate/);
});

test('--help prints scoped usage (exit 0)', async () => {
  const out = makeSink();
  const result = await runMigrate({ cwd: '/nonexistent-irrelevant', argv: ['--help'], stdout: out.stream, stderr: out.stream });
  assert.equal(result.exitCode, 0);
  assert.match(out.text(), /Usage: forge migrate/);
});
