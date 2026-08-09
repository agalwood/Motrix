import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchMotrix, test } from './fixtures/electron-app'

async function openDisclaimer(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.url()).toContain('w=onboarding')
  return page
}

test.describe('disclaimer startup gate', () => {
  test('shows the disclaimer first and opens main only after persisted consent', async ({
    userDataDir,
    rpcPort,
  }) => {
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      disclaimerAccepted: false,
    })

    try {
      const disclaimer = await openDisclaimer(app)
      await expect(
        disclaimer.getByRole('heading', { name: 'Usage Notice' })
      ).toBeVisible()
      await expect(disclaimer.getByTestId('disclaimer-panel')).toBeVisible()

      const languageBounds = await disclaimer
        .getByTestId('onboarding-language')
        .boundingBox()
      expect(languageBounds).not.toBeNull()
      // macOS places the 14px traffic lights at y=20, so their centerline is 27.
      expect(
        (languageBounds?.y ?? 0) + (languageBounds?.height ?? 0) / 2
      ).toBeCloseTo(27, 1)

      expect(app.windows().some((page) => page.url().includes('w=main'))).toBe(
        false
      )

      const highlightedCopy = disclaimer.locator('[data-slot="blur-highlight"]')
      await expect(highlightedCopy).toHaveAttribute('data-in-view', 'true')

      const screenshotPath = process.env.MOTRIX_DISCLAIMER_SCREENSHOT
      if (screenshotPath) {
        await disclaimer.waitForTimeout(1_500)
        await disclaimer.screenshot({ path: screenshotPath, scale: 'css' })
      }

      const mainWindowPromise = app.waitForEvent('window')
      await disclaimer.getByTestId('disclaimer-agree').click()
      const main = await mainWindowPromise
      await main.waitForLoadState('domcontentloaded')
      await expect.poll(() => main.url()).toContain('w=main')

      const settings = JSON.parse(
        await readFile(path.join(userDataDir, 'settings.json'), 'utf8')
      ) as { onboarding?: { disclaimerAccepted?: boolean } }
      expect(settings.onboarding?.disclaimerAccepted).toBe(true)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('quits when the disclaimer is declined', async ({
    userDataDir,
    rpcPort,
  }) => {
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      disclaimerAccepted: false,
    })

    try {
      const disclaimer = await openDisclaimer(app)
      const closed = app.waitForEvent('close')

      await disclaimer.getByTestId('disclaimer-quit').click()

      await closed
    } finally {
      await app.close().catch(() => {})
    }
  })
})
