// Top-level orchestrator for `forge init`.
//
// Test/CI env vars (12-Factor — documented per CLAUDE.md):
//   FORGE_INIT_NONINTERACTIVE=1 — skip all prompts; require FORGE_INIT_ANSWERS_JSON.
//   FORGE_INIT_ANSWERS_JSON=<json> — pre-supplied InitAnswers object for headless runs.
//   FORGE_INIT_SKIP_VALIDATION=1 — skip the tooling-probe phase (perf/smoke tests).
//
// Composition: preflight → prompts → validate → scaffold → banner.

import { resolve } from 'node:path';
import { confirm as inquirerConfirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { banner, errorBlock, kv, section, step } from '../core/logger.ts';
import { collectAnswers, InitAnswersSchema, type InitAnswers } from './init/prompts.ts';
import { runPreflight } from './init/preflight.ts';
import { validateTooling, type ExecaLike, type ValidationReport } from './init/validate.ts';
import { scaffoldProject } from './init/scaffold.ts';

export type ConfirmFn = (message: string, defaultValue: boolean) => Promise<boolean>;

export interface InitOptions {
  cwd?: string;
  positionalName?: string;
  exec?: ExecaLike;
  // Injectable confirm for testability. In interactive mode (!nonInteractive),
  // defaults to @inquirer/prompts confirm; in non-interactive mode, preflight
  // uses its own default (auto-decline overwrites, auto-accept git init).
  confirm?: ConfirmFn;
}

export interface InitResult {
  exitCode: number;
  written: string[];
  skipped: string[];
  unverified: string[];
  warningsPath?: string;
}

function envTrue(name: string): boolean {
  const v = process.env[name];
  return !!v && /^(1|true|yes)$/i.test(v);
}

function loadEnvAnswers(): InitAnswers | null {
  const raw = process.env.FORGE_INIT_ANSWERS_JSON;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `FORGE_INIT_ANSWERS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = InitAnswersSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `FORGE_INIT_ANSWERS_JSON failed validation: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return result.data;
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const exec = opts.exec ?? (execa as unknown as ExecaLike);
  const nonInteractive = envTrue('FORGE_INIT_NONINTERACTIVE');
  const skipValidation = envTrue('FORGE_INIT_SKIP_VALIDATION');

  banner('forge init', 'Scaffolding your project workspace');

  // Wire confirm: in interactive mode use @inquirer/prompts; in non-interactive
  // mode leave undefined so preflight applies its documented default behavior.
  const confirmFn: ConfirmFn | undefined =
    opts.confirm ??
    (nonInteractive
      ? undefined
      : async (message: string, defaultValue: boolean): Promise<boolean> =>
          inquirerConfirm({ message, default: defaultValue }));

  // ─── 1) PREFLIGHT ─────────────────────────────────────────────────────────
  section('Preflight');
  // If an explicit confirm is provided (e.g. by a test), it must override
  // env-driven non-interactive defaults at the preflight layer. Without this,
  // preflight short-circuits on `nonInteractive` and silently drops opts.confirm.
  const preflightNonInteractive = nonInteractive && !opts.confirm;
  const pre = await runPreflight({
    cwd,
    nonInteractive: preflightNonInteractive,
    exec,
    ...(confirmFn ? { confirm: confirmFn } : {}),
  });
  if (pre.kind === 'refuse-framework') {
    errorBlock('Cannot init here', pre.message);
    return { exitCode: 2, written: [], skipped: [], unverified: [] };
  }
  if (pre.kind === 'cancelled') {
    errorBlock('forge init cancelled', pre.reason);
    return { exitCode: 1, written: [], skipped: [], unverified: [] };
  }
  step(pre.gitInitialised ? 'git workspace ready' : 'git not initialised (declined)', pre.gitInitialised ? 'pass' : 'warn');

  // ─── 2) PROMPTS ───────────────────────────────────────────────────────────
  section('Project answers');
  let answers: InitAnswers;
  const envAnswers = loadEnvAnswers();
  if (envAnswers) {
    answers = envAnswers;
    step('Loaded answers from FORGE_INIT_ANSWERS_JSON', 'pass');
  } else if (nonInteractive) {
    errorBlock(
      'FORGE_INIT_NONINTERACTIVE=1 requires FORGE_INIT_ANSWERS_JSON',
      'No prompts can be issued in non-interactive mode without pre-supplied answers.',
    );
    return { exitCode: 1, written: [], skipped: [], unverified: [] };
  } else {
    try {
      answers = await collectAnswers({ cwd, positionalName: opts.positionalName });
    } catch (err) {
      // Ctrl-C surfaces here as ExitPromptError or similar from @inquirer/prompts.
      const name = err instanceof Error ? err.name : '';
      if (name === 'ExitPromptError') {
        // Quiet exit — user cancelled.
        return { exitCode: 130, written: [], skipped: [], unverified: [] };
      }
      errorBlock(err instanceof Error ? err : new Error(String(err)));
      return { exitCode: 1, written: [], skipped: [], unverified: [] };
    }
  }
  kv({
    project: answers.project.name,
    tracker: answers.tracker.type,
    secrets: answers.secrets.manager,
    primary_host: answers.agents.primary_host_cli,
    review_host: answers.agents.review_host_cli ?? '(none)',
  });

  // ─── 3) VALIDATE ──────────────────────────────────────────────────────────
  let report: ValidationReport = { results: [], unverified: [], gitFatal: false };
  if (skipValidation) {
    section('Tooling validation (skipped via FORGE_INIT_SKIP_VALIDATION)');
  } else {
    section('Tooling validation');
    try {
      report = await validateTooling(answers, {
        cwd,
        exec,
        autoSkipFailures: nonInteractive,
      });
    } catch (err) {
      errorBlock(err instanceof Error ? err : new Error(String(err)));
      return { exitCode: 1, written: [], skipped: [], unverified: [] };
    }
    for (const r of report.results) {
      step(`${r.label}${r.message ? ` — ${r.message}` : ''}`, r.status);
    }
    if (report.gitFatal) {
      errorBlock(
        'git ≥ 2.20 is required',
        'forge orchestrator uses git worktrees; install/upgrade git before running init.',
        'https://git-scm.com/downloads',
      );
      return { exitCode: 1, written: [], skipped: [], unverified: report.unverified };
    }
  }

  // ─── 4) SCAFFOLD ──────────────────────────────────────────────────────────
  section('Scaffolding');
  let scaffold: { written: string[]; skipped: string[]; warningsPath?: string };
  try {
    scaffold = scaffoldProject({
      cwd,
      answers,
      unverified: report.unverified,
      overwrite: pre.overwrite,
    });
  } catch (err) {
    errorBlock(err instanceof Error ? err : new Error(String(err)));
    return { exitCode: 1, written: [], skipped: [], unverified: report.unverified };
  }
  for (const w of scaffold.written) step(`wrote ${w}`, 'pass');
  for (const s of scaffold.skipped) step(`skipped ${s} (existing)`, 'skip');

  // ─── 5) BANNER ────────────────────────────────────────────────────────────
  section('Next steps');
  kv({
    'spec dir': 'spec/',
    'settings': '.forge/settings.yaml',
    ...(scaffold.warningsPath ? { 'warnings': '.forge/init-warnings.md' } : {}),
  });
  step('Run `claude` then `/forge` to draft your BRIEF.', 'pass');

  return {
    exitCode: 0,
    written: scaffold.written,
    skipped: scaffold.skipped,
    unverified: report.unverified,
    warningsPath: scaffold.warningsPath,
  };
}
