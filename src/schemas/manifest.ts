import { z } from 'zod';

// FORGE-158: `.forge/manifest.json` — forge's authoritative record of every byte
// it wrote into a project, written by `forge init` and refreshed by
// `forge upgrade`. `forge eject` reads it to reverse the install exactly.
//
// Why a manifest and not re-derivation at eject time: forge writes are not all
// recoverable from the post-install tree. "Remove a forge file" ≠ "restore
// pre-install state" — appending a block to a pre-existing .gitignore inserts a
// separator newline OUTSIDE the markers, and two different originals can produce
// byte-identical post-install files (see gitignore-block.ts). The manifest
// records the *how* (created vs appended, prior trailing-newline) so eject is
// byte-exact rather than best-effort.

export const MANIFEST_VERSION = 1;

const AgentKindEnum = z.enum(['claude', 'codex', 'gemini']);

// A forge-managed agent root file (CLAUDE.md / AGENTS.md / GEMINI.md).
// forgeCreated=true  → forge wrote the file (it did not pre-exist); eject deletes it.
// forgeCreated=false → forge only stamped its marker block onto a pre-existing,
//   user-owned file; eject strips the block and keeps the file.
const RootFileEntry = z.object({
  path: z.string().min(1),
  forgeCreated: z.boolean(),
});

// A flat-ignore / .gitignore file forge modified.
//   kind 'block' → .gitignore-style marker block (forge's full ignore block).
//   kind 'line'  → a single appended line (.eslintignore / .prettierignore).
// created            → forge created the file (delete it on eject).
// priorEndedWithNewline → the file's trailing-newline state BEFORE forge's write,
//   needed to remove the exact separator forge inserted (byte-exact reversal).
// line               → the exact appended line (kind 'line' only).
const IgnoreFileEntry = z.object({
  path: z.string().min(1),
  kind: z.enum(['block', 'line']),
  created: z.boolean(),
  priorEndedWithNewline: z.boolean(),
  line: z.string().optional(),
});

// An exact host-farm entry forge materialized (symlink on POSIX, copy on
// Windows). Recording the exact path + mode lets eject remove what was WRITTEN,
// covering version-drift orphans and copy-mode entries that a current-package
// re-enumeration (pruneHostFarm) would miss.
const FarmEntry = z.object({
  path: z.string().min(1),
  mode: z.enum(['symlink', 'copy']),
});

export const ForgeManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  forgeVersion: z.string().min(1),
  enabledHosts: z.array(AgentKindEnum),
  rootFiles: z.array(RootFileEntry),
  ignoreFiles: z.array(IgnoreFileEntry),
  farmEntries: z.array(FarmEntry),
  // Forge-written files under .forge/ (CONTEXT.md, .version, settings.yaml, ...).
  staticPaths: z.array(z.string().min(1)),
});

export type ForgeManifest = z.infer<typeof ForgeManifestSchema>;
export type ManifestRootFile = z.infer<typeof RootFileEntry>;
export type ManifestIgnoreFile = z.infer<typeof IgnoreFileEntry>;
export type ManifestFarmEntry = z.infer<typeof FarmEntry>;
