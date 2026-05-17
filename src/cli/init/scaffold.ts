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

export interface ToolingExcludeWarning {
  target: string;
  snippet: string;
}

export interface ToolingExcludeResult {
  written: string[];
  skipped: string[];
  warned: ToolingExcludeWarning[];
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

// Exclude entry for flat-ignore files (.eslintignore, .prettierignore).
const TOOLING_EXCLUDE_LINE = '.forge/worktrees/';
// Marker for substring detection in JSON/TS configs (warn-only targets).
const TOOLING_EXCLUDE_MARKER = '.forge/worktrees';
const VITEST_CONFIG_EXTS = ['ts', 'js', 'mjs', 'cjs'] as const;

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

/**
 * Append `line` to `filePath` if the file exists and doesn't already contain
 * that exact line. Returns the outcome:
 *   - `existed: false` → file missing (caller treats as no-op, neither written nor skipped)
 *   - `existed: true, appended: false` → file existed, line already present (skipped)
 *   - `existed: true, appended: true` → file existed, line was appended (written)
 */
export function appendLineIfMissing(
  filePath: string,
  line: string,
): { existed: boolean; appended: boolean } {
  if (!existsSync(filePath)) {
    return { existed: false, appended: false };
  }
  const content = readFileSync(filePath, 'utf8');
  // Exact-line match against newline-split entries — avoids false positives from
  // substring matches (e.g. a comment that mentions the path).
  const lines = content.split('\n');
  if (lines.includes(line)) {
    return { existed: true, appended: false };
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  writeAtomic(filePath, content + sep + line + '\n');
  return { existed: true, appended: true };
}

/**
 * Hybrid scaffolding (FORGE-115 / P2.5-T19): the forge orchestrator writes
 * worktrees to `.forge/worktrees/`, which lives inside the project root. Without
 * tool-side exclusion, ESLint / Prettier / TypeScript / Vitest will all recurse
 * into worktrees and double-process every file.
 *
 * For flat-ignore files (`.eslintignore`, `.prettierignore`) we append one line —
 * format is well-defined, idempotent via line-match, low blast radius.
 *
 * For code configs (`tsconfig.json` may contain `//` comments and reject JSON.parse;
 * `vitest.config.*` is TypeScript) we WARN-ONLY: emit a copy-paste snippet to
 * `.forge/init-warnings.md` rather than risk corrupting the user's config.
 */
export function appendToolingExcludes(cwd: string): ToolingExcludeResult {
  const result: ToolingExcludeResult = { written: [], skipped: [], warned: [] };

  // Flat-ignore files — safe to append.
  for (const name of ['.eslintignore', '.prettierignore'] as const) {
    const p = resolve(cwd, name);
    const r = appendLineIfMissing(p, TOOLING_EXCLUDE_LINE);
    if (r.appended) {
      result.written.push(name);
    } else if (r.existed) {
      result.skipped.push(name);
    }
    // r.existed === false → file missing, silent no-op
  }

  // tsconfig.json — warn-only (may have // comments; may use extends/composite/references).
  const tsconfigPath = resolve(cwd, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const raw = readFileSync(tsconfigPath, 'utf8');
    if (raw.includes(TOOLING_EXCLUDE_MARKER)) {
      result.skipped.push('tsconfig.json');
    } else {
      result.warned.push({
        target: 'tsconfig.json',
        snippet:
          'Add `".forge/worktrees"` to the `exclude` array (forge does not auto-edit JSON configs):\n\n```json\n{\n  "exclude": ["node_modules", ".forge/worktrees"]\n}\n```',
      });
    }
  }

  // vitest.config.{ts,js,mjs,cjs} — warn-only (TS/JS code, no safe AST mutation).
  for (const ext of VITEST_CONFIG_EXTS) {
    const name = `vitest.config.${ext}`;
    const p = resolve(cwd, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    if (raw.includes(TOOLING_EXCLUDE_MARKER)) {
      result.skipped.push(name);
    } else {
      result.warned.push({
        target: name,
        snippet:
          `Add \`'.forge/worktrees/**'\` to \`test.exclude\` in ${name} (forge does not auto-edit code configs):\n\n` +
          `\`\`\`ts\nexport default defineConfig({\n  test: {\n    exclude: ['node_modules', '.forge/worktrees/**'],\n  },\n});\n\`\`\``,
      });
    }
    break; // only one vitest.config.* should exist
  }

  return result;
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

function buildWarningsBody(
  unverified: string[],
  toolingWarnings: ToolingExcludeWarning[],
): string {
  const out: string[] = ['# forge init — manual follow-ups', ''];

  if (unverified.length > 0) {
    out.push(
      '## Unverified tooling probes',
      '',
      'These probes failed or were skipped during `forge init`. Resolve before running `forge orchestrate`.',
      '',
    );
    for (const key of unverified) out.push(`- [ ] \`${key}\``);
    out.push('');
  }

  if (toolingWarnings.length > 0) {
    out.push(
      '## Tooling-exclude entries needed',
      '',
      'forge worktrees live at `.forge/worktrees/`. The following config files exist but were not auto-edited (forge does not mutate JSON or TypeScript config files). Add the snippets below manually so lint/typecheck/test runs skip worktrees.',
      '',
    );
    for (const w of toolingWarnings) {
      out.push(`### ${w.target}`, '', w.snippet, '');
    }
  }

  return out.join('\n') + (out[out.length - 1] === '' ? '' : '\n');
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

  // 4) Tooling-exclude entries (FORGE-115 / P2.5-T19) — hybrid:
  //    append to flat-ignore files; warn-only for code configs.
  const tooling = appendToolingExcludes(opts.cwd);
  for (const f of tooling.written) written.push(f);
  for (const f of tooling.skipped) skipped.push(f);

  // 5) Init warnings sidecar — merges unverified tool probes + tooling-exclude warnings.
  let warningsPath: string | undefined;
  const unverified = opts.unverified ?? [];
  if (unverified.length > 0 || tooling.warned.length > 0) {
    const p = resolve(opts.cwd, '.forge/init-warnings.md');
    writeAtomic(p, buildWarningsBody(unverified, tooling.warned));
    warningsPath = p;
    written.push('.forge/init-warnings.md');
  }

  // 6) Cleanup staging dir.
  rmSync(stagingRoot, { recursive: true, force: true });

  // 7) Round-trip sanity-check: parse YAML through SettingsSchema.
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
