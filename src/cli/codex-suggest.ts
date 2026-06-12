// FORGE-150: `forge codex-suggest` was renamed to `forge second-opinion suggest`.
// The implementation moved to second-opinion-suggest.ts; this module re-exports
// it under the legacy names so the deprecation alias in src/bin/forge.ts and any
// existing imports keep working. Removal in v0.5.
export {
  runSecondOpinionSuggest as runCodexSuggest,
  __TEST_ONLY,
  type RunSecondOpinionSuggestOptions as RunCodexSuggestOptions,
  type RunSecondOpinionSuggestResult as RunCodexSuggestResult,
} from './second-opinion-suggest.ts';
