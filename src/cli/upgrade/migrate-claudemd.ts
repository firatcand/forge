// FORGE-154 Phase C — one-shot legacy migration: v0.4 combined CLAUDE.md →
// v0.5 split layout (CLAUDE.md product-only with marker block + @.forge/CONTEXT.md
// import; .forge/CONTEXT.md materialized from bundled template).
//
// Strict heading-by-heading SHA-256 match against a pinned v0.4 fixture. On
// exact match → write .bak, trim CLAUDE.md, materialize .forge/CONTEXT.md,
// stamp .forge/.version, refresh .gitignore marker block. On any drift →
// exit 0, no writes, print manual recipe.
//
// Plan: plans/tasks/FORGE-154.plan.md
// Spec: spec/decisions/2026-05-21-claudemd-methodology-split.md §10
//
// Decisions (from /plan-task questions):
//   Q1 fixture source → git c6b19e9~1, rendered with {{PROJECT_NAME}} → 'forge'
//      (test/fixtures/legacy-claudemd.md)
//   Q2 headings to strip → 5 of the spec-plan's 6: drop ## Critical paths,
//      strip the rest (Branch strategy, Forge principles, Source of truth,
//      Skill ↔ verb contract, Ephemeral ADR workflow). ## Critical paths
//      stays in product CLAUDE.md as a CRITICAL.md pointer.
//   Q3 flag mutex → enforced at src/bin/forge.ts router

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { firstSymlinkedComponent } from '../../core/symlink-guard.ts';
import { SettingsSchema } from '../../schemas/index.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../registry.ts';
import { buildPrefixBlock, extractPrefixBlock } from './agent-root-files.ts';
import { applyGitignoreBlock } from './gitignore-block.ts';
import { renderContext } from './render-context.ts';
import { locateContextTemplate } from './template-loader.ts';
import { readBundledMethodologyVersion } from './version-check.ts';

const FORGE_REPO_URL = 'https://github.com/firatcand/forge';

/**
 * Methodology headings to strip from CLAUDE.md during migration. Each entry
 * must match the corresponding line in the v0.4 fixture verbatim (including
 * parentheticals). The migration SHA-matches each section's full block; any
 * drift bails clean.
 *
 * Decision (plan Q2): 5 headings. `## Critical paths` is NOT in this list —
 * v0.4 had it as a thin product pointer ("See CRITICAL.md"); the v0.5
 * CONTEXT.md has a sibling `## Critical paths convention` explaining the
 * framework convention. Both can coexist after migration.
 */
export const METHODOLOGY_HEADINGS: readonly string[] = [
  '## Branch strategy',
  '## Forge principles (auto-applied — see [Forge ETHOS.md](https://github.com/firatcand/forge/blob/main/ETHOS.md))',
  '## Source of truth',
  '## Skill ↔ verb contract',
  '## Ephemeral ADR workflow (v0.5 — not active in v0.4)',
] as const;

/**
 * SHA-256 of each methodology section's full block (heading line + body +
 * trailing whitespace through to the next `## ` boundary or EOF) in the
 * pinned v0.4 fixture at test/fixtures/legacy-claudemd.md.
 *
 * Regenerate after editing the fixture:
 *   node --import tsx scripts/extract-legacy-shas.mjs
 * and paste the output back into this constant.
 */
export const REFERENCE_SHAS: Readonly<Record<string, string>> = {
  '## Branch strategy':
    '76b49fd754948cc4995e1f02050543d4f8e43de2324c952ac56ee21c028f4446',
  '## Forge principles (auto-applied — see [Forge ETHOS.md](https://github.com/firatcand/forge/blob/main/ETHOS.md))':
    'b4151c6958d3dd4c3b522b2e900e7566b49fd6a6151b37fcf95c99c301875e55',
  '## Source of truth':
    '14456fc307f61f71305e798817eafa18bfd94db306b7a82a235d3986d9536e2b',
  '## Skill ↔ verb contract':
    '09d9ec375af1d88b34d4b8a7aa64182038a1823c602025b6185548c90de287f0',
  '## Ephemeral ADR workflow (v0.5 — not active in v0.4)':
    'f22614dde027120aa0f452605dd345791c989ae34a12be7a8ccf059d174972f3',
};

export interface MigrateOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
}

export interface MigrateResult {
  readonly exitCode: number;
  readonly filesChanged: readonly string[];
  readonly stderr: string;
}

interface ExtractedSection {
  /** Full block from heading line through the boundary (next `## ` or EOF). */
  readonly fullBlock: string;
  /** Character index of the heading line's first character in `content`. */
  readonly startIdx: number;
  /** Character index one past the last character of fullBlock. */
  readonly endIdx: number;
}

/**
 * Extract a methodology section from `content` by heading. Returns null if
 * the heading doesn't appear on its own line. The captured block runs from
 * the heading line through (and including) the trailing whitespace up to —
 * but not including — the next `\n## ` line OR end-of-file.
 *
 * Deterministic: same input ⇒ same output bytes ⇒ same SHA-256.
 */
export function extractSection(content: string, heading: string): ExtractedSection | null {
  let startIdx: number;
  if (content.startsWith(`${heading}\n`)) {
    startIdx = 0;
  } else {
    const marker = `\n${heading}\n`;
    const i = content.indexOf(marker);
    if (i === -1) return null;
    startIdx = i + 1; // skip the leading \n; startIdx now points at first char of heading
  }

  // Find next `\n## ` boundary AFTER this heading line.
  const after = startIdx + heading.length + 1; // past `heading\n`
  const nextBoundary = content.indexOf('\n## ', after);
  const endIdx = nextBoundary === -1 ? content.length : nextBoundary + 1;

  return {
    fullBlock: content.slice(startIdx, endIdx),
    startIdx,
    endIdx,
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function manualRecipe(): string {
  const headings = METHODOLOGY_HEADINGS.join('\n    - ');
  return [
    '',
    'Manual migration recipe:',
    '  1. Save your current CLAUDE.md to CLAUDE.md.pre-migration.bak',
    '  2. Remove these sections from CLAUDE.md:',
    `    - ${headings}`,
    '  3. Add the Forge prefix block at the top of CLAUDE.md (see',
    '     spec/decisions/2026-05-21-claudemd-methodology-split.md §5).',
    '  4. Run `forge upgrade` to materialize .forge/CONTEXT.md.',
  ].join('\n');
}

/**
 * Remove all 5 methodology sections from `content`. Each section is located
 * fresh on each iteration (positions shift as preceding sections are removed).
 *
 * Deliberately does NOT collapse `\n{3,}` runs across the document — the
 * spec's "preserve product content verbatim" guarantee means we must not
 * touch whitespace inside product-owned sections (codex review caught the
 * earlier global-collapse as a verbatim-guarantee violation).
 *
 * Each `extractSection.fullBlock` captures from the heading line through
 * (but not including) the next `\n## ` boundary or EOF, so the trailing
 * blank line of a deleted section is removed with the section. The result
 * has exactly one blank line between any two surviving adjacent sections —
 * no `\n\n\n` accumulation needs cleanup in the canonical v0.4 fixture
 * deletion pattern.
 */
function stripMethodologySections(content: string): string {
  let trimmed = content;
  for (const heading of METHODOLOGY_HEADINGS) {
    const sec = extractSection(trimmed, heading);
    if (!sec) continue; // SHA check ran before this; safe to skip
    trimmed = trimmed.slice(0, sec.startIdx) + trimmed.slice(sec.endIdx);
  }
  return trimmed;
}

export async function migrateClaudemd(opts: MigrateOptions): Promise<MigrateResult> {
  const cwd = opts.cwd;
  const claudePath = resolve(cwd, 'CLAUDE.md');
  const bakPath = `${claudePath}.pre-migration.bak`;
  const contextPath = resolve(cwd, '.forge/CONTEXT.md');
  const versionPath = resolve(cwd, '.forge/.version');
  const settingsPath = resolve(cwd, '.forge/settings.yaml');
  const gitignorePath = resolve(cwd, '.gitignore');

  // Precondition 0 (FORGE-160): refuse UPFRONT when `.forge` itself (or a parent
  // component of it) is a symbolic link — BEFORE any read/mutation. The leaf
  // checks below (settings.yaml, CONTEXT.md, .version) all pass when `.forge` is
  // a symlinked directory (the leaves are real files under the link), then the
  // mkdirSync(.forge) + writeAtomic(CONTEXT.md/.version) below write THROUGH the
  // link, escaping the working tree. Refusing here keeps the refusal idempotent
  // (exit 1, nothing written, link intact). Consistent with the leaf refusals.
  const forgeLink = firstSymlinkedComponent(cwd, '.forge');
  if (forgeLink !== null) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr:
        'forge upgrade --migrate-claudemd: .forge is a symbolic link. Refusing migration — destructive writes through symlinks could mutate files outside the working tree. Resolve the symlink or replace with a regular directory first.',
    };
  }

  // Precondition 1: CLAUDE.md must exist and must NOT be a symlink.
  // Symlink refusal is a defense for adopters who fetched a malicious repo —
  // a symlinked CLAUDE.md could redirect destructive writes outside the
  // working tree (security review M1). lstatSync, not statSync — we need
  // the symlink's own metadata, not the target's.
  if (!existsSync(claudePath)) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: 'forge upgrade --migrate-claudemd: no CLAUDE.md found in cwd.',
    };
  }
  if (lstatSync(claudePath).isSymbolicLink()) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: 'forge upgrade --migrate-claudemd: CLAUDE.md is a symbolic link. Refusing migration — destructive writes through symlinks could mutate files outside the working tree. Resolve the symlink or replace with a regular file first.',
    };
  }

  // Precondition 2: settings.yaml must exist + parse (spec §9 exit 3).
  // Same lstatSync symlink guard as CLAUDE.md (security review M2).
  if (!existsSync(settingsPath)) {
    return {
      exitCode: 3,
      filesChanged: [],
      stderr: 'forge upgrade --migrate-claudemd: .forge/settings.yaml not found. Run `forge init` first.',
    };
  }
  if (lstatSync(settingsPath).isSymbolicLink()) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: 'forge upgrade --migrate-claudemd: .forge/settings.yaml is a symbolic link. Refusing migration. Resolve the symlink or replace with a regular file first.',
    };
  }

  // Precondition 2b (FORGE-208): extend the M1/M2 symlink preflight to EVERY
  // other path this migration writes — .forge/CONTEXT.md, .forge/.version,
  // .gitignore — BEFORE any write (including the .bak). Without this, a
  // symlink at any of them would surface as a mid-migration FsWriteError from
  // writeAtomic AFTER the .bak (and possibly CONTEXT.md) already landed,
  // leaving a partial migration. lstatSync via try (paths may not exist yet —
  // absent is fine, those are migration outputs).
  for (const [rel, abs] of [
    ['.forge/CONTEXT.md', contextPath],
    ['.forge/.version', versionPath],
    ['.gitignore', gitignorePath],
  ] as const) {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      // absent — fine
    }
    if (st?.isSymbolicLink()) {
      return {
        exitCode: 1,
        filesChanged: [],
        stderr: `forge upgrade --migrate-claudemd: ${rel} is a symbolic link. Refusing migration — destructive writes through symlinks could mutate files outside the working tree. Resolve the symlink or replace with a regular file first.`,
      };
    }
  }
  try {
    const raw = yamlParse(readFileSync(settingsPath, 'utf8')) as unknown;
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const path = firstIssue?.path.join('.') ?? '(root)';
      return {
        exitCode: 3,
        filesChanged: [],
        stderr: `forge upgrade --migrate-claudemd: invalid .forge/settings.yaml — ${path}: ${firstIssue?.message ?? 'schema validation failed'}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 3,
      filesChanged: [],
      stderr: `forge upgrade --migrate-claudemd: failed to parse .forge/settings.yaml — ${msg}`,
    };
  }

  const original = readFileSync(claudePath, 'utf8');

  // Precondition 3: refuse if CLAUDE.md is already in v0.5 shape (has the
  // Forge marker block at top). This replaces the earlier
  // "refuse if .forge/CONTEXT.md exists" check (codex review caught that
  // the older check made partial-crash states unrecoverable — between
  // CONTEXT.md write and CLAUDE.md trim, the legacy CLAUDE.md would refuse
  // re-migration even though it still needed trimming).
  //
  // The marker block check is the right signal: it's only ever written by
  // a successful migration or `forge upgrade --add-agent claude`. A v0.4
  // CLAUDE.md never has it. A partially-crashed migration (CONTEXT.md
  // written but CLAUDE.md not yet trimmed) STILL has no marker — so we
  // re-run cleanly, overwriting CONTEXT.md with the same bundled content.
  if (extractPrefixBlock(original) !== null) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: 'forge upgrade --migrate-claudemd: CLAUDE.md already contains a Forge marker block. Migration is one-shot; this repo appears to already be migrated.',
    };
  }

  // Strict-match each methodology section. Any miss or SHA drift → bail clean.
  for (const heading of METHODOLOGY_HEADINGS) {
    const sec = extractSection(original, heading);
    if (!sec) {
      return {
        exitCode: 0,
        filesChanged: [],
        stderr: `forge upgrade --migrate-claudemd: heading "${heading}" not found in CLAUDE.md. Bailing cleanly.${manualRecipe()}`,
      };
    }
    const expected = REFERENCE_SHAS[heading];
    if (!expected) {
      return {
        exitCode: 1,
        filesChanged: [],
        stderr: `forge upgrade --migrate-claudemd: internal error — no reference SHA registered for "${heading}". Regenerate via scripts/extract-legacy-shas.mjs.`,
      };
    }
    const actual = sha256(sec.fullBlock);
    if (actual !== expected) {
      return {
        exitCode: 0,
        filesChanged: [],
        stderr: `forge upgrade --migrate-claudemd: section "${heading}" has drifted from the v0.4 reference (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Bailing cleanly.${manualRecipe()}`,
      };
    }
  }

  // Strict-match passed. Build new CLAUDE.md.
  const trimmed = stripMethodologySections(original);
  const prefix = buildPrefixBlock('claude', { repoUrl: FORGE_REPO_URL });
  const newClaude = `${prefix}\n${trimmed.replace(/^\n+/, '')}`;

  // Render desired .forge/CONTEXT.md.
  const template = locateContextTemplate();
  const bundledVersion = readBundledMethodologyVersion();
  const renderedContext = renderContext(template, {
    version: bundledVersion,
    verbs: CLI_VERBS,
    slashCommands: SLASH_COMMANDS,
  });

  const changed: string[] = [];

  if (opts.dryRun) {
    // Dry-run: report what would change without touching disk.
    const wouldChange = [
      'CLAUDE.md.pre-migration.bak',
      '.forge/CONTEXT.md',
      'CLAUDE.md',
      '.forge/.version',
    ];
    const currentGi = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (applyGitignoreBlock(currentGi) !== currentGi) wouldChange.push('.gitignore');
    return {
      exitCode: 0,
      filesChanged: wouldChange,
      stderr: `forge upgrade --migrate-claudemd (--dry-run): would write:\n  - ${wouldChange.join('\n  - ')}`,
    };
  }

  // Write order (atomicity per Phase B Codex round-1 lesson + plan §"Why this
  // write order"):
  //   1. .bak first — defensive snapshot. Plain writeFileSync (matches
  //      upgrade.ts convention at line 361 for .pre-removal.bak).
  //   2. mkdir .forge.
  //   3. writeAtomic .forge/CONTEXT.md — if this fails, CLAUDE.md untouched.
  //   4. writeAtomic CLAUDE.md trim — last destructive write to user file.
  //   5. writeAtomic .forge/.version — stamps the methodology version so the
  //      drift-warning pre-hook doesn't fire on next CLI invocation.
  //   6. .gitignore block — independent, recoverable by re-running upgrade.
  //
  // Re-run safety after partial crash (codex review IMPROVEMENT):
  //   - Killed between 1 and 3: `.bak` exists with original content; CLAUDE.md
  //     untouched. Re-running --migrate-claudemd: the marker-block check sees
  //     no marker → proceeds; .bak gets overwritten with the same original
  //     content (safe — CLAUDE.md is still legacy v0.4 shape).
  //   - Killed between 3 and 4: CONTEXT.md exists with bundled content;
  //     CLAUDE.md still legacy. Re-running --migrate-claudemd: marker-block
  //     check passes (no marker yet) → proceeds; CONTEXT.md gets re-written
  //     with the same bundled content (idempotent).
  //   - Killed after 4: CLAUDE.md has marker block. Re-running
  //     --migrate-claudemd: marker-block check refuses with "already
  //     migrated"; plain `forge upgrade` completes any remaining steps
  //     (.version stamp + .gitignore block refresh) via its normal flow.
  writeFileSync(bakPath, original);
  changed.push('CLAUDE.md.pre-migration.bak');

  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeAtomic(contextPath, renderedContext);
  changed.push('.forge/CONTEXT.md');

  writeAtomic(claudePath, newClaude);
  changed.push('CLAUDE.md');

  writeAtomic(versionPath, `${bundledVersion}\n`);
  changed.push('.forge/.version');

  const currentGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const desiredGitignore = applyGitignoreBlock(currentGitignore);
  if (desiredGitignore !== currentGitignore) {
    writeAtomic(gitignorePath, desiredGitignore);
    changed.push('.gitignore');
  }

  return {
    exitCode: 0,
    filesChanged: changed,
    stderr: [
      'forge upgrade --migrate-claudemd: migrated CLAUDE.md → split layout.',
      '  Original saved to CLAUDE.md.pre-migration.bak (gitignored once `/.bak` lands in .gitignore).',
      '  Tracked (commit these):  CLAUDE.md, .gitignore',
      '  Gitignored (do NOT commit; regenerated per dev by `forge upgrade`):  .forge/CONTEXT.md, .forge/.version',
      '  Other devs run `forge upgrade` after pulling to materialize their own .forge/CONTEXT.md + .forge/.version.',
    ].join('\n'),
  };
}
