import { defineConfig } from '@playwright/test'

if (
  !process.env.MOTRIX_APPIMAGE_ARTIFACT ||
  !process.env.MOTRIX_EXTENSION_BUILD
) {
  throw new Error(
    'Set MOTRIX_APPIMAGE_ARTIFACT and MOTRIX_EXTENSION_BUILD to real builds'
  )
}

export default defineConfig({
  testDir: '.',
  testMatch: 'appimage-cold-launch.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  // Pairing passwords must not enter traces, screenshots or video.
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  outputDir: '../test-results/appimage',
})
