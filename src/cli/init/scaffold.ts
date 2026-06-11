import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { SettingsSchema } from '../../schemas/index.ts';
import type { ForgeManifest, ManifestFarmEntry } from '../../schemas/index.ts';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { FsWriteError } from '../../core/errors.ts';
import {
  buildManifest,
  farmEntriesFromResult,
  writeManifest,
  MANIFEST_RELPATH,
} from '../manifest.ts';
import type { InitAnswers } from './prompts.ts';
import { renderTemplate, resolveTemplatesDir, type TemplateVars } from './templates.ts';
// FORGE-152: integration points for the new CLAUDE.md split layout.
// FORGE-156: per-host skill+agent farm materialized at init time.
import {
  renderContext,
  ROOT_FILE_BY_AGENT,
  applyGitignoreBlock,
  applySkillFarm,
  locatePackageRoot,
  type AgentKind,
} from '../upgrade/index.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../registry.ts';

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
  // FORGE-158: flat-ignore lines forge actually appended this run, with enough
  // detail for `forge eject` to reverse them byte-exactly.
  appendedLines: { name: string; line: string; priorEndedWithNewline: boolean }[];
}

const STAGING_DIR = '.forge/.init-staging';

/**
 * Read forge's own package.json version. Used to stamp .forge/.version at
 * init time so Phase B's drift-warning pre-hook can compare the on-disk
 * methodology version against the installed CLI's bundled version.
 *
 * Walks up from this module file to find package.json. Works in both dev
 * (src/cli/init/scaffold.ts → ../../../package.json) and after bundling
 * (dist/* relative paths) because tsdown preserves __dirname semantics.
 */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up to 5 levels to find package.json. In dev: src/cli/init/ → repo root
  // is 3 levels. In bundled dist: dist/ → repo root is 1 level. Loop up to 5
  // to be tolerant of either layout without baking in a brittle relative path.
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(here, ...Array(i).fill('..'), 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    }
  }
  throw new Error(
    'forge init: could not resolve forge package.json to stamp .forge/.version',
  );
}

// Exclude entry for flat-ignore files (.eslintignore, .prettierignore).
const TOOLING_EXCLUDE_LINE = '.forge/worktrees/';
// Marker for substring detection in JSON/TS configs (warn-only targets).
const TOOLING_EXCLUDE_MARKER = '.forge/worktrees';
const VITEST_CONFIG_EXTS = ['ts', 'js', 'mjs', 'cjs'] as const;
// Configs read by appendToolingExcludes are user-controlled. Cap their size so a
// symlink to /dev/zero or a pathological generated config can't stall init.
// 1 MiB is ~3 orders of magnitude above the largest legitimate tsconfig/.ignore.
const MAX_CONFIG_BYTES = 1_048_576;

/**
 * Read a text file, returning null when the file is unreadable for any reason:
 *   - doesn't exist (ENOENT)
 *   - is a directory rather than a file (EISDIR — possible if `cwd/.eslintignore`
 *     etc. is a directory in the adopter's project, weird but legal)
 *   - is a broken symlink or a symlink loop (ELOOP)
 *   - we don't have permission to read it (EACCES)
 *   - exceeds MAX_CONFIG_BYTES (defends against /dev/zero symlinks or generated
 *     configs that would OOM/hang the init read)
 *
 * Errors from optional tooling probes shouldn't abort `forge init` — the worst
 * case for an unreadable file is "no tooling-exclude entry was scaffolded for it",
 * which the user can fix manually.
 *
 * Race-safe: a stat-then-read pattern would leak raw ENOENT if the file disappears
 * between the two syscalls (see docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md).
 * We catch errors at both syscall boundaries.
 *
 * The size cap fires before the read but is advisory under a TOCTOU window: a
 * file growing past the cap between statSync and readFileSync would bypass it.
 * Tightening this would require openSync+fstatSync+bounded-read; deferred —
 * the threat model (local adversary racing forge init) isn't worth the complexity.
 */
function safeReadConfig(filePath: string): string | null {
  const isFsError = (e: unknown, code: string): boolean =>
    e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === code;
  const isUnreadable = (e: unknown): boolean =>
    isFsError(e, 'ENOENT') ||
    isFsError(e, 'EISDIR') ||
    isFsError(e, 'ELOOP') ||
    isFsError(e, 'EACCES');

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (e) {
    if (isUnreadable(e)) return null;
    throw e;
  }
  if (size > MAX_CONFIG_BYTES) return null;
  try {
    return readFileSync(filePath, 'utf8');
  } catch (e) {
    if (isUnreadable(e)) return null;
    throw e;
  }
}

/** FORGE-208: true when the path itself is a symbolic link (lstat — the
 * link's own type). False when absent or a regular file/dir. */
function isSymlinkAt(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

interface Artifact {
  // Path relative to cwd.
  relPath: string;
  contents: string;
  // True if this artefact must be written even if the destination exists (settings.yaml is the marker file).
  mustOverwrite?: boolean;
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
    enabled_root_files: answers.agents.enabled_root_files,
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


/**
 * Append `line` to `filePath` if the file exists and doesn't already contain
 * that exact line. Returns the outcome:
 *   - `existed: false` → file missing or over MAX_CONFIG_BYTES (treated as no-op)
 *   - `existed: true, appended: false` → file existed, line already present (skipped)
 *   - `existed: true, appended: true` → file existed, line was appended (written)
 *
 * Idempotent under CRLF line endings: a file checked out on Windows or with
 * autocrlf=true contains `\r\n` separators, so a naive `split('\n')` would
 * leave `\r` on each entry and miss the match — we normalize before splitting
 * but preserve the original byte sequence when writing the appended line.
 */
export function appendLineIfMissing(
  filePath: string,
  line: string,
): { existed: boolean; appended: boolean; priorEndedWithNewline: boolean } {
  const content = safeReadConfig(filePath);
  if (content === null) {
    return { existed: false, appended: false, priorEndedWithNewline: false };
  }
  const priorEndedWithNewline = content.length === 0 || content.endsWith('\n');
  // Exact-line match against newline-split entries — avoids false positives from
  // substring matches (e.g. a comment that mentions the path). CRLF-normalized
  // so Windows-style files don't double-append on re-run.
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.includes(line)) {
    return { existed: true, appended: false, priorEndedWithNewline };
  }
  const sep = priorEndedWithNewline ? '' : '\n';
  writeAtomic(filePath, content + sep + line + '\n');
  return { existed: true, appended: true, priorEndedWithNewline };
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
  const result: ToolingExcludeResult = { written: [], skipped: [], warned: [], appendedLines: [] };

  // Flat-ignore files — safe to append.
  for (const name of ['.eslintignore', '.prettierignore'] as const) {
    const p = resolve(cwd, name);
    // FORGE-208: a symlinked ignore file makes writeAtomic refuse (rewriting
    // it would destroy the link). Skip with a warning into the init-warnings
    // surface instead of aborting init.
    let r;
    try {
      r = appendLineIfMissing(p, TOOLING_EXCLUDE_LINE);
    } catch (err) {
      if (err instanceof FsWriteError && err.code === 'SYMLINK_TARGET_REFUSED') {
        result.skipped.push(name);
        result.warned.push({
          target: name,
          snippet: `${name} is a symbolic link, so forge did not append the worktree exclude (writing through the link would destroy it). Add this line to the link's target manually:\n\n\`\`\`\n${TOOLING_EXCLUDE_LINE}\n\`\`\``,
        });
        continue;
      }
      throw err;
    }
    if (r.appended) {
      result.written.push(name);
      result.appendedLines.push({
        name,
        line: TOOLING_EXCLUDE_LINE,
        priorEndedWithNewline: r.priorEndedWithNewline,
      });
    } else if (r.existed) {
      result.skipped.push(name);
    }
    // r.existed === false → file missing, silent no-op
  }

  // tsconfig.json — warn-only (may have // comments; may use extends/composite/references).
  // Marker check is a plain substring lookup — false-positive if the user has
  // `.forge/worktrees` mentioned in a // comment but not in the exclude array.
  // Acceptable: a false positive merely suppresses the warning (worst case: user
  // doesn't get a snippet they didn't need). A false negative produces a snippet
  // they should already have followed. Neither corrupts state.
  const tsconfigPath = resolve(cwd, 'tsconfig.json');
  const tsconfigRaw = safeReadConfig(tsconfigPath);
  if (tsconfigRaw !== null) {
    if (tsconfigRaw.includes(TOOLING_EXCLUDE_MARKER)) {
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
  // Same false-positive caveat as tsconfig above; impact is identical.
  for (const ext of VITEST_CONFIG_EXTS) {
    const name = `vitest.config.${ext}`;
    const raw = safeReadConfig(resolve(cwd, name));
    if (raw === null) continue;
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

const TEMPLATE_BY_AGENT: Readonly<Record<AgentKind, string>> = {
  claude: 'CLAUDE.project.template.md',
  codex: 'AGENTS.project.template.md',
  gemini: 'GEMINI.project.template.md',
} as const;

// Seed contents for .forge/.env. forge loads only the allowlisted tracker-auth
// keys from this file (see src/core/forge-env.ts); everything else is ignored.
const FORGE_ENV_PLACEHOLDER = [
  '# forge tracker credentials — git-ignored, never commit this file.',
  '# forge loads only these keys (already-set shell/CI vars win):',
  '#   LINEAR_API_KEY, NOTION_TOKEN, GITHUB_TOKEN, GH_TOKEN, FORGE_NOTION_PARENT_PAGE_ID',
  '#',
  '# LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxx',
  '',
].join('\n');

function buildArtifacts(opts: ScaffoldOptions, vars: TemplateVars): Artifact[] {
  const templatesDir = opts.templatesDir ?? resolveTemplatesDir();
  const yamlContent = yamlStringify(toMinimalYamlObject(opts.answers), { lineWidth: 0 });

  const briefRaw = renderTemplate(templatesDir, 'BRIEF.template.md', vars);
  const brief = injectBriefGoal(briefRaw, opts.answers.goal);

  // FORGE-152: one root file per enabled agent. CLAUDE.md only when 'claude'
  // is enabled, AGENTS.md only when 'codex', etc. Per-agent prefix marker
  // block comes from each template (which matches buildPrefixBlock byte-for-
  // byte — enforced by drift-gate tests in agent-root-files.test.ts).
  const rootFileArtifacts: Artifact[] = opts.answers.agents.enabled_root_files.map(
    (agent) => ({
      relPath: ROOT_FILE_BY_AGENT[agent],
      contents: renderTemplate(templatesDir, TEMPLATE_BY_AGENT[agent], vars),
    }),
  );

  // FORGE-152: render .forge/CONTEXT.md from the methodology template +
  // CLI registry. Gitignored after this commit (the marker block in
  // .gitignore added below covers it), but materializes at init so the
  // first session has the methodology immediately. Phase B's forge upgrade
  // will use the same renderContext to refresh it.
  const contextTemplate = readFileSync(
    resolve(templatesDir, 'CONTEXT.template.md'),
    'utf8',
  );
  const methodologyVersion = readPackageVersion();
  const renderedContext = renderContext(contextTemplate, {
    version: methodologyVersion,
    verbs: CLI_VERBS,
    slashCommands: SLASH_COMMANDS,
  });

  const artefacts: Artifact[] = [
    { relPath: 'spec/BRIEF.md', contents: brief },
    { relPath: 'spec/PRD.md', contents: renderTemplate(templatesDir, 'PRD.template.md', vars) },
    { relPath: 'spec/SPEC.md', contents: renderTemplate(templatesDir, 'SPEC.template.md', vars) },
    { relPath: 'spec/DESIGN.md', contents: renderTemplate(templatesDir, 'DESIGN.template.md', vars) },
    { relPath: 'CRITICAL.md', contents: renderTemplate(templatesDir, 'CRITICAL.template.md', vars) },
    ...rootFileArtifacts,
    { relPath: 'plans/tasks/.gitkeep', contents: '' },
    { relPath: '.forge/CONTEXT.md', contents: renderedContext },
    { relPath: '.forge/.version', contents: `${methodologyVersion}\n` },
    // Per-repo tracker credentials. Git-ignored by the .forge/* block below;
    // no mustOverwrite, so re-running init / forge upgrade never clobbers a
    // user's real key (the promote loop skips existing files). Only the keys
    // in TRACKER_ENV_ALLOWLIST (src/core/forge-env.ts) are actually loaded.
    { relPath: '.forge/.env', contents: FORGE_ENV_PLACEHOLDER },
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
  // FORGE-208: warnings accumulated by the promotion loop + .gitignore step,
  // merged into the init-warnings surface (tooling.warned) below.
  const symlinkWarnings: ToolingExcludeWarning[] = [];
  // Settings yaml MUST be last — it's the marker file that proves init succeeded.
  const ordered = [
    ...artefacts.filter((a) => a.relPath !== '.forge/settings.yaml'),
    ...artefacts.filter((a) => a.relPath === '.forge/settings.yaml'),
  ];
  for (const a of ordered) {
    const dest = resolve(opts.cwd, a.relPath);
    // FORGE-208: the staged rmSync+renameSync below bypasses writeAtomic, so
    // it needs its own guard — a symlinked dest must be SKIPPED, never
    // unlinked (rmSync would delete the link; renameSync over it would
    // replace the link with a regular file — the same class of bug
    // writeAtomic's preflight refuses). lstat: the link's own type, so a
    // dangling symlink (existsSync false) is also caught.
    if (isSymlinkAt(dest)) {
      skipped.push(a.relPath);
      symlinkWarnings.push({
        target: a.relPath,
        snippet: `${a.relPath} is a symbolic link, so forge left it untouched (replacing it would destroy the link). Resolve the symlink or replace it with a regular file, then re-run \`forge init\` / \`forge upgrade\` if you want forge to manage it.`,
      });
      continue;
    }
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

  // 3) .gitignore marker block (FORGE-152: ignore .forge/* except settings.yaml).
  // Shared with Phase B's forge upgrade — both call applyGitignoreBlock so the
  // block is byte-identical regardless of which path wrote it.
  const giPath = resolve(opts.cwd, '.gitignore');
  // `created` must mean "forge made the file", not "the file was empty" — a user
  // can own an empty .gitignore, and eject must not delete it (Codex impl #1).
  const giExisted = existsSync(giPath);
  const existingGi = giExisted ? readFileSync(giPath, 'utf8') : '';
  const newGi = applyGitignoreBlock(existingGi);
  // FORGE-158: manifest entries describing exactly what forge wrote, so eject
  // can reverse them byte-exactly.
  const ignoreFiles: ForgeManifest['ignoreFiles'] = [];
  if (newGi !== existingGi) {
    // FORGE-208: a symlinked .gitignore makes writeAtomic refuse — skip with
    // a warning into the init-warnings surface rather than aborting init.
    try {
      writeAtomic(giPath, newGi);
      written.push('.gitignore');
      ignoreFiles.push({
        path: '.gitignore',
        kind: 'block',
        created: !giExisted,
        priorEndedWithNewline: existingGi.endsWith('\n'),
      });
    } catch (err) {
      if (err instanceof FsWriteError && err.code === 'SYMLINK_TARGET_REFUSED') {
        skipped.push('.gitignore');
        symlinkWarnings.push({
          target: '.gitignore',
          snippet:
            '.gitignore is a symbolic link, so forge did not write its marker block (writing through the link would destroy it). Add the forge-managed block to the link\'s target manually, or replace the link with a regular file and re-run `forge upgrade`.',
        });
      } else {
        throw err;
      }
    }
  } else {
    skipped.push('.gitignore');
  }

  // 4) Tooling-exclude entries (FORGE-115 / P2.5-T19) — hybrid:
  //    append to flat-ignore files; warn-only for code configs.
  const tooling = appendToolingExcludes(opts.cwd);
  // FORGE-208: surface symlink skips from steps 2–3 in the same sidecar.
  tooling.warned.unshift(...symlinkWarnings);
  for (const f of tooling.written) written.push(f);
  for (const f of tooling.skipped) skipped.push(f);
  for (const a of tooling.appendedLines) {
    ignoreFiles.push({
      path: a.name,
      kind: 'line',
      created: false, // appendLineIfMissing only appends to pre-existing files
      priorEndedWithNewline: a.priorEndedWithNewline,
      line: a.line,
    });
  }

  // 4.5) Per-host skill + agent farm (FORGE-156). Materializes
  //      .claude/skills/ + .claude/agents/ (and same for codex/gemini if
  //      enabled) as symlinks (POSIX) or copies (Windows) into the bundled
  //      npm package. Without this, host-side slash commands and subagents
  //      don't resolve in a freshly-initialized project.
  let farmEntries: ManifestFarmEntry[] = [];
  try {
    const farm = applySkillFarm({
      cwd: opts.cwd,
      packageRoot: locatePackageRoot(),
      enabledAgents: opts.answers.agents.enabled_root_files,
    });
    for (const p of farm.created) {
      const rel = p.startsWith(`${opts.cwd}/`) ? p.slice(opts.cwd.length + 1) : p;
      written.push(rel);
    }
    // Refreshed entries are only possible if a prior init crashed mid-write;
    // surface them as `written` for the same reason — the user sees the path.
    for (const p of farm.refreshed) {
      const rel = p.startsWith(`${opts.cwd}/`) ? p.slice(opts.cwd.length + 1) : p;
      written.push(rel);
    }
    // FORGE-158: record exact farm entries (path + mode) for eject.
    farmEntries = farmEntriesFromResult(opts.cwd, farm);
  } catch (err) {
    // Farm materialization failure must not abort init — the rest of the
    // scaffold is correct. Surface a warning via the existing init-warnings
    // sidecar instead.
    tooling.warned.push({
      target: 'skill-farm',
      snippet: `Forge skill+agent farm could not be materialized: ${err instanceof Error ? err.message : String(err)}\n\nRun \`forge upgrade\` after init to retry. Without it, host-side slash commands (\`/forge\`, \`/pickup-task\`, ...) will not resolve in this project.`,
    });
  }

  // 5) Init warnings sidecar — merges unverified tool probes + tooling-exclude warnings.
  let warningsPath: string | undefined;
  const unverified = opts.unverified ?? [];
  if (unverified.length > 0 || tooling.warned.length > 0) {
    const p = resolve(opts.cwd, '.forge/init-warnings.md');
    // FORGE-208 classification: forge-owned sidecar under .forge/ — a symlink
    // here is exotic, so writeAtomic's FsWriteError propagates loudly (no
    // per-site handling by design).
    writeAtomic(p, buildWarningsBody(unverified, tooling.warned));
    warningsPath = p;
    written.push('.forge/init-warnings.md');
  }

  // 5.5) FORGE-158: write .forge/manifest.json — forge's record of what it
  //      wrote, so `forge eject` can reverse the install byte-exactly. Every
  //      root file forge wrote at init is forge-created (scaffold only writes
  //      when the file did not pre-exist).
  const enabledRootPaths = new Set(
    opts.answers.agents.enabled_root_files.map((a) => ROOT_FILE_BY_AGENT[a]),
  );
  const createdRootFiles = written.filter((p) => enabledRootPaths.has(p));
  const manifest = buildManifest({
    cwd: opts.cwd,
    forgeVersion: readPackageVersion(),
    enabledHosts: opts.answers.agents.enabled_root_files,
    createdRootFiles,
    ignoreFiles,
    farmEntries,
  });
  writeManifest(opts.cwd, manifest);
  written.push(MANIFEST_RELPATH);

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
