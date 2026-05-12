import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInit, type ConfirmFn } from '../../../src/cli/init.ts';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-init-orch-'));
}

const noopExec: ExecaLike = async () => ({ exitCode: 0, stdout: '', stderr: '' });

test('orchestrator: refuses to run inside @firatcand/forge (returns exitCode 2)', async () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: '@firatcand/forge' }));
  // Use non-interactive to avoid hanging on prompts; refusal happens in preflight
  // before any prompt is reached.
  const prior = process.env.FORGE_INIT_NONINTERACTIVE;
  process.env.FORGE_INIT_NONINTERACTIVE = '1';
  try {
    const r = await runInit({ cwd, exec: noopExec });
    assert.equal(r.exitCode, 2);
    assert.deepEqual(r.written, []);
  } finally {
    if (prior === undefined) delete process.env.FORGE_INIT_NONINTERACTIVE;
    else process.env.FORGE_INIT_NONINTERACTIVE = prior;
  }
});

test('orchestrator: opts.confirm overrides FORGE_INIT_NONINTERACTIVE for preflight (regression — codex MED pass 2)', async () => {
  // Without this override, preflight short-circuits on nonInteractive and silently
  // drops opts.confirm, making the plumbing misleading for programmatic callers.
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'version: 1\n');

  const prompted: { message: string; default: boolean }[] = [];
  const stubConfirm: ConfirmFn = async (message, defaultValue) => {
    prompted.push({ message, default: defaultValue });
    return true; // accept overwrite — flow proceeds past the settings.yaml gate
  };

  // Both: env says non-interactive, AND caller supplies opts.confirm.
  // Caller intent wins for preflight.
  const prior = process.env.FORGE_INIT_NONINTERACTIVE;
  process.env.FORGE_INIT_NONINTERACTIVE = '1';
  try {
    // No FORGE_INIT_ANSWERS_JSON → orchestrator fails-fast at the prompts phase
    // with exit 1, but preflight has already run. That's enough to prove the
    // confirm was invoked.
    await runInit({ cwd, exec: noopExec, confirm: stubConfirm });
    assert.ok(
      prompted.some((p) => p.message.includes('.forge/settings.yaml')),
      `expected confirm to be invoked despite FORGE_INIT_NONINTERACTIVE=1; got ${JSON.stringify(prompted)}`,
    );
  } finally {
    if (prior === undefined) delete process.env.FORGE_INIT_NONINTERACTIVE;
    else process.env.FORGE_INIT_NONINTERACTIVE = prior;
  }
});

test('orchestrator: passes injected confirm() through to preflight in interactive mode', async () => {
  // Regression for codex P2: in interactive mode runInit must wire a real confirm
  // to preflight, not let preflight fall back to its default (which auto-declines
  // overwrites and cancels on existing settings.yaml).
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'version: 1\n');

  const prompted: { message: string; default: boolean }[] = [];
  const stubConfirm: ConfirmFn = async (message, defaultValue) => {
    prompted.push({ message, default: defaultValue });
    return false; // decline overwrite — flow should cancel cleanly
  };

  // Force interactive: ensure FORGE_INIT_NONINTERACTIVE is not set.
  const prior = process.env.FORGE_INIT_NONINTERACTIVE;
  delete process.env.FORGE_INIT_NONINTERACTIVE;
  try {
    const r = await runInit({ cwd, exec: noopExec, confirm: stubConfirm });
    // settings.yaml exists + user declined → cancelled (exitCode 1).
    assert.equal(r.exitCode, 1);
    // Confirm must have been called for the .forge/settings.yaml overwrite.
    assert.ok(
      prompted.some((p) => p.message.includes('.forge/settings.yaml')),
      `expected confirm to be invoked for settings.yaml overwrite; got ${JSON.stringify(prompted)}`,
    );
    // Overwrite confirms default to false (don't overwrite by accident).
    const settingsPrompt = prompted.find((p) => p.message.includes('.forge/settings.yaml'));
    assert.equal(settingsPrompt?.default, false);
  } finally {
    if (prior !== undefined) process.env.FORGE_INIT_NONINTERACTIVE = prior;
  }
});
