import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');
export const forgeBinEntry = resolve(repoRoot, 'src/bin/forge.ts');

// Walks up the filesystem from this file to find tsx in the main checkout's
// node_modules — works from worktrees under <main>/.forge/worktrees/<id>/
// where the worktree itself has no node_modules. See FORGE-122.
export const tsxBin: string = createRequire(import.meta.url).resolve('tsx/cli');
