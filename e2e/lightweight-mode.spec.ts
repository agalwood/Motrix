import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { RunMode } from '../src/shared/constants'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
} from './fixtures/electron-app'

async function waitForMainWindow(
  electronApp: ElectronApplication
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(({ app }) => {
    app.emit('activate')
  })
  const page = await pagePromise
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.url()).toContain('w=main')
  return page
}

async function closeMainWindow(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('w=main')
    )
    main?.close()
  })
  await expect
    .poll(() =>
      electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
      )
    )
    .toBe(0)
}

async function closeMainThroughRenderer(
  electronApp: ElectronApplication,
  mainWindow: Page
): Promise<void> {
  await mainWindow.evaluate(() => {
    const api = (
      window as unknown as {
        motrix: { invoke: (channel: string) => Promise<unknown> }
      }
    ).motrix
    // The window is expected to disappear before the invoke response can be
    // observed, so attach a rejection handler and assert the host-side result.
    void api.invoke('command:closeCurrentWindow').catch(() => {})
  })
  await expect
    .poll(() =>
      electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
      )
    )
    .toBe(0)
}

test.describe('lightweight mode', () => {
  test('stays renderer-free in the background and recreates windows on demand', async ({
    userDataDir,
    rpcPort,
  }) => {
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        onboarding: { disclaimerAccepted: true },
        app: {
          lightweightMode: true,
          runMode: RunMode.TrayOnly,
        },
      }),
      'utf8'
    )

    const electronApp = await launchMotrix({ userDataDir, rpcPort })
    try {
      // Waiting for the menu proves main-process initialization has passed the
      // legal gate. Waiting beyond the historical add-task prewarm delay then
      // proves lightweight startup did not allocate either renderer window.
      await expect
        .poll(() =>
          electronApp.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu()))
        )
        .toBe(true)
      await electronApp.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 2_500))
      )
      expect(electronApp.windows()).toHaveLength(0)

      const firstMain = await waitForMainWindow(electronApp)
      const settings = await firstMain.evaluate(async () => {
        const api = (
          window as unknown as {
            motrix: { invoke: (channel: string) => Promise<unknown> }
          }
        ).motrix
        return api.invoke('query:getSettings') as Promise<{
          app: { lightweightMode: boolean }
        }>
      })
      expect(settings.app.lightweightMode).toBe(true)

      await closeMainThroughRenderer(electronApp, firstMain)

      const secondMain = await waitForMainWindow(electronApp)
      await expect(
        secondMain.getByRole('heading', { name: 'Dashboard' })
      ).toBeVisible()
      await closeMainWindow(electronApp)

      const magnetUri =
        'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
      await electronApp.evaluate(({ app }, uri) => {
        app.emit(
          'open-url',
          { preventDefault: () => undefined } as Electron.Event,
          uri
        )
      }, magnetUri)

      const addTask = await findAddTaskWindow(electronApp)
      await expect(addTask.getByRole('textbox', { name: 'URLs' })).toHaveValue(
        magnetUri
      )
    } finally {
      await electronApp.close().catch(() => {})
    }
  })
})
