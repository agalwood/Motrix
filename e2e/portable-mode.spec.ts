import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { Queries } from '@shared/protocol/queries'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import {
  expect,
  launchMotrix,
  test,
  waitForQueryHandlers,
} from './fixtures/electron-app'

async function openCard(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByText(name, { exact: true }).first().click()
}

test.beforeEach(async ({ userDataDir }) => {
  // These tests exercise settings presentation, without registering a host
  // browser launcher or importing clipboard content on the test machine.
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: {
        language: 'en-US',
        browserBridgeEnabled: false,
        autofillClipboardLinks: false,
      },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
})

test('ordinary desktop runtime retains its existing settings controls', async ({
  userDataDir,
  rpcPort,
}) => {
  const app = await launchMotrix({
    userDataDir,
    rpcPort,
    extraEnv: { MOTRIX_DEV_DISABLE_NATIVE_MESSAGING: '1' },
  })
  try {
    const page = await app.firstWindow()
    await waitForQueryHandlers(page)
    expect(
      await page.evaluate(
        (channel) => window.motrix.invoke(channel),
        Queries.GetPortableMode
      )
    ).toEqual({ enabled: false })
    await openCard(page, 'General')
    if (process.platform !== 'linux')
      await expect(
        page.getByRole('switch', { name: 'Open at login', exact: true })
      ).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('portable capability presentation disables system integration and offers manual updates', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  const app = await launchMotrix({
    userDataDir,
    rpcPort,
    extraEnv: { MOTRIX_DEV_DISABLE_NATIVE_MESSAGING: '1' },
  })
  try {
    const page = await app.firstWindow()
    await waitForQueryHandlers(page)
    // Portable selection and main-process enforcement are covered by platform
    // tests. Inject the capability snapshot to exercise its real renderer UI
    // on every desktop CI host without pretending to run a Windows package.
    await app.evaluate(
      ({ ipcMain }, channels) => {
        ipcMain.removeHandler(channels.mode)
        ipcMain.handle(channels.mode, () => ({
          enabled: true,
          dataDirectory: 'E:\\Motrix\\data',
        }))
        ipcMain.removeHandler(channels.update)
        ipcMain.handle(channels.update, () => ({
          phase: 'available',
          currentVersion: '2.0.1',
          availableVersion: '2.0.2',
          manualInstallReason: 'portable',
        }))
      },
      { mode: Queries.GetPortableMode, update: Queries.GetUpdateState }
    )
    await openCard(page, 'General')
    if (process.platform !== 'linux')
      await expect(
        page.getByText(/Portable mode keeps system settings unchanged/)
      ).toBeVisible()
    if (process.platform !== 'linux')
      await expect(
        page.getByRole('switch', { name: 'Open at login', exact: true })
      ).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openCard(page, 'Advanced')
    await expect(
      page.getByRole('textbox', { name: 'Recovery data file', exact: true })
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openCard(page, 'About')
    await expect(page.getByText('Portable mode', { exact: true })).toBeVisible()
    await expect(
      page.getByText(/Portable mode never runs the installer/)
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Download manually' })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /restart and install/i })
    ).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('portable-about.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})
