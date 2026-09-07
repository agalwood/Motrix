import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  // The distinct suffix keeps this Web suite out of the Electron config.
  testMatch: '**/*.browser.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  outputDir: '../test-results/web-directory-picker',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1024, height: 768 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.MOTRIX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MOTRIX_BROWSER_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: 'pnpm exec vite --config e2e/web-directory-picker/vite.config.ts',
    cwd: new URL('../..', import.meta.url).pathname,
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
