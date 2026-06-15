import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filterFindings, runAuditPlan, runAuditCollect } from '../../../../src/cli/orchestrate/audit.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  return repo;
}

function commitFile(repo: string, rel: string, contents = 'x\n'): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  execFileSync('git', ['add', rel], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', `add ${rel}`], { cwd: repo });
}

function captureStdout(t: { after: (fn: () => void) => void }): { json(): unknown } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return {
    json(): unknown {
      const text = captured.join('');
      return JSON.parse(text.trim().split('\n').pop()!);
    },
  };
}

function finding(file: string, classification = 'simplify-safe'): Record<string, unknown> {
  return {
    file,
    dimension: 'dead-code',
    classification,
    evidence: 'e',
    why_safe: 'w',
    proposed_change: 'p',
    blast_radius: 'b',
  };
}

// ── The 9/9 filter predicates ────────────────────────────────────────────────

test('filter 1/9 — in-scope finding is kept', () => {
  const repo = makeRepo('forge-audit-f1-');
  try {
    commitFile(repo, 'src/foo.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/foo.ts')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0]!.file, 'src/foo.ts');
    assert.equal(out.dropped.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 2/9 — out-of-scope finding is dropped', () => {
  const repo = makeRepo('forge-audit-f2-');
  try {
    commitFile(repo, 'src/foo.ts');
    commitFile(repo, 'docs/x.md');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('docs/x.md')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'out-of-scope');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 3/9 — protected (CRITICAL-style glob) finding is dropped', () => {
  const repo = makeRepo('forge-audit-f3-');
  try {
    commitFile(repo, 'src/secret.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/secret.ts')],
      scopeGlobs: ['src/**'],
      protectedGlobs: ['src/secret.ts'],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'protected');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 4/9 — absolute path is dropped (B1)', () => {
  const repo = makeRepo('forge-audit-f4-');
  try {
    commitFile(repo, 'src/foo.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('/etc/passwd')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'absolute-path');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 4b/9 — absolute-but-inside-repo path is dropped (B1, the critical case)', () => {
  const repo = makeRepo('forge-audit-f4b-');
  try {
    commitFile(repo, 'src/foo.ts');
    const absInside = join(repo, 'src/foo.ts');
    assert.ok(absInside.startsWith('/'), 'precondition: absolute');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding(absInside)],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0, 'absolute-but-in-repo must be dropped, not kept');
    assert.equal(out.dropped[0]!.reason, 'absolute-path');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 5/9 — ../ traversal is dropped (malformed-path — a `..` segment is caught by the grammar before resolution)', () => {
  const repo = makeRepo('forge-audit-f5-');
  try {
    commitFile(repo, 'src/foo.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('../../../etc/passwd')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'malformed-path');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 6/9 — nested in-scope finding is kept', () => {
  const repo = makeRepo('forge-audit-f6-');
  try {
    commitFile(repo, 'src/a/b/c.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/a/b/c.ts')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0]!.file, 'src/a/b/c.ts');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 7/9 — protected-inside-scope finding is dropped', () => {
  const repo = makeRepo('forge-audit-f7-');
  try {
    commitFile(repo, 'src/schemas/x.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/schemas/x.ts')],
      scopeGlobs: ['src/**'],
      protectedGlobs: ['src/schemas/**'],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'protected');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filter 8/9 — symlink-escape finding is dropped (outside-repo)', () => {
  const repo = makeRepo('forge-audit-f8-');
  const outside = mkdtempSync(join(tmpdir(), 'forge-audit-f8-outside-'));
  try {
    commitFile(repo, 'src/foo.ts');
    writeFileSync(join(outside, 'secret.txt'), 'leak\n', 'utf8');
    // src/link → outside (a symlinked dir inside the repo pointing outside).
    symlinkSync(outside, join(repo, 'src', 'link'));
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/link/secret.txt')],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0, 'symlink escape must be dropped');
    assert.equal(out.dropped[0]!.reason, 'outside-repo');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('filter 9/9 — invalid finding is dropped + warned', () => {
  const repo = makeRepo('forge-audit-f9-');
  try {
    commitFile(repo, 'src/foo.ts');
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [{ file: 'src/foo.ts', classification: 'bogus' }],
      scopeGlobs: ['src/**'],
      protectedGlobs: [],
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.dropped[0]!.reason, 'invalid-finding');
    assert.ok(out.warnings.some((w) => w.includes('invalid finding')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── one bad configured glob → warned, not crashed ────────────────────────────

test('filter — one bad protected glob is warned + skipped, protection from the rest holds', () => {
  const repo = makeRepo('forge-audit-badglob-');
  try {
    commitFile(repo, 'src/keep.ts');
    commitFile(repo, 'src/secret.ts');
    // A leading '/' is an invalid glob (matchAny: "must be repo-relative").
    // 'src/secret.ts' still protects after the bad glob is warned + skipped.
    const out = filterFindings({
      repoRoot: repo,
      rawFindings: [finding('src/keep.ts'), finding('src/secret.ts')],
      scopeGlobs: ['src/**'],
      protectedGlobs: ['/bad', 'src/secret.ts'],
    });
    // keep.ts: not matched by either → kept. secret.ts: protected by the good glob → dropped.
    assert.deepEqual(
      out.kept.map((f) => f.file).sort(),
      ['src/keep.ts'],
    );
    assert.ok(out.dropped.some((d) => d.file === 'src/secret.ts' && d.reason === 'protected'));
    assert.ok(out.warnings.some((w) => w.includes('invalid protected glob')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── scope auto-discovery (no hardcoded src/) ─────────────────────────────────

test('plan — scope auto-discovery ranks real dirs without hardcoding src/', (t) => {
  const repo = makeRepo('forge-audit-scope-');
  try {
    // Non-src layout: the heaviest dir is `lib/`.
    commitFile(repo, 'lib/a.ts');
    commitFile(repo, 'lib/b.ts');
    commitFile(repo, 'lib/c.ts');
    commitFile(repo, 'app/x.ts');
    const cap = captureStdout(t);
    runAuditPlan({ forgeDir: join(repo, '.forge'), json: true });
    const env = cap.json() as { ok: boolean; data: { scope: string[] } };
    assert.equal(env.ok, true);
    assert.ok(env.data.scope.includes('lib/**'), `expected lib/** in scope, got ${JSON.stringify(env.data.scope)}`);
    assert.ok(!env.data.scope.includes('src/**'), 'must not invent src/**');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('plan — non-git repo falls back to scope ["**"] with a warning', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-audit-nogit-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8');
    const cap = captureStdout(t);
    runAuditPlan({ forgeDir: join(dir, '.forge'), json: true });
    const env = cap.json() as { ok: boolean; data: { scope: string[]; warnings: string[] } };
    assert.equal(env.ok, true);
    assert.deepEqual(env.data.scope, ['**']);
    assert.ok(env.data.warnings.some((w) => w.toLowerCase().includes('git')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CRITICAL.md glob parsing ─────────────────────────────────────────────────

test('plan — CRITICAL.md globs feed the protected set (comments/blank lines ignored)', (t) => {
  const repo = makeRepo('forge-audit-crit-');
  try {
    commitFile(repo, 'src/foo.ts');
    writeFileSync(
      join(repo, 'CRITICAL.md'),
      '# header comment\n\nsrc/danger/**\n   # indented comment\nlib/secret.ts\n',
      'utf8',
    );
    const cap = captureStdout(t);
    runAuditPlan({ forgeDir: join(repo, '.forge'), json: true });
    const env = cap.json() as { ok: boolean; data: { protected_globs: string[] } };
    assert.ok(env.data.protected_globs.includes('src/danger/**'));
    assert.ok(env.data.protected_globs.includes('lib/secret.ts'));
    assert.ok(!env.data.protected_globs.some((g) => g.startsWith('#')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── plan renders exactly one prompt per scope × dimension ─────────────────────

test('plan — renders exactly one prompt per scope × dimension', (t) => {
  const repo = makeRepo('forge-audit-fanout-');
  try {
    commitFile(repo, 'src/foo.ts');
    const cap = captureStdout(t);
    runAuditPlan({
      forgeDir: join(repo, '.forge'),
      json: true,
      scopeOverride: ['src/**', 'lib/**'],
      dimensionsOverride: ['dead-code', 'duplication', 'complexity'],
    });
    const env = cap.json() as {
      data: { prompts: Array<{ scope: string; dimension: string; prompt: string }> };
    };
    assert.equal(env.data.prompts.length, 6);
    // Every (scope, dimension) pair present exactly once.
    const pairs = new Set(env.data.prompts.map((p) => `${p.scope}|${p.dimension}`));
    assert.equal(pairs.size, 6);
    // Read-only mandate present in each prompt.
    for (const p of env.data.prompts) {
      assert.ok(/READ-ONLY/.test(p.prompt), 'each prompt must carry the read-only mandate');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── verify-unset warning + settings-absent degrade (B2) ──────────────────────

test('plan — verify unset → warning present; settings.yaml absent → defaults, no crash (B2)', (t) => {
  const repo = makeRepo('forge-audit-b2-');
  try {
    commitFile(repo, 'src/foo.ts');
    // No .forge/settings.yaml at all.
    const cap = captureStdout(t);
    const { exitCode } = runAuditPlan({ forgeDir: join(repo, '.forge'), json: true });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { verify_configured: boolean; warnings: string[] } };
    assert.equal(env.ok, true);
    assert.equal(env.data.verify_configured, false);
    assert.ok(env.data.warnings.some((w) => w.includes('verify')));
    assert.ok(env.data.warnings.some((w) => w.includes('settings.yaml')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── collect: read-only proof — writes ONLY .forge/audits/** ───────────────────

test('collect — writes ONLY the two artifacts; git stays clean except .forge/audits/**', (t) => {
  const repo = makeRepo('forge-audit-collect-');
  try {
    commitFile(repo, 'src/foo.ts');
    commitFile(repo, 'src/schemas/x.ts');
    // CRITICAL.md makes src/schemas/** protected (so the protected drop fires).
    writeFileSync(join(repo, 'CRITICAL.md'), 'src/schemas/**\n', 'utf8');
    const findingsFile = join(repo, 'findings.json');
    writeFileSync(
      findingsFile,
      JSON.stringify([
        finding('src/foo.ts', 'delete-safe'),
        finding('src/schemas/x.ts', 'simplify-safe'), // protected → dropped
        finding('/etc/passwd'), // absolute → dropped
      ]),
      'utf8',
    );

    const cap = captureStdout(t);
    const { exitCode } = runAuditCollect({
      forgeDir: join(repo, '.forge'),
      json: true,
      findingsFile,
      scopeOverride: ['src/**'],
    });
    assert.equal(exitCode, 0);
    const env = cap.json() as {
      ok: boolean;
      data: { work_order_path: string; summary: Record<string, number>; dropped: { count: number } };
    };
    assert.equal(env.ok, true);
    assert.equal(env.data.summary['delete-safe'], 1);
    assert.equal(env.data.dropped.count, 2);

    // The two artifacts exist.
    const woJson = env.data.work_order_path;
    assert.ok(existsSync(woJson));
    assert.ok(existsSync(woJson.replace(/work-order\.json$/, 'work-order.md')));
    const wo = JSON.parse(readFileSync(woJson, 'utf8')) as { findings: Array<{ file: string }> };
    assert.deepEqual(wo.findings.map((f) => f.file), ['src/foo.ts']);

    // findings.json is untracked (we put it in the repo), but git status must be
    // clean of any SOURCE changes: only .forge/audits/** + the temp findings file.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    const offending = status
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      // git collapses the wholly-untracked .forge/ dir to a single "?? .forge/";
      // the only thing under it is the audit work-order, so this is the allowed write.
      .filter((l) => !l.includes('.forge/'))
      .filter((l) => !l.includes('findings.json'))
      .filter((l) => !l.includes('CRITICAL.md'));
    assert.deepEqual(offending, [], `unexpected git changes: ${status}`);

    // Rigorous read-only proof: the ONLY files under .forge/ are the work-order
    // pair — collect wrote nothing else under .forge/.
    const underForge = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.forge'], {
      cwd: repo,
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.replace(/^\?\?\s+/, '').trim())
      .filter((l) => l.length > 0)
      .sort();
    assert.ok(underForge.every((p) => /^\.forge\/audits\/.+\/work-order\.(json|md)$/.test(p)),
      `collect wrote unexpected files under .forge/: ${underForge.join(', ')}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── B3: symlinked .forge/audits parent → refused, nothing written outside ─────

test('collect — symlinked .forge/audits parent is refused; nothing written through it (B3)', (t) => {
  const repo = makeRepo('forge-audit-b3-');
  const outside = mkdtempSync(join(tmpdir(), 'forge-audit-b3-outside-'));
  try {
    commitFile(repo, 'src/foo.ts');
    // Make .forge a real dir but .forge/audits a symlink pointing OUTSIDE.
    mkdirSync(join(repo, '.forge'), { recursive: true });
    symlinkSync(outside, join(repo, '.forge', 'audits'));

    const findingsFile = join(repo, 'findings.json');
    writeFileSync(findingsFile, JSON.stringify([finding('src/foo.ts', 'delete-safe')]), 'utf8');

    const cap = captureStdout(t);
    const { exitCode } = runAuditCollect({
      forgeDir: join(repo, '.forge'),
      json: true,
      findingsFile,
      scopeOverride: ['src/**'],
    });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'SYMLINK_PARENT_REFUSED');

    // Nothing was written into the outside dir.
    const leaked = execFileSync('ls', ['-A', outside], { encoding: 'utf8' }).trim();
    assert.equal(leaked, '', `nothing should be written through the symlink, found: ${leaked}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('collect — missing --findings-file errors', (t) => {
  const repo = makeRepo('forge-audit-nofile-');
  try {
    const cap = captureStdout(t);
    const { exitCode } = runAuditCollect({ forgeDir: join(repo, '.forge'), json: true });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'INVALID_ARGS');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
