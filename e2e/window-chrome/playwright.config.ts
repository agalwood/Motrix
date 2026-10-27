import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  outputDir: '../../output/playwright/test-results/window-chrome',
  use: {
    baseURL: 'http://127.0.0.1:4186',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    launchOptions: process.env.MOTRIX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MOTRIX_BROWSER_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: 'pnpm exec vite --config e2e/window-chrome/vite.config.ts',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4186',
    reuseExistingServer: !process.env.CI,
  },
})
