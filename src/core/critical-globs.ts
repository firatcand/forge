// Shared CRITICAL.md glob parser (FORGE-205: extracted from audit.ts so the
// `/audit` protected-set resolver AND the docs-coverage map share ONE parser —
// no drift between two copies of the markdown-token heuristic).
//
// CRITICAL.md is human MARKDOWN, so a line may be a bare glob, a list item
// (`- glob` / `* glob` / `+ glob`), a backtick-wrapped glob (`` `glob` ``), a
// header (`## ...`), or prose. We extract only GLOB-LIKE tokens: strip a leading
// list marker + surrounding backticks, then keep the token ONLY when it looks
// like a path/glob (contains `/` or `*`) AND has no inner whitespace (prose has
// spaces; a glob token does not). `#` lines and blanks are skipped. Missing file
// → empty list (not an error). (Codex cross-review NB2.)

import { readFileSync } from 'node:fs';
import path from 'node:path';

export function parseCriticalGlobs(repoRoot: string): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, 'CRITICAL.md'), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (const line of raw.split('\n')) {
    let t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    // Strip a leading markdown list marker (-, *, +) once.
    t = t.replace(/^[-*+]\s+/, '').trim();
    // Strip surrounding backticks (`glob`).
    t = t.replace(/^`+|`+$/g, '').trim();
    if (t.length === 0) continue;
    // Glob-like: a path/glob token (has `/` or `*`) with no inner whitespace.
    if (!/[/*]/.test(t)) continue; // prose / headings without a path
    if (/\s/.test(t)) continue; // prose sentence that happens to contain a slash
    globs.push(t);
  }
  return globs;
}
