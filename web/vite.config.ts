import { defineConfig } from 'vitest/config';

export default defineConfig({
  // limits.jsonc lives in the repo root (owner-only), one level above this app
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
  test: { include: ['test/**/*.test.ts'] },
});
