import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateSecondOpinion } from '../../../src/cli/orchestrate/second-opinion.ts';
import type {
  SpawnOpts,
  SpawnResult,
  SpawnSubprocess,
} from '../../../src/harnesses/index.ts';

// Integration test for AC #8: codex variant and gemini variant produce
// equivalent verdict envelopes for the same diff + prompt.
//
// Exercises the full pipeline: schema parse → settings load → createHarness
// → runReview → parseHarnessVerdict → envelope emission. The only mocked
// boundary is spawnSubprocess (the actual codex/gemini binary), injected
// through the documented seam the harnesses already expose.

function freshProject(reviewHost: 'codex' | 'gemini'): {
  forgeDir: string;
  diffPath: string;
  promptPath: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), `forge-2op-int-${reviewHost}-`));
  const forgeDir = join(cwd, '.forge');
  mkdirSync(forgeDir, { recursive: true });

  // primary_host_cli must differ from review_host_cli per the SettingsSchema
  // refinement. claude is non-reviewable so it can't collide with either
  // reviewer — pin it as primary for both cases.
  const primary = 'claude';
  const yaml = `version: 1
project:
  name: 2op-integration
tracker:
  type: linear
  config:
    team_id: T
secrets:
  manager: env_file
agents:
    primary_host_cli: ${primary}
    review_host_cli: ${reviewHost}
`;
  writeFileSync(join(forgeDir, 'settings.yaml'), yaml, 'utf8');

  const diffPath = join(cwd, 'diff.txt');
  const promptPath = join(cwd, 'prompt.txt');
  writeFileSync(
    diffPath,
    'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    'utf8',
  );
  writeFileSync(promptPath, 'Review this diff for bugs.\n', 'utf8');

  return {
    forgeDir,
    diffPath,
    promptPath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function captureStdout(t: { after: (fn: () => void) => void }): { lines: string[] } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return { lines: captured };
}

function lastEnvelope(lines: string[]): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
} {
  const last = lines[lines.length - 1] ?? '';
  return JSON.parse(last);
}

// Build a spawnSubprocess that echoes a fenced ReviewVerdict JSON block in
// stdout for the given host. The verb's harness pipeline parses this into a
// real ReviewVerdict via parseHarnessVerdict, so this exercises every layer
// between the verb and the binary.
function fenceVerdict(host: 'codex' | 'gemini'): string {
  return `Some preamble from ${host}.\n\n\`\`\`json\n${JSON.stringify({
    version: 1,
    verdict: 'changes_requested',
    findings: [
      {
        severity: 'improvement',
        path: 'src/foo.ts',
        line: 1,
        message: `${host} found a thing`,
      },
    ],
    host,
  })}\n\`\`\`\n\nTrailing text.\n`;
}

function fakeSpawn(host: 'codex' | 'gemini'): SpawnSubprocess {
  return async (
    _command: string,
    _args: readonly string[],
    _opts: SpawnOpts,
  ): Promise<SpawnResult> => ({
    stdout: fenceVerdict(host),
    stderr: '',
    exitCode: 0,
    durationMs: 42,
  });
}

test('AC #8 — codex and gemini variants produce equivalent verdict envelopes for the same input', async (t) => {
  // Gemini path requires FORGE_GEMINI_EXPERIMENTAL=1 (settings schema gates it).
  const prior = process.env.FORGE_GEMINI_EXPERIMENTAL;
  process.env.FORGE_GEMINI_EXPERIMENTAL = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GEMINI_EXPERIMENTAL;
    else process.env.FORGE_GEMINI_EXPERIMENTAL = prior;
  });

  // ── Codex variant ──
  const codexCtx = freshProject('codex');
  const { lines: codexLines } = captureStdout(t);
  t.after(codexCtx.cleanup);

  const codexResult = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-89',
      diffPath: codexCtx.diffPath,
      promptPath: codexCtx.promptPath,
      forgeDir: codexCtx.forgeDir,
      json: true,
    },
    { spawnSubprocess: fakeSpawn('codex') },
  );
  assert.equal(codexResult.exitCode, 0);
  const codexEnv = lastEnvelope(codexLines);
  assert.equal(codexEnv.ok, true);

  // ── Gemini variant ──
  // The second captureStdout(t) call replaces process.stdout.write with a new
  // monkey-patch that pushes into geminiLines. The first patch is dropped on
  // assignment, so the codex run's lines are frozen by then. Both t.after
  // restores set process.stdout.write back to the same `orig` reference;
  // idempotent, no double-restore concerns.
  const geminiCtx = freshProject('gemini');
  const { lines: geminiLines } = captureStdout(t);
  t.after(geminiCtx.cleanup);

  const geminiResult = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-89',
      diffPath: geminiCtx.diffPath,
      promptPath: geminiCtx.promptPath,
      forgeDir: geminiCtx.forgeDir,
      json: true,
    },
    { spawnSubprocess: fakeSpawn('gemini') },
  );
  assert.equal(geminiResult.exitCode, 0);
  const geminiEnv = lastEnvelope(geminiLines);
  assert.equal(geminiEnv.ok, true);

  // ── Equivalence assertions ──
  // The two envelopes differ ONLY in host fields (top-level + verdict.host).
  // Everything else — verdict outcome, findings shape, schema fields —
  // must match because both pipelines parsed the same fenced JSON shape
  // through the same ReviewVerdictSchema.
  const codexData = codexEnv.data as Record<string, unknown>;
  const geminiData = geminiEnv.data as Record<string, unknown>;

  assert.equal(codexData.host, 'codex');
  assert.equal(geminiData.host, 'gemini');
  assert.equal(codexData.task_id, geminiData.task_id);

  const codexVerdict = codexData.verdict as Record<string, unknown>;
  const geminiVerdict = geminiData.verdict as Record<string, unknown>;

  assert.equal(codexVerdict.verdict, geminiVerdict.verdict);
  assert.equal(codexVerdict.version, geminiVerdict.version);
  assert.deepEqual(
    (codexVerdict.findings as Array<{ severity: string; path: string; line?: number }>).map(
      ({ severity, path, line }) => ({ severity, path, line }),
    ),
    (geminiVerdict.findings as Array<{ severity: string; path: string; line?: number }>).map(
      ({ severity, path, line }) => ({ severity, path, line }),
    ),
  );
  // Both pipelines stamp the per-host marker; differ ONLY there.
  assert.equal(codexVerdict.host, 'codex');
  assert.equal(geminiVerdict.host, 'gemini');
});
