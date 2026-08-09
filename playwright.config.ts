import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  // Electron app fixture launches a single Electron process per test —
  // running them in parallel would multi-instance Electron + aria2 and
  // require coordinated port allocation across workers. Keep it serial.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  // Most assertions wait for UI; allow a generous default since the
  // first launch also boots aria2 and runs settings migration.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'e2e/test-results',
})
