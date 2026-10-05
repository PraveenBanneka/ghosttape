import { defineConfig } from 'vitest/config';

export default defineConfig({
  // limits.jsonc lives in the repo root (owner-only), one level above this app
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    // two pages: the terminal and the "why patterns appear in noise" explainer (paths relative to web/)
    rollupOptions: { input: { main: 'index.html', learn: 'learn.html' } },
  },
  test: { include: ['test/**/*.test.ts'] },
});
