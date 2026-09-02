import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['stet/tests/**/*.test.ts', 'stet/conformance/**/*.test.ts', 'stet/react/**/*.test.tsx'],
    exclude: ['**/*.live.test.ts'],
    setupFiles: ['./stet/tests/setup.offline.ts'],
  },
});
