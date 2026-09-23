import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { RunMode } from '../src/shared/constants'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

for (const loginLaunch of [false, true]) {
  test(`a saved maximized window stays hidden during ${loginLaunch ? 'login' : 'tray'} startup`, async ({
    userDataDir,
    rpcPort,
  }) => {
    test.skip(
      loginLaunch && process.platform === 'darwin',
      'macOS detects real login launches through the OS, not argv'
    )
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        onboarding: { disclaimerAccepted: true },
        tracker: { autoSync: false },
        app: {
          runMode: loginLaunch ? RunMode.Standard : RunMode.TrayOnly,
          lightweightMode: false,
          showMainWindowAtLogin: false,
        },
        windowState: {
          main: { x: 100, y: 100, width: 1024, height: 768, maximized: true },
        },
      })
    )
    const electronApp = await launchMotrix({
      userDataDir,
      rpcPort,
      commandLineArgs: loginLaunch ? ['--opened-at-login=1'] : [],
    })
    try {
      const main = await electronApp.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      const windowState = () =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes('w=main')
          )
          return {
            visible: win?.isVisible(),
            maximized: win?.isMaximized(),
          }
        })
      expect(await windowState()).toEqual({ visible: false, maximized: false })
      await waitForEngineReady(main)
      // Allow startup bounds persistence and renderer prewarming to settle.
      await electronApp.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 2_500))
      )
      expect(await windowState()).toEqual({ visible: false, maximized: false })
      await electronApp.evaluate(({ app }) => app.emit('activate'))
      await expect.poll(windowState).toEqual({ visible: true, maximized: true })
    } finally {
      await electronApp.close()
    }
  })
}
