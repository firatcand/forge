import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VERBS,
  HELP_ORDER,
  dispatchOrchestrate,
  type VerbHandler,
} from '../../../../src/cli/orchestrate/index.ts';

// Capture process.stdout.write for the duration of `fn`.
async function captureStdout(fn: () => Promise<unknown>): Promise<{ ret: unknown; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  try {
    const ret = await fn();
    return { ret, out: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// Every flat verb + run sub-verb, for the help-loop test.
const FLAT_VERBS: string[] = [...HELP_ORDER].filter((n) => {
  const e = VERBS.get(n);
  return e instanceof Map ? false : true;
});
const RUN_SUBS: ReadonlyArray<readonly [string, string]> = [
  ['run', 'start'],
  ['run', 'list'],
];

// Spec §Verb classification table (rewritten 2026-05-17, simplified) — this
// list is intentionally embedded as test data so a SPEC edit forces a code
// review here. If you intentionally re-band a verb, update this table and the
// SPEC together.
//
// claim/dispatch/heartbeat/question/event/complete/cancel are not yet in the
// registry — Steps 4+5 add them. Until then, this test asserts what is
// currently registered AND the classification stays correct.
const EXPECTED_BANDS: ReadonlyArray<readonly [string, 'read' | 'mutate']> = [
  ['phases', 'read'],
  ['status', 'read'],
  ['questions', 'read'],
  ['doctor', 'read'],
  ['attach', 'read'],
  ['spec-diff', 'read'],
  ['guardrail-check', 'read'],
  ['render-worker-prompt', 'read'],
  ['ensure-worktree', 'mutate'],
  ['claim', 'mutate'],
  ['dispatch', 'mutate'],
  ['heartbeat', 'mutate'],
  ['question', 'mutate'],
  ['answer', 'mutate'],
  ['event', 'mutate'],
  ['complete', 'mutate'],
  ['cancel', 'mutate'],
  ['reconcile', 'mutate'],
  ['amend-roadmap', 'mutate'],
  ['gc', 'mutate'],
];

test('every expected verb is registered with the correct band', () => {
  for (const [name, band] of EXPECTED_BANDS) {
    const entry = VERBS.get(name);
    assert.ok(entry, `verb '${name}' should be registered`);
    assert.ok(!(entry instanceof Map), `verb '${name}' should be a leaf, not nested`);
    const handler = entry as VerbHandler;
    assert.equal(handler.band, band, `verb '${name}' should be ${band}`);
  }
});

test('the run sub-tree contains both start (mutate) and list (read)', () => {
  const run = VERBS.get('run');
  assert.ok(run instanceof Map, "'run' should be a nested verb");
  const sub = run as Map<string, VerbHandler>;
  assert.ok(sub.get('start'), 'run start should exist');
  assert.ok(sub.get('list'), 'run list should exist');
  assert.equal(sub.get('start')?.band, 'mutate');
  assert.equal(sub.get('list')?.band, 'read');
});

test('HELP_ORDER contains every registered top-level verb', () => {
  for (const name of VERBS.keys()) {
    assert.ok(HELP_ORDER.includes(name), `HELP_ORDER missing '${name}'`);
  }
});

test('no verb name collides with --help or other reserved tokens', () => {
  for (const name of VERBS.keys()) {
    assert.ok(!name.startsWith('--'), `verb name should not start with --: ${name}`);
    assert.ok(name !== '-h', 'verb name should not be -h');
  }
});

// ── FORGE-134: <verb> --help prints help instead of running ──────────────────

test('every flat verb + run sub-verb: --help → exit 0, synopsis on stdout, ZERO files created', async () => {
  for (const verb of FLAT_VERBS) {
    const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
    try {
      const before = listTree(root);
      const { ret, out } = await captureStdout(() =>
        dispatchOrchestrate([verb, '--help'], { cwd: root }),
      );
      assert.equal((ret as { exitCode: number }).exitCode, 0, `${verb} --help should exit 0`);
      const handler = VERBS.get(verb) as VerbHandler;
      assert.ok(out.includes(handler.synopsis), `${verb} --help should print its synopsis`);
      const after = listTree(root);
      assert.deepEqual(after, before, `${verb} --help must not create files (got ${after.join(', ')})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const [verb, sub] of RUN_SUBS) {
    const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
    try {
      const before = listTree(root);
      const { ret, out } = await captureStdout(() =>
        dispatchOrchestrate([verb, sub, '--help'], { cwd: root }),
      );
      assert.equal((ret as { exitCode: number }).exitCode, 0, `${verb} ${sub} --help exit 0`);
      const map = VERBS.get(verb) as Map<string, VerbHandler>;
      assert.ok(out.includes(map.get(sub)!.synopsis), `${verb} ${sub} --help synopsis`);
      const after = listTree(root);
      assert.deepEqual(after, before, `${verb} ${sub} --help must not create files`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('doctor --help lists --scope; phases --help lists --ready; gc --help lists --remove-worktrees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const doctor = await captureStdout(() => dispatchOrchestrate(['doctor', '--help'], { cwd: root }));
    assert.match(doctor.out, /--scope/);
    const phases = await captureStdout(() => dispatchOrchestrate(['phases', '--help'], { cwd: root }));
    assert.match(phases.out, /--ready/);
    assert.match(phases.out, /--include-warnings/);
    const gc = await captureStdout(() => dispatchOrchestrate(['gc', '--help'], { cwd: root }));
    assert.match(gc.out, /--remove-worktrees/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile --help shows exactly its six real flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { out } = await captureStdout(() => dispatchOrchestrate(['reconcile', '--help'], { cwd: root }));
    for (const f of ['--pull', '--push', '--dry-run', '--json', '--confirm-prune', '--no-prune']) {
      assert.ok(out.includes(f), `reconcile --help should list ${f}`);
    }
    assert.ok(!out.includes('--forge-dir'), 'reconcile --help must NOT list --forge-dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--json --help returns a parseable ok envelope with a flags array (--help wins over --json)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { out } = await captureStdout(() =>
      dispatchOrchestrate(['phases', '--help', '--json'], { cwd: root }),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.verb, 'phases');
    assert.equal(parsed.data.band, 'read');
    assert.ok(Array.isArray(parsed.data.flags));
    assert.ok(parsed.data.flags.some((f: { flag: string }) => f.flag === 'ready'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('-h alias prints help', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { ret, out } = await captureStdout(() => dispatchOrchestrate(['doctor', '-h'], { cwd: root }));
    assert.equal((ret as { exitCode: number }).exitCode, 0);
    assert.match(out, /forge orchestrate doctor —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('value-aware: answer <qid> --note --help does NOT print help (reaches the verb)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { ret, out } = await captureStdout(() =>
      dispatchOrchestrate(['answer', 'q-1', '--note', '--help'], { cwd: root }),
    );
    // Help is NOT printed: --help is the VALUE of --note (a value-taking flag).
    assert.ok(!out.includes('forge orchestrate answer —'), 'should not print the answer help banner');
    // The verb actually ran (it will fail on missing question, exit != 0), proving
    // we did not intercept.
    assert.notEqual((ret as { exitCode: number }).exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('value-aware: run start --name --help does NOT print help (reaches the verb)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { out } = await captureStdout(() =>
      dispatchOrchestrate(['run', 'start', '--name', '--help'], { cwd: root }),
    );
    assert.ok(!out.includes('forge orchestrate run start —'), 'should not print run start help banner');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FORGE-149 (#5a): a boolean flag followed by --help in flag position MUST print
// help — --ready takes no value, so the trailing --help is a real help request.
test('boolean flag then help: phases --ready --help prints help (exit 0)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    const { ret, out } = await captureStdout(() =>
      dispatchOrchestrate(['phases', '--ready', '--help'], { cwd: root }),
    );
    assert.equal((ret as { exitCode: number }).exitCode, 0, 'phases --ready --help should exit 0');
    assert.match(out, /forge orchestrate phases —/);
    assert.match(out, /--ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FORGE-149 (#1 / #5b): alias-honesty regression. `attach` advertises `--run`
// as an alias of `--run-id`; the handler MUST consume that value rather than
// silently falling back to the latest run. A bogus id is passed: the value is
// proven consumed because attach errors on that specific run id (no such run /
// notifications.jsonl), NOT a "no runs found" latest-pick fallback.
test('alias honesty: attach --run <id> consumes the value (does not fall back to latest)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-help-'));
  try {
    // Seed an orchestrator dir with one real run so a latest-pick fallback WOULD
    // succeed — making a fallback observably different from honoring --run.
    const realRun = join(root, '.forge', 'orchestrator', '0190real');
    mkdirSync(realRun, { recursive: true });
    writeFileSync(join(realRun, 'state.json'), JSON.stringify({ started_at: 'x' }));
    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      errChunks.push(typeof s === 'string' ? s : String(s));
      return true;
    };
    let ret: { exitCode: number };
    try {
      const { ret: r } = await captureStdout(() =>
        dispatchOrchestrate(['attach', '--run', '0190bogus'], { cwd: root }),
      );
      ret = r as { exitCode: number };
    } finally {
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    }
    const err = errChunks.join('');
    assert.equal(ret.exitCode, 1, 'attach against a bogus run id should error');
    // The error references the bogus run id we passed via --run — proving the
    // alias value was consumed and not swallowed in favor of 0190real.
    assert.ok(
      err.includes('0190bogus') || /not found/.test(err),
      `attach error should reference the passed run id, got: ${err}`,
    );
    assert.ok(!err.includes('0190real'), 'must NOT have fallen back to the latest run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
