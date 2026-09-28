import { Events } from '@shared/protocol/events'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '../src/test-utils/task'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

test.describe('application menu', () => {
  test('selects tasks from the Task menu while preserving text editing shortcuts', async ({
    electronApp,
    mainWindow,
  }) => {
    await waitForEngineReady(mainWindow)
    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
    const tasks = Array.from({ length: 40 }, (_, index) =>
      makeDownloadTask({
        id: `menu-selection-${index}`,
        name: `Menu task ${index}.bin`,
        status: index < 2 ? TaskStatus.Completed : TaskStatus.Paused,
        createdAt: index,
      })
    )
    await electronApp.evaluate(
      ({ BrowserWindow }, payload) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('w=main')
        )
        main?.webContents.send(payload.channel, payload.tasks)
      },
      { channel: Events.TaskUpdated, tasks }
    )
    const grid = mainWindow.getByRole('grid', { name: 'Downloads' })
    const rows = grid.locator('[data-task-id]')
    await expect(rows.first()).toBeVisible()
    await rows.first().click()

    const clickNativeItem = (id: string) =>
      electronApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('w=main')
        )
        if (!item?.enabled || !main) throw new Error('Menu item is unavailable')
        main.focus()
        // Electron normalizes roles to lowercase. AppKit dispatches editing
        // roles through the responder chain, not MenuItem.click.
        if (
          process.platform === 'darwin' &&
          item.role?.toLowerCase() === 'selectall'
        ) {
          Menu.sendActionToFirstResponder('selectAll:')
          return
        }
        item.click({}, main, main.webContents)
      }, id)

    await clickNativeItem('menubar.task.selectAll')
    await expect(
      grid.locator('[data-task-id][aria-selected="false"]')
    ).toHaveCount(0)
    await expect(grid).toBeFocused()
    expect(
      await mainWindow.evaluate(() => window.getSelection()?.toString())
    ).toBe('')

    // Virtual rows that were offscreen when the command ran must also be selected.
    await mainWindow
      .getByTestId('virtual-list-container')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
    await expect(
      grid.locator('[data-task-id="menu-selection-0"]')
    ).toBeVisible()
    await expect(
      grid.locator('[data-task-id][aria-selected="false"]')
    ).toHaveCount(0)

    await mainWindow
      .getByRole('button', { name: 'All Downloads', exact: true })
      .click()
    await mainWindow.getByRole('menuitem', { name: /^Completed/ }).click()
    await expect(rows).toHaveCount(2)
    await rows.first().click()
    await mainWindow.keyboard.press('Escape')
    await clickNativeItem('menubar.task.selectAll')
    await expect(
      grid.locator('[data-task-id][aria-selected="true"]')
    ).toHaveCount(2)

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await mainWindow.keyboard.press('Escape')
    await mainWindow.keyboard.press(`${modifier}+a`)
    await expect(
      grid.locator('[data-task-id][aria-selected="true"]')
    ).toHaveCount(2)
    expect(
      await mainWindow.evaluate(() => window.getSelection()?.toString())
    ).toBe('')

    await mainWindow
      .getByRole('button', { name: 'Search downloads', exact: true })
      .click()
    const input = mainWindow.getByPlaceholder('Search downloads', {
      exact: true,
    })
    await input.fill('Menu task')
    await input.press(`${modifier}+a`)
    await expect
      .poll(() =>
        input.evaluate((element: HTMLInputElement) =>
          element.value.slice(
            element.selectionStart ?? 0,
            element.selectionEnd ?? 0
          )
        )
      )
      .toBe('Menu task')
    await expect(
      grid.locator('[data-task-id][aria-selected="true"]')
    ).toHaveCount(2)
    await input.press('ArrowRight')
    await clickNativeItem('menubar.edit.selectAll')
    await expect
      .poll(() =>
        input.evaluate((element: HTMLInputElement) =>
          element.value.slice(
            element.selectionStart ?? 0,
            element.selectionEnd ?? 0
          )
        )
      )
      .toBe('Menu task')
    await mainWindow.keyboard.press('Escape')

    await mainWindow
      .getByRole('link', { name: 'Settings', exact: true })
      .click()
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()?.getMenuItemById('menubar.task.selectAll')
              ?.enabled
        )
      )
      .toBe(false)
  })

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
