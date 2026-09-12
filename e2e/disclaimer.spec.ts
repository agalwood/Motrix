import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
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
      // Preserve the beta.29 onboarding geometry: the 32px language trigger
      // sits with its centerline at y=34 in the 40px compact chrome region.
      expect(
        (languageBounds?.y ?? 0) + (languageBounds?.height ?? 0) / 2
      ).toBeCloseTo(34, 1)

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

  test('fetches first-run trackers only after consent and the startup delay', async ({
    userDataDir,
    rpcPort,
  }) => {
    const trackerUrl = 'udp://tracker.example.test:6969/announce'
    const requests: number[] = []
    let pendingResponse: ServerResponse | undefined
    const source = createServer((_request, response) => {
      requests.push(Date.now())
      pendingResponse = response
    })
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
    const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/trackers.txt`
    let app: ElectronApplication | undefined
    try {
      await writeFile(
        path.join(userDataDir, 'settings.json'),
        JSON.stringify({
          version: CURRENT_SETTINGS_VERSION,
          onboarding: { disclaimerAccepted: false },
          app: { checkForUpdatesOnLaunch: false },
          tracker: {
            autoSync: true,
            sourcesEnabled: true,
            sources: [
              {
                id: 'local-test',
                label: 'Local test',
                url: sourceUrl,
                builtin: false,
                enabled: true,
                cdn: false,
              },
            ],
            probeEnabled: false,
            blacklistEnabled: false,
          },
        })
      )
      app = await launchMotrix({
        userDataDir,
        rpcPort,
        disclaimerAccepted: false,
      })
      const disclaimer = await openDisclaimer(app)
      // Stay on the notice longer than the initial-sync delay: consent is required.
      await disclaimer.waitForTimeout(3_500)
      expect(requests).toHaveLength(0)
      const acceptedAt = Date.now()
      const opened = app.waitForEvent('window')
      await disclaimer.getByTestId('disclaimer-agree').click()
      const main = await opened
      await main.waitForLoadState('domcontentloaded')
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1)
      expect(requests[0] - acceptedAt).toBeGreaterThanOrEqual(3_000)
      // Open after the automatic sync has started: the UI must recover its
      // state from the host snapshot, without requiring a manual button click.
      await main.getByRole('link', { name: 'Trackers', exact: true }).click()
      await expect(
        main.getByRole('button', { name: 'Syncing...' })
      ).toBeDisabled()
      await expect(main.getByRole('status')).toHaveText(
        'Fetching tracker lists…'
      )
      await expect(main.getByRole('tabpanel')).toContainText(
        'Fetching tracker lists…'
      )
      pendingResponse
        ?.writeHead(200, { 'Content-Type': 'text/plain' })
        .end(`${trackerUrl}\n`)
      await expect(main.getByText(trackerUrl, { exact: true })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Sync Now' })).toBeEnabled()
      await expect(main.getByText('Fetching tracker lists…')).toHaveCount(0)
    } finally {
      pendingResponse?.destroy()
      await app?.close().catch(() => {})
      await new Promise<void>((resolve) => source.close(() => resolve()))
    }
  })
})
