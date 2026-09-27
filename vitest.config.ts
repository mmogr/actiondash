import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A focused test fails the run rather than quietly skipping the rest.
    allowOnly: false,
  },
})
