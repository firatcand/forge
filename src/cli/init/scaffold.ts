import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { SettingsSchema, type Settings } from '../../schemas/index.ts';
import type { InitAnswers } from './prompts.ts';
import { renderTemplate, resolveTemplatesDir, type TemplateVars } from './templates.ts';

export interface ScaffoldOptions {
  cwd: string;
  answers: InitAnswers;
  unverified?: string[];
  isoDate?: string;
  overwrite?: Record<string, boolean>;
  templatesDir?: string;
}

export interface ScaffoldResult {
  written: string[];
  skipped: string[];
  warningsPath?: string;
}

const STAGING_DIR = '.forge/.init-staging';
const GITIGNORE_MARKER = '# forge';
const GITIGNORE_BLOCK = [
  '',
  '# forge — orchestrator artefacts (auto-managed; safe to keep out of VCS)',
  '.forge/worktrees/',
  '.forge/logs/',
  '.forge/.init-staging/',
  '',
].join('\n');

interface Artifact {
  // Path relative to cwd.
  relPath: string;
  contents: string;
  // True if this artefact must be written even if the destination exists (settings.yaml is the marker file).
  mustOverwrite?: boolean;
}

export function toSettingsObject(answers: InitAnswers): Settings {
  // Construct the minimal Settings POJO. Optional fields are omitted so YAML stays human-friendly;
  // zod defaults will expand on load.
  const out: Settings = {
    version: 1 as const,
    project: {
      name: answers.project.name,
      ...(answers.project.description ? { description: answers.project.description } : {}),
    },
    tracker: answers.tracker,
    secrets: answers.secrets,
    // Cast: zod's z.object().refine().default() produces a non-undefined output type when parsed,
    // but Settings's static type still requires the full agents object since we set it explicitly.
    agents: {
      max_concurrent: answers.agents.max_concurrent,
      retry_attempts: answers.agents.retry_attempts,
      retry_backoff_ms_max: 300_000,
      poll_interval_ms: 30_000,
      worktree_root: './.forge/worktrees',
      on_persistent_failure: 'notify' as const,
      primary_host_cli: answers.agents.primary_host_cli,
      review_host_cli: answers.agents.review_host_cli,
    },
    design: {
      mode: answers.design.mode,
      ...(answers.design.reference ? { reference: answers.design.reference } : {}),
    },
  };
  return out;
}

// Minimal YAML projection — only the fields the user explicitly provided.
// Keeps the on-disk file readable; zod fills in defaults at load time.
export function toMinimalYamlObject(answers: InitAnswers): Record<string, unknown> {
  const project: Record<string, unknown> = { name: answers.project.name };
  if (answers.project.description) project.description = answers.project.description;

  const agents: Record<string, unknown> = {
    max_concurrent: answers.agents.max_concurrent,
    retry_attempts: answers.agents.retry_attempts,
    primary_host_cli: answers.agents.primary_host_cli,
    review_host_cli: answers.agents.review_host_cli,
  };

  const design: Record<string, unknown> = { mode: answers.design.mode };
  if (answers.design.reference) design.reference = answers.design.reference;

  return {
    version: 1,
    project,
    tracker: answers.tracker,
    secrets: answers.secrets,
    agents,
    design,
  };
}

function writeAtomic(absPath: string, contents: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.forge-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, contents, 'utf8');
  renameSync(tmpPath, absPath);
}

function injectBriefGoal(briefRaw: string, goal: string): string {
  // Replace the `## Product\n<!-- REQUIRED: ... -->` block body with the user's goal.
  // The template line: `<!-- REQUIRED: One or two sentences. What does this product DO? -->`
  const re = /(## Product\n)<!-- REQUIRED:[^>]*-->/;
  if (!re.test(briefRaw)) {
    // Defensive: if the template changed, append goal to the end of the file instead of silently losing it.
    return briefRaw + `\n\n## Product\n${goal}\n`;
  }
  return briefRaw.replace(re, `$1${goal}`);
}

export function appendGitignoreBlock(existing: string | null): { content: string; appended: boolean } {
  if (existing !== null && existing.includes(GITIGNORE_MARKER)) {
    return { content: existing, appended: false };
  }
  const base = existing ?? '';
  const sep = base.length === 0 || base.endsWith('\n') ? '' : '\n';
  return { content: base + sep + GITIGNORE_BLOCK, appended: true };
}

function buildArtifacts(opts: ScaffoldOptions, vars: TemplateVars): Artifact[] {
  const templatesDir = opts.templatesDir ?? resolveTemplatesDir();
  const yamlContent = yamlStringify(toMinimalYamlObject(opts.answers), { lineWidth: 0 });

  const briefRaw = renderTemplate(templatesDir, 'BRIEF.template.md', vars);
  const brief = injectBriefGoal(briefRaw, opts.answers.goal);

  const artefacts: Artifact[] = [
    { relPath: 'spec/BRIEF.md', contents: brief },
    { relPath: 'spec/PRD.md', contents: renderTemplate(templatesDir, 'PRD.template.md', vars) },
    { relPath: 'spec/SPEC.md', contents: renderTemplate(templatesDir, 'SPEC.template.md', vars) },
    { relPath: 'spec/DESIGN.md', contents: renderTemplate(templatesDir, 'DESIGN.template.md', vars) },
    { relPath: 'CRITICAL.md', contents: renderTemplate(templatesDir, 'CRITICAL.template.md', vars) },
    { relPath: 'CLAUDE.md', contents: renderTemplate(templatesDir, 'CLAUDE.project.template.md', vars) },
    { relPath: 'plans/tasks/.gitkeep', contents: '' },
    // settings.yaml is the last to land — proves init succeeded.
    { relPath: '.forge/settings.yaml', contents: yamlContent, mustOverwrite: true },
  ];
  return artefacts;
}

function buildWarningsBody(unverified: string[]): string {
  const lines = [
    '# forge init — unverified tooling',
    '',
    'These probes failed or were skipped during `forge init`. Resolve before running `forge orchestrate`.',
    '',
  ];
  for (const key of unverified) {
    lines.push(`- [ ] \`${key}\``);
  }
  lines.push('');
  return lines.join('\n');
}

export function scaffoldProject(opts: ScaffoldOptions): ScaffoldResult {
  const vars: TemplateVars = {
    PROJECT_NAME: opts.answers.project.name,
    ISO_DATE: opts.isoDate ?? new Date().toISOString().slice(0, 10),
    DESIGN_MODE: opts.answers.design.mode,
    DESIGN_REFERENCE: opts.answers.design.reference ?? '',
  };
  const artefacts = buildArtifacts(opts, vars);
  const overwrite = opts.overwrite ?? {};
  const stagingRoot = resolve(opts.cwd, STAGING_DIR);

  // Clear any orphaned staging dir from a previous crash.
  if (existsSync(stagingRoot)) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  mkdirSync(stagingRoot, { recursive: true });

  // 1) Stage every artefact.
  for (const a of artefacts) {
    const stagedPath = resolve(stagingRoot, a.relPath);
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, a.contents, 'utf8');
  }

  // 2) Promote each artefact, respecting per-file overwrite decisions.
  const written: string[] = [];
  const skipped: string[] = [];
  // Settings yaml MUST be last — it's the marker file that proves init succeeded.
  const ordered = [
    ...artefacts.filter((a) => a.relPath !== '.forge/settings.yaml'),
    ...artefacts.filter((a) => a.relPath === '.forge/settings.yaml'),
  ];
  for (const a of ordered) {
    const dest = resolve(opts.cwd, a.relPath);
    const exists = existsSync(dest);
    const allow = a.mustOverwrite || !exists || overwrite[a.relPath] === true;
    if (!allow) {
      skipped.push(a.relPath);
      continue;
    }
    const stagedPath = resolve(stagingRoot, a.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    // rename ≈ atomic on same fs
    if (exists) {
      // remove target so renameSync semantics across platforms behave
      rmSync(dest, { force: true });
    }
    renameSync(stagedPath, dest);
    written.push(a.relPath);
  }

  // 3) .gitignore append (idempotent).
  const giPath = resolve(opts.cwd, '.gitignore');
  const existingGi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : null;
  const { content, appended } = appendGitignoreBlock(existingGi);
  if (appended) {
    writeAtomic(giPath, content);
    written.push('.gitignore');
  } else {
    skipped.push('.gitignore');
  }

  // 4) Init warnings sidecar (if any unverified tools).
  let warningsPath: string | undefined;
  if (opts.unverified && opts.unverified.length > 0) {
    const p = resolve(opts.cwd, '.forge/init-warnings.md');
    writeAtomic(p, buildWarningsBody(opts.unverified));
    warningsPath = p;
    written.push('.forge/init-warnings.md');
  }

  // 5) Cleanup staging dir.
  rmSync(stagingRoot, { recursive: true, force: true });

  // 6) Round-trip sanity-check: parse YAML through SettingsSchema.
  const yamlContent = readFileSync(resolve(opts.cwd, '.forge/settings.yaml'), 'utf8');
  const parsed = SettingsSchema.safeParse(yamlParse(yamlContent));
  if (!parsed.success) {
    throw new Error(
      `forge init: scaffolded settings.yaml failed schema validation — ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  return { written, skipped, warningsPath };
}
