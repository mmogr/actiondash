import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests, run against the production build with its real Content
 * Security Policy, served by vite preview. GitHub is scripted per test in
 * e2e/github.ts; nothing here reaches the network.
 *
 * E2E_DIST and E2E_PORT let scripts/check-guards.mjs point the same tests at
 * a deliberately broken copy of the build without disturbing a normal run.
 */

const DIST = process.env.E2E_DIST ?? 'dist'
const PORT = Number(process.env.E2E_PORT ?? 4180)
const BASE_URL = `http://127.0.0.1:${PORT}/`

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // A focused test turns the run green without running the rest, and a retry
  // turns a flaky one green without anyone deciding it was fine.
  forbidOnly: true,
  retries: 0,
  fullyParallel: true,
  timeout: 15_000,
  globalTimeout: 10 * 60_000,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-GB',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'allow',
    // The point of running the build: the policy applies as it does for users.
    bypassCSP: false,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx --no-install vite preview --outDir ${JSON.stringify(DIST)} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Never someone's leftover server, which could be serving an older build.
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: 'tripwires/**' },
    // Narrowed by file rather than by skipping inside tests: skips are banned.
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: ['smoke.spec.ts', 'dashboard-states.spec.ts'] },
    // Tests written to fail, so check-guards can prove each guard trips.
    ...(process.env.E2E_TRIPWIRES ? [{ name: 'tripwires', testMatch: 'tripwires/**/*.spec.ts' }] : []),
  ],
})
