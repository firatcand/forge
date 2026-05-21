// Shared bundled-template resolver. Used by upgrade.ts and migrate-claudemd.ts
// to locate templates/CONTEXT.template.md whether running from src/ via tsx
// (dev) or from dist/ (bundled). Extracted from upgrade.ts (FORGE-153) so the
// migration verb can share the path-search logic without creating a circular
// import.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function locateContextTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/cli/upgrade/ → ../../../templates/. Bundled: dist/ → ../templates/.
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(
      here,
      ...(Array(i).fill('..') as string[]),
      'templates',
      'CONTEXT.template.md',
    );
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('forge upgrade: templates/CONTEXT.template.md not found in bundle');
}
