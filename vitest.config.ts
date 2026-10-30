import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'supabase/functions/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    globalSetup: ['tests/sql/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
