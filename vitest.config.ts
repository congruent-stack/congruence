import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/server/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/web/vite.test.ts'],
    testTimeout: 15000,
  },
});
