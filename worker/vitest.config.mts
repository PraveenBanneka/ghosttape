import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the relay's pure logic (HMAC, line rules, seq rules, limits). Run from the repo root:
//   npm run worker:test
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
