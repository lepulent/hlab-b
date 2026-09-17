import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/policy/**/*.test.ts'],
    environment: 'node',
  },
});
