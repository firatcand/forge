import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/bin/forge.ts', 'src/bin/sync-status-render.ts', 'src/index.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  target: 'es2022',
  clean: true,
  dts: false,
  shims: true,
});
