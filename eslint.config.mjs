// @ts-check
import tseslint from 'typescript-eslint';

// Minimal, non-type-aware lint. Purpose: catch the class of issues `tsc` does
// NOT — the repo intentionally omits `noUnusedLocals`, so unused imports /
// variables and unreachable code slip through `npm run typecheck`. (See the
// dead `import { z }` that survived #262 and had to be caught by hand in #263.)
//
// All rules are WARNINGS by design: `npm run lint` exits 0 even with findings,
// so it is non-blocking — CI surfaces issues without gating merges. Promote a
// rule to 'error' (and add `--max-warnings 0`) later if/when the team wants it
// to gate.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.forge/**', 'examples/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.mjs'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // The core rule misfires on TS type positions; use the TS-aware version.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },
);
