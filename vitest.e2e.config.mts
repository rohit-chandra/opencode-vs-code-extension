import { defineConfig } from 'vitest/config';

// End-to-end tests start real processes (opencode, claude, codex, mock servers), so they run serially.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
