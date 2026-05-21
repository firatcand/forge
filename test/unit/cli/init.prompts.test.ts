import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InitAnswersSchema,
  PROJECT_NAME_RE,
  GITHUB_REPO_RE,
  validateProjectName,
  validateGithubRepo,
  collectAnswers,
  __setNumberConfirmForTests,
} from '../../../src/cli/init/prompts.ts';
import { __setPromptModuleForTests, __resetForTests } from '../../../src/core/logger.ts';

interface ScriptedAnswer {
  match?: RegExp;
  value: string;
}

function scriptedPromptModule(script: ScriptedAnswer[]) {
  let idx = 0;
  const next = (msg: string): string => {
    const step = script[idx];
    if (!step) throw new Error(`scripted prompts exhausted at #${idx} for message: ${msg}`);
    if (step.match && !step.match.test(msg)) {
      throw new Error(
        `prompt order mismatch at #${idx}: expected /${step.match}/ but message was "${msg}"`,
      );
    }
    idx++;
    return step.value;
  };
  return {
    input: async (opts: { message: string; default?: string; validate?: (s: string) => true | string }) => {
      const v = next(opts.message);
      if (opts.validate) {
        const ok = opts.validate(v);
        if (ok !== true) throw new Error(`validation failed in scripted prompt: ${ok}`);
      }
      return v;
    },
    select: async <T,>(opts: { message: string; choices: { name: string; value: T }[]; default?: T }) => {
      const v = next(opts.message);
      const match = opts.choices.find((c) => c.value === (v as unknown as T) || c.name === v);
      if (!match) {
        throw new Error(
          `scripted select value "${v}" not in choices [${opts.choices.map((c) => c.name).join(', ')}]`,
        );
      }
      return match.value;
    },
  };
}

function scriptedNumberConfirm(numbers: number[], checkboxAnswer?: readonly string[]) {
  let idx = 0;
  return {
    number: async (opts: { default?: number; validate?: (n: number | undefined) => true | string }) => {
      const v = numbers[idx++];
      if (v === undefined) throw new Error('exhausted scripted numbers');
      if (opts.validate) {
        const ok = opts.validate(v);
        if (ok !== true) throw new Error(`number validation failed: ${ok}`);
      }
      return v;
    },
    confirm: async () => true,
    // FORGE-152: the enabled_root_files checkbox prompt. Defaults to whatever
    // is pre-checked in the choices array (which collectAnswers sets to
    // [primary_host_cli]). Tests can override by passing checkboxAnswer.
    checkbox: async (opts: {
      choices: ReadonlyArray<{ value: string; checked?: boolean }>;
      validate?: (
        selected: ReadonlyArray<{ value: string }>,
      ) => boolean | string | Promise<boolean | string>;
    }) => {
      const value =
        checkboxAnswer !== undefined
          ? [...checkboxAnswer]
          : opts.choices.filter((c) => c.checked).map((c) => c.value);
      if (opts.validate) {
        const ok = await opts.validate(value.map((v) => ({ value: v })));
        if (ok !== true) throw new Error(`checkbox validation failed: ${ok}`);
      }
      return value;
    },
  };
}

test('PROJECT_NAME_RE accepts standard slugs', () => {
  assert.ok(PROJECT_NAME_RE.test('my-app'));
  assert.ok(PROJECT_NAME_RE.test('my_app'));
  assert.ok(PROJECT_NAME_RE.test('app.v2'));
  assert.ok(PROJECT_NAME_RE.test('Abc123'));
});

test('PROJECT_NAME_RE rejects forbidden chars', () => {
  assert.equal(PROJECT_NAME_RE.test('my app'), false);
  assert.equal(PROJECT_NAME_RE.test('my/app'), false);
  assert.equal(PROJECT_NAME_RE.test(''), false);
});

test('validateProjectName rejects reserved/edge inputs', () => {
  assert.equal(validateProjectName(''), 'project name is required');
  assert.notEqual(validateProjectName('node_modules'), true);
  assert.notEqual(validateProjectName('.hidden'), true);
  assert.notEqual(validateProjectName('-leading'), true);
  assert.notEqual(validateProjectName('a'.repeat(65)), true);
  assert.equal(validateProjectName('my-app'), true);
});

test('GITHUB_REPO_RE matches owner/repo only', () => {
  assert.ok(GITHUB_REPO_RE.test('firatcand/forge'));
  assert.equal(GITHUB_REPO_RE.test('forge'), false);
  assert.equal(GITHUB_REPO_RE.test('firatcand/forge/extra'), false);
  assert.equal(GITHUB_REPO_RE.test('owner repo'), false);
});

test('validateGithubRepo enforces shape', () => {
  assert.equal(validateGithubRepo('firatcand/forge'), true);
  assert.notEqual(validateGithubRepo('just-owner'), true);
});

test('InitAnswersSchema accepts a happy-path linear/env_file answers object', () => {
  const ok = InitAnswersSchema.safeParse({
    project: { name: 'sample-app' },
    goal: 'ship a thing',
    tracker: { type: 'linear', config: { team_id: 'TEAM-1' } },
    secrets: { manager: 'env_file', env_file_path: './.env.local' },
    agents: {
      max_concurrent: 10,
      retry_attempts: 10,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['claude'],
    },
    design: { mode: 'project_owned' },
  });
  assert.equal(ok.success, true);
});

test('InitAnswersSchema rejects review_host_cli === primary_host_cli', () => {
  const bad = InitAnswersSchema.safeParse({
    project: { name: 'a' },
    goal: 'x',
    tracker: { type: 'github', config: { repo: 'a/b' } },
    secrets: { manager: 'env_file', env_file_path: './.env' },
    agents: {
      max_concurrent: 5,
      retry_attempts: 3,
      primary_host_cli: 'claude',
      review_host_cli: 'claude',
      enabled_root_files: ['claude'],
    },
    design: { mode: 'project_owned' },
  });
  assert.equal(bad.success, false);
});

test('InitAnswersSchema allows review_host_cli: null', () => {
  const ok = InitAnswersSchema.safeParse({
    project: { name: 'a' },
    goal: 'x',
    tracker: { type: 'notion', config: { database_id: 'db1' } },
    secrets: { manager: '1password', vault: 'Personal' },
    agents: {
      max_concurrent: 1,
      retry_attempts: 0,
      primary_host_cli: 'codex',
      review_host_cli: null,
      enabled_root_files: ['codex'],
    },
    design: { mode: 'project_owned' },
  });
  assert.equal(ok.success, true);
});

// FORGE-152: new schema-level refinements
test('FORGE-152 — InitAnswersSchema rejects empty enabled_root_files', () => {
  const bad = InitAnswersSchema.safeParse({
    project: { name: 'a' },
    goal: 'x',
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file', env_file_path: './.env' },
    agents: {
      max_concurrent: 5,
      retry_attempts: 3,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: [],
    },
    design: { mode: 'project_owned' },
  });
  assert.equal(bad.success, false);
});

test('FORGE-152 — InitAnswersSchema rejects enabled_root_files missing primary', () => {
  const bad = InitAnswersSchema.safeParse({
    project: { name: 'a' },
    goal: 'x',
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file', env_file_path: './.env' },
    agents: {
      max_concurrent: 5,
      retry_attempts: 3,
      primary_host_cli: 'claude',
      review_host_cli: 'codex',
      enabled_root_files: ['codex', 'gemini'],
    },
    design: { mode: 'project_owned' },
  });
  assert.equal(bad.success, false);
});

test('collectAnswers — happy path linear + env_file via scripted prompts', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  __setPromptModuleForTests(
    scriptedPromptModule([
      { match: /Project name/, value: 'sample-app' },
      { match: /description/, value: 'a sample' },
      { match: /goal/, value: 'ship a thing' },
      { match: /task tracker/, value: 'linear' },
      { match: /team_id/, value: 'TEAM-1' },
      { match: /secret manager/, value: 'env_file' },
      { match: /Env file path/, value: './.env.local' },
      { match: /Primary host CLI/, value: 'claude' },
      { match: /Review host CLI/, value: 'codex' },
    ]),
  );
  __setNumberConfirmForTests(scriptedNumberConfirm([10, 10]));
  const answers = await collectAnswers({ cwd: '/tmp/wherever' });
  assert.equal(answers.project.name, 'sample-app');
  assert.equal(answers.project.description, 'a sample');
  assert.equal(answers.goal, 'ship a thing');
  assert.equal(answers.tracker.type, 'linear');
  assert.equal(answers.secrets.manager, 'env_file');
  assert.equal(answers.agents.primary_host_cli, 'claude');
  assert.equal(answers.agents.review_host_cli, 'codex');
});

test('collectAnswers — positional name skips prompt 1', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  __setPromptModuleForTests(
    scriptedPromptModule([
      { match: /description/, value: '' },
      { match: /goal/, value: 'g' },
      { match: /task tracker/, value: 'github' },
      { match: /GitHub repo/, value: 'firatcand/forge' },
      { match: /secret manager/, value: 'doppler' },
      { match: /Doppler project/, value: 'proj' },
      { match: /Doppler config/, value: 'dev' },
      { match: /Primary host CLI/, value: 'claude' },
      { match: /Review host CLI/, value: 'codex' },
    ]),
  );
  __setNumberConfirmForTests(scriptedNumberConfirm([2, 3]));
  const answers = await collectAnswers({ cwd: '/tmp/dir', positionalName: 'cli-positional' });
  assert.equal(answers.project.name, 'cli-positional');
  assert.equal(answers.project.description, undefined);
  assert.equal(answers.tracker.type, 'github');
  if (answers.tracker.type === 'github') {
    assert.equal(answers.tracker.config.repo, 'firatcand/forge');
  }
  assert.equal(answers.secrets.manager, 'doppler');
});

test('collectAnswers — positional name with bad chars throws', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  __setPromptModuleForTests(scriptedPromptModule([]));
  __setNumberConfirmForTests(scriptedNumberConfirm([]));
  await assert.rejects(
    collectAnswers({ cwd: '/tmp/d', positionalName: 'has spaces' }),
    /invalid project name/,
  );
});

test('collectAnswers — review_host_cli === primary re-prompts then succeeds', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  // FORGE-88: primary=codex, review=codex is the new collision case
  // (claude is no longer a valid review host). On re-prompt, picking
  // 'none' yields null and clears the refinement.
  __setPromptModuleForTests(
    scriptedPromptModule([
      { match: /Project name/, value: 'app' },
      { match: /description/, value: '' },
      { match: /goal/, value: 'g' },
      { match: /task tracker/, value: 'notion' },
      { match: /database_id/, value: 'db1' },
      { match: /secret manager/, value: 'env_file' },
      { match: /Env file path/, value: './.env.local' },
      { match: /Primary host CLI/, value: 'codex' },
      { match: /Review host CLI/, value: 'codex' }, // collision — should re-prompt
      { match: /Review host CLI/, value: 'none' },
    ]),
  );
  __setNumberConfirmForTests(scriptedNumberConfirm([5, 5]));
  const answers = await collectAnswers({ cwd: '/tmp/d' });
  assert.equal(answers.agents.primary_host_cli, 'codex');
  assert.equal(answers.agents.review_host_cli, null);
});

test('collectAnswers — review_host_cli "none" yields null', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  __setPromptModuleForTests(
    scriptedPromptModule([
      { match: /Project name/, value: 'app' },
      { match: /description/, value: '' },
      { match: /goal/, value: 'g' },
      { match: /task tracker/, value: 'linear' },
      { match: /team_id/, value: 'T' },
      { match: /secret manager/, value: 'env_file' },
      { match: /Env file path/, value: './.env.local' },
      { match: /Primary host CLI/, value: 'codex' },
      { match: /Review host CLI/, value: 'none' },
    ]),
  );
  __setNumberConfirmForTests(scriptedNumberConfirm([1, 0]));
  const answers = await collectAnswers({ cwd: '/tmp/d' });
  assert.equal(answers.agents.review_host_cli, null);
});

test('collectAnswers — aws_secrets and infisical labelled (adapter pending) but still selectable', async (t) => {
  t.after(() => {
    __resetForTests();
    __setNumberConfirmForTests(null);
  });
  __setPromptModuleForTests(
    scriptedPromptModule([
      { match: /Project name/, value: 'app' },
      { match: /description/, value: '' },
      { match: /goal/, value: 'g' },
      { match: /task tracker/, value: 'linear' },
      { match: /team_id/, value: 'T' },
      { match: /secret manager/, value: 'aws_secrets (adapter pending)' },
      { match: /AWS region/, value: 'us-east-1' },
      { match: /Primary host CLI/, value: 'claude' },
      { match: /Review host CLI/, value: 'codex' },
    ]),
  );
  __setNumberConfirmForTests(scriptedNumberConfirm([10, 10]));
  const answers = await collectAnswers({ cwd: '/tmp/d' });
  assert.equal(answers.secrets.manager, 'aws_secrets');
});
