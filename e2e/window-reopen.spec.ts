import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { RunMode } from '../src/shared/constants'
import {
  expect,
  launchMotrix,
  test,
  waitForQueryHandlers,
} from './fixtures/electron-app'

async function secondLaunch(app: ElectronApplication): Promise<void> {
  // Exercise the Windows/Linux desktop shortcut event, including on macOS CI.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('second-instance', {}, ['Motrix.exe'], '', {})
  })
}

async function windowState(app: ElectronApplication, id = 'main') {
  return app.evaluate(({ BrowserWindow }, windowId) => {
    const win = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes(`w=${windowId}`)
    )
    return win
      ? { visible: win.isVisible(), minimized: win.isMinimized() }
      : null
  }, id)
}

test('a second launch restores a minimized main window', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForQueryHandlers(mainWindow)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('w=main'))
      ?.minimize()
  })
  await expect
    .poll(async () => (await windowState(electronApp))?.minimized)
    .toBe(true)

  await secondLaunch(electronApp)
  await expect
    .poll(() => windowState(electronApp))
    .toEqual({
      visible: true,
      minimized: false,
    })
})

for (const lightweightMode of [false, true]) {
  test(`a second launch reopens a closed main window with lightweight mode ${lightweightMode}`, async ({
    userDataDir,
    rpcPort,
  }) => {
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        onboarding: { disclaimerAccepted: true },
        tracker: { autoSync: false },
        app: { runMode: RunMode.Standard, lightweightMode },
      })
    )
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      const main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await waitForQueryHandlers(main)
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes('w=main'))
          ?.close()
      })
      await expect
        .poll(() => windowState(app))
        .toEqual(lightweightMode ? null : { visible: false, minimized: false })

      await secondLaunch(app)
      await expect
        .poll(() => windowState(app))
        .toEqual({
          visible: true,
          minimized: false,
        })
    } finally {
      await app.close()
    }
  })
}

test('a second launch restores onboarding before consent is accepted', async ({
  userDataDir,
  rpcPort,
}) => {
  const app = await launchMotrix({
    userDataDir,
    rpcPort,
    disclaimerAccepted: false,
  })
  try {
    const onboarding = await app.firstWindow()
    await expect(onboarding.getByTestId('disclaimer-agree')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('w=onboarding'))
        ?.minimize()
    })
    await expect
      .poll(async () => (await windowState(app, 'onboarding'))?.minimized)
      .toBe(true)

    await secondLaunch(app)
    await expect
      .poll(() => windowState(app, 'onboarding'))
      .toEqual({
        visible: true,
        minimized: false,
      })
    expect(await windowState(app)).toBeNull()
  } finally {
    await app.close()
  }
})
