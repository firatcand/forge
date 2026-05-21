// Re-export the upgrade module surface. FORGE-152 (Phase A) shipped
// render-context, agent-root-files, and gitignore-block. FORGE-153 (Phase B)
// adds version-check and the upgrade verb entry point.

export { renderContext } from './render-context.ts';
export type { RenderContextInput } from './render-context.ts';

export {
  buildPrefixBlock,
  replacePrefixBlock,
  extractPrefixBlock,
  bodyWithoutPrefixBlock,
  ROOT_FILE_BY_AGENT,
} from './agent-root-files.ts';
export type { AgentKind, PrefixBlockInput } from './agent-root-files.ts';

export { applyGitignoreBlock, hasGitignoreBlock } from './gitignore-block.ts';

export {
  checkVersionDrift,
  formatDriftWarning,
  compareVersions,
  formatCliTooOldRefusal,
  readBundledMethodologyVersion,
} from './version-check.ts';
export type {
  DriftInfo,
  CheckVersionDriftInput,
  VersionComparison,
} from './version-check.ts';

export { upgrade } from './upgrade.ts';
export type { UpgradeOptions, UpgradeResult } from './upgrade.ts';
