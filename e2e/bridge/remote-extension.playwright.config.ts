import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const evidenceDirectory = process.env.MOTRIX_REMOTE_EXTENSION_EVIDENCE_DIR

export default defineConfig({
  testDir: '.',
  testMatch: /remote-extension(?:-firefox)?-wss\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter:
    evidenceDirectory === undefined
      ? [['list']]
      : [
          ['list'],
          [
            'json',
            { outputFile: join(evidenceDirectory, 'playwright-report.json') },
          ],
        ],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: '../test-results/remote-extension',
})
