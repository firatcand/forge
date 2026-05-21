// FORGE-152: re-export the upgrade module surface.
//
// Phase A ships render-context only (consumed by scripts/forge-render-context.mjs
// and by src/cli/init/scaffold.ts). Phase B will add agent-root-files,
// gitignore-block, version-check, and the upgrade verb entry point here.

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
