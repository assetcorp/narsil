import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globalSetup: ['./src/__tests__/setup/build-runners.ts'],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
  },
})
