import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  retries: 0,
  outputDir: '../../output/playwright/test-results/server-torrent',
  use: {
    viewport: { width: 1024, height: 768 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
