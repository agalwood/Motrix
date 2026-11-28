import path from 'node:path'
import { defineConfig } from '@playwright/test'

// Opt-in: runs against a real GNOME desktop and temporarily changes its button
// layout / GTK theme. The fixture restores both settings after every test.
export default defineConfig({
  testDir: '.',
  testMatch: '*.native.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: '../global-setup.ts',
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder: path.resolve(
          import.meta.dirname,
          '../../output/playwright/reports/window-chrome-native'
        ),
      },
    ],
  ],
  outputDir: '../../output/playwright/test-results/window-chrome-native',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
