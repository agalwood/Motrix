import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { Commands } from '../src/shared/protocol/commands'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

test('manual window limits survive settings saves and restore compact windows across restarts', async ({
  userDataDir,
  rpcPort,
}) => {
  const settingsPath = path.join(userDataDir, 'settings.json')
  const readSettings = async () =>
    JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(
    settingsPath,
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: {
        mainWindowMinWidth: 320,
        mainWindowMinHeight: 240,
        autofillClipboardLinks: false,
      },
      windowState: { main: { x: 100, y: 100, width: 180, height: 150 } },
      tracker: { autoSync: false },
      nat: { enabled: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
  let app = await launchMotrix({ userDataDir, rpcPort })
  try {
    let page = await app.firstWindow()
    await waitForEngineReady(page)
    let main = await app.browserWindow(page)
    expect(await main.evaluate((win) => win.getMinimumSize())).toEqual([
      320, 240,
    ])
    expect(await main.evaluate((win) => win.getBounds())).toMatchObject({
      width: 320,
      height: 240,
    })

    // Unrelated settings saves retain the manually configured limits.
    await page.evaluate(
      async (command) =>
        window.motrix.invoke(command, { app: { theme: 'dark' } }),
      Commands.UpdateSettings
    )
    await expect.poll(readSettings).toMatchObject({
      app: { mainWindowMinWidth: 320, mainWindowMinHeight: 240, theme: 'dark' },
    })
    await app.close()

    const unlimited = await readSettings()
    unlimited.app.mainWindowMinWidth = 0
    unlimited.app.mainWindowMinHeight = 0
    await writeFile(settingsPath, JSON.stringify(unlimited))
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await waitForEngineReady(page)
    main = await app.browserWindow(page)
    expect(await main.evaluate((win) => win.getMinimumSize())).toEqual([0, 0])
    await main.evaluate((win) => win.setSize(180, 150))
    const compact = await main.evaluate((win) => win.getBounds())
    expect(compact.width).toBeLessThan(320)
    expect(compact.height).toBeLessThan(240)
    await expect.poll(readSettings).toMatchObject({
      windowState: { main: { width: compact.width, height: compact.height } },
    })
    await app.close()

    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await waitForEngineReady(page)
    main = await app.browserWindow(page)
    expect(await main.evaluate((win) => win.getMinimumSize())).toEqual([0, 0])
    expect(await main.evaluate((win) => win.getBounds())).toMatchObject({
      width: compact.width,
      height: compact.height,
    })
    await app.close()

    const constrained = await readSettings()
    constrained.app.mainWindowMinWidth = 400
    constrained.app.mainWindowMinHeight = 300
    await writeFile(settingsPath, JSON.stringify(constrained))
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await waitForEngineReady(page)
    main = await app.browserWindow(page)
    expect(await main.evaluate((win) => win.getMinimumSize())).toEqual([
      400, 300,
    ])
    expect(await main.evaluate((win) => win.getBounds())).toMatchObject({
      width: 400,
      height: 300,
    })
  } finally {
    await app.close().catch(() => {})
  }
})
