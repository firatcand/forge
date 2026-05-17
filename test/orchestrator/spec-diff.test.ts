import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execaSync } from 'execa';
import {
  computeSpecRevision,
  computeSpecRevisionSync,
  computeSpecDiffSinceClaim,
} from '../../src/orchestrator/spec-diff.ts';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-spec-diff-test-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Each test gets its own isolated repo dir to avoid cross-test pollution
// (git refs especially can leak across tests).
function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitInit(repo: string): void {
  execaSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, reject: true });
  execaSync('git', ['config', 'user.email', 'test@forge.test'], {
    cwd: repo,
    reject: true,
  });
  execaSync('git', ['config', 'user.name', 'Forge Test'], {
    cwd: repo,
    reject: true,
  });
  execaSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: repo,
    reject: true,
  });
}

function gitCommit(repo: string, msg: string): string {
  execaSync('git', ['add', '-A'], { cwd: repo, reject: true });
  execaSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
    cwd: repo,
    reject: true,
  });
  const out = execaSync('git', ['rev-parse', 'HEAD'], { cwd: repo, reject: true });
  return String(out.stdout).trim();
}

function writeSpec(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// ---- computeSpecRevision / computeSpecRevisionSync ----

test('spec-diff: computeSpecRevisionSync returns git:<sha> in a git repo with spec/', () => {
  const repo = makeRepo('rev-git-happy');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', '# initial spec\n');
  const head = gitCommit(repo, 'add spec');

  const result = computeSpecRevisionSync(repo);
  assert.equal(result.source, 'git');
  assert.equal(result.revision, `git:${head}`);
});

test('spec-diff: computeSpecRevision (async) returns git:<sha> in a git repo with spec/', async () => {
  const repo = makeRepo('rev-git-happy-async');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', '# initial spec\n');
  const head = gitCommit(repo, 'add spec');

  const result = await computeSpecRevision(repo);
  assert.equal(result.source, 'git');
  assert.equal(result.revision, `git:${head}`);
});

test('spec-diff: computeSpecRevisionSync falls back to digest when not a git repo', () => {
  const repo = makeRepo('rev-no-git');
  writeSpec(repo, 'spec/SPEC.md', '# untracked spec\n');

  const result = computeSpecRevisionSync(repo);
  assert.equal(result.source, 'digest');
  assert.match(result.revision, /^digest:[0-9a-f]{64}$/);
});

test('spec-diff: computeSpecRevisionSync returns digest:empty when spec/ is absent', () => {
  const repo = makeRepo('rev-no-spec');
  gitInit(repo);
  // Need at least one commit so git rev-parse HEAD succeeds — but with no spec/.
  writeFileSync(join(repo, 'README.md'), 'hi');
  gitCommit(repo, 'init');

  const result = computeSpecRevisionSync(repo);
  assert.equal(result.source, 'digest');
  assert.equal(result.revision, 'digest:empty');
});

test('spec-diff: computeSpecRevisionSync returns digest:empty when spec/ is an empty dir', () => {
  const repo = makeRepo('rev-empty-spec');
  mkdirSync(join(repo, 'spec'), { recursive: true });

  const result = computeSpecRevisionSync(repo);
  assert.equal(result.revision, 'digest:empty');
});

test('spec-diff: computeSpecRevisionSync digest is deterministic across calls', () => {
  const repo = makeRepo('rev-determinism');
  writeSpec(repo, 'spec/SPEC.md', 'alpha');
  writeSpec(repo, 'spec/PRD.md', 'beta');
  const a = computeSpecRevisionSync(repo);
  const b = computeSpecRevisionSync(repo);
  assert.equal(a.revision, b.revision);
});

test('spec-diff: computeSpecRevisionSync digest changes when spec/ contents change', () => {
  const repo = makeRepo('rev-digest-changes');
  writeSpec(repo, 'spec/SPEC.md', 'v1');
  const before = computeSpecRevisionSync(repo).revision;
  writeSpec(repo, 'spec/SPEC.md', 'v2');
  const after = computeSpecRevisionSync(repo).revision;
  assert.notEqual(before, after);
});

// ---- computeSpecDiffSinceClaim ----

test('spec-diff: returns null when no spec/ commits between claim and HEAD', async () => {
  const repo = makeRepo('diff-empty');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', 'initial');
  const claim = gitCommit(repo, 'add spec');
  // No further commits to spec/.
  writeFileSync(join(repo, 'unrelated.txt'), 'x');
  gitCommit(repo, 'unrelated change');

  const result = await computeSpecDiffSinceClaim(repo, `git:${claim}`);
  assert.equal(result, null);
});

test('spec-diff: surfaces 2 spec commits with files, summaries, diff command', async () => {
  const repo = makeRepo('diff-two');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', 'initial');
  const claim = gitCommit(repo, 'add spec');
  writeSpec(repo, 'spec/SPEC.md', 'rev1');
  gitCommit(repo, 'fix(spec): clarify lease invariants');
  writeSpec(repo, 'spec/PRD.md', 'new prd');
  gitCommit(repo, 'docs(spec): add doctor enforcement');

  const result = await computeSpecDiffSinceClaim(repo, `git:${claim}`);
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.commitCount, 2);
  assert.deepEqual([...result.filesAffected].sort(), ['spec/PRD.md', 'spec/SPEC.md']);
  assert.equal(result.summaries.length, 2);
  // git log is newest-first
  assert.match(result.summaries[0] ?? '', /docs\(spec\): add doctor enforcement/);
  assert.match(result.summaries[1] ?? '', /fix\(spec\): clarify lease invariants/);
  assert.match(result.diffCommand, /^git diff [0-9a-f]+\.\.HEAD -- spec\/$/);
  assert.match(result.rendered, /SPEC changed since you claimed/);
  assert.match(result.rendered, /informational only/);
});

test('spec-diff: truncates summaries to 5 but reports full commitCount', async () => {
  const repo = makeRepo('diff-many');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', 'v0');
  const claim = gitCommit(repo, 'init');
  for (let i = 1; i <= 7; i += 1) {
    writeSpec(repo, 'spec/SPEC.md', `v${i}`);
    gitCommit(repo, `chore(spec): bump v${i}`);
  }

  const result = await computeSpecDiffSinceClaim(repo, `git:${claim}`);
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.commitCount, 7);
  assert.equal(result.summaries.length, 7);
  // Rendered output truncates to 5 lines + "and N more"
  const renderedLines = result.rendered.split('\n');
  const summaryLines = renderedLines.filter((l) => l.startsWith('  '));
  assert.equal(summaryLines.length, 6); // 5 commits + "… and 2 more"
  assert.ok(
    summaryLines.some((l) => l.includes('and 2 more')),
    'expected overflow marker',
  );
});

test('spec-diff: returns informational block when claim sha is orphan/unreachable', async () => {
  const repo = makeRepo('diff-orphan');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', 'v0');
  gitCommit(repo, 'init');

  // 40-hex sha that does not exist in this repo.
  const fakeSha = 'deadbeefcafebabe1234567890abcdef12345678';
  const result = await computeSpecDiffSinceClaim(repo, `git:${fakeSha}`);
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.commitCount, 0);
  assert.match(result.rendered, /no longer reachable/);
  assert.match(result.rendered, /informational only/);
});

test('spec-diff: digest-form claim — content changed → informational block, no diff command', async () => {
  const repo = makeRepo('diff-digest-changed');
  writeSpec(repo, 'spec/SPEC.md', 'before');
  const before = computeSpecRevisionSync(repo);
  assert.equal(before.source, 'digest');

  writeSpec(repo, 'spec/SPEC.md', 'after');
  const result = await computeSpecDiffSinceClaim(repo, before.revision);
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.commitCount, 0);
  assert.equal(result.diffCommand, '');
  assert.match(result.rendered, /tree is untracked/);
});

test('spec-diff: digest-form claim — content unchanged → null', async () => {
  const repo = makeRepo('diff-digest-stable');
  writeSpec(repo, 'spec/SPEC.md', 'stable');
  const claim = computeSpecRevisionSync(repo);
  assert.equal(claim.source, 'digest');

  const result = await computeSpecDiffSinceClaim(repo, claim.revision);
  assert.equal(result, null);
});

test('spec-diff: scopes correctly — only commits touching spec/ are counted', async () => {
  const repo = makeRepo('diff-scoping');
  gitInit(repo);
  writeSpec(repo, 'spec/SPEC.md', 'v0');
  const claim = gitCommit(repo, 'init');
  // Three commits: 1 to spec/, 2 unrelated.
  writeFileSync(join(repo, 'src.txt'), 'a');
  gitCommit(repo, 'unrelated 1');
  writeSpec(repo, 'spec/SPEC.md', 'v1');
  gitCommit(repo, 'spec change');
  writeFileSync(join(repo, 'src.txt'), 'b');
  gitCommit(repo, 'unrelated 2');

  const result = await computeSpecDiffSinceClaim(repo, `git:${claim}`);
  assert.notEqual(result, null);
  if (result === null) throw new Error('unreachable');
  assert.equal(result.commitCount, 1);
  assert.deepEqual([...result.filesAffected], ['spec/SPEC.md']);
});
