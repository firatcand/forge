// Re-export the upgrade module surface. FORGE-152 (Phase A) shipped
// render-context, agent-root-files, and gitignore-block. FORGE-153 (Phase B)
// added version-check and the upgrade verb entry point. FORGE-154 (Phase C)
// adds migrate-claudemd and the shared template-loader.

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

export {
  migrateClaudemd,
  METHODOLOGY_HEADINGS,
  REFERENCE_SHAS,
  extractSection,
} from './migrate-claudemd.ts';
export type { MigrateOptions, MigrateResult } from './migrate-claudemd.ts';

export { locateContextTemplate } from './template-loader.ts';

// FORGE-156: per-host project-local skill + agent farm.
export { applySkillFarm, locatePackageRoot, pruneHostFarm } from './skill-farm.ts';
export type { FarmMode, SkillFarmOptions, SkillFarmResult } from './skill-farm.ts';
