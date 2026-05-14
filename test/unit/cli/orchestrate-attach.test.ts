import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  serializeEvent,
  type NotificationEvent,
} from '../../../src/orchestrator/events.ts';
import { runOrchestrateAttach } from '../../../src/cli/orchestrate-attach.ts';

function captureStreams(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on('data', (c: Buffer) => outChunks.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-cli-attach-'));
}

function writeJsonl(forgeDir: string, runId: string, lines: string[]): void {
  const runDir = join(forgeDir, 'orchestrator', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'notifications.jsonl'), lines.join('\n') + '\n');
}

function questionEvent(qid: string): NotificationEvent {
  return {
    type: 'question',
    ts: '2026-05-13T12:00:00.000Z',
    run_id: '0190run1',
    task_id: 'FORGE-20',
    question_id: qid,
    decision_key: `key:${qid}`,
    attempt: 1,
    question: 'Q?',
    context: '',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  };
}

test('orchestrate attach exits 1 when no orchestrator runs exist', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const result = await runOrchestrateAttach({
      forgeDir,
      stdout,
      stderr,
      follow: false,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /no runs found/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate attach replays historical events from notifications.jsonl', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    const e1 = serializeEvent(questionEvent('q1'));
    const e2 = serializeEvent({
      type: 'question_resolved',
      ts: '2026-05-13T12:05:00.000Z',
      run_id: '0190run1',
      task_id: 'FORGE-20',
      question_id: 'q1',
      resolution: 'answered',
      answer_option_id: 'a',
    });
    writeJsonl(forgeDir, '0190run1', [e1, e2]);
    const result = await runOrchestrateAttach({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
      follow: false,
    });
    assert.equal(result.exitCode, 0, `stderr: ${err()}`);
    const output = out();
    assert.match(output, /question.*FORGE-20.*q1/);
    assert.match(output, /resolved.*FORGE-20.*q1.*answered.*option=a/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate attach surfaces corrupt JSONL lines on stderr and continues', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    const good = serializeEvent(questionEvent('q1'));
    writeJsonl(forgeDir, '0190run1', [good, 'not json', good.replace('q1', 'q2')]);
    const result = await runOrchestrateAttach({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
      follow: false,
    });
    assert.equal(result.exitCode, 0);
    assert.match(err(), /\[warn\] corrupt line/);
    const output = out();
    assert.match(output, /q1/);
    assert.match(output, /q2/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate attach warns when the dispatcher pid is not alive', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const runDir = join(forgeDir, 'orchestrator', '0190run1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pid'), '99999\n');
    writeJsonl(forgeDir, '0190run1', [serializeEvent(questionEvent('q1'))]);
    const result = await runOrchestrateAttach({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
      follow: false,
      isPidAlive: () => false,
    });
    assert.equal(result.exitCode, 0);
    assert.match(err(), /dispatcher process 99999 is not running/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate attach auto-detects the latest run when none provided', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeJsonl(forgeDir, '0190run-a', [serializeEvent(questionEvent('q-old'))]);
    writeJsonl(forgeDir, '0190run-b', [serializeEvent(questionEvent('q-new'))]);
    const result = await runOrchestrateAttach({
      forgeDir,
      stdout,
      stderr,
      follow: false,
    });
    assert.equal(result.exitCode, 0);
    const output = out();
    assert.match(output, /q-new/);
    assert.equal(output.includes('q-old'), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
