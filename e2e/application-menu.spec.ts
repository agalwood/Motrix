import { expect, test } from './fixtures/electron-app'

test.describe('application menu', () => {
  test('uses the native macOS menu without rendering the custom trigger', async ({
    electronApp,
    mainWindow,
  }) => {
    test.skip(process.platform !== 'darwin')

    await expect(
      mainWindow.locator('[data-slot="motrix-menu-trigger"]')
    ).toHaveCount(0)
    await expect
      .poll(() =>
        electronApp.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu()))
      )
      .toBe(true)
  })

  test('keeps the Windows/Linux native menu hidden while preserving behavior', async ({
    electronApp,
    mainWindow,
  }) => {
    test.skip(process.platform === 'darwin')

    await expect(
      mainWindow.locator('[data-slot="motrix-menu-trigger"]')
    ).toBeVisible()

    const isMainMenuBarVisible = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('w=main')
        )
        return main?.isMenuBarVisible() ?? null
      })

    await expect.poll(isMainMenuBarVisible).toBe(false)
    await mainWindow.keyboard.press('Alt')
    await expect.poll(isMainMenuBarVisible).toBe(false)

    await mainWindow.keyboard.press('Control+N')
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (window) =>
              window.webContents.getURL().includes('w=add-task') &&
              window.isVisible()
          )
        )
      )
      .toBe(true)

    const request = await mainWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          motrix: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      const snapshot = (await api.invoke('query:getApplicationMenu')) as {
        revision: number
      }
      return api.invoke('command:executeApplicationMenuItem', {
        itemId: 'menubar.window.minimize',
        revision: snapshot.revision,
        trigger: 'menu',
        selectedTaskId: null,
      })
    })
    expect(request).toEqual({ ok: true })

    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes('w=main')
          )
          return main?.isMinimized() ?? null
        })
      )
      .toBe(true)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('w=main')
      )
      main?.restore()
      main?.show()
    })
  })
})
