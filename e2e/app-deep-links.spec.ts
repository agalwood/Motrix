import type { ElectronApplication } from '@playwright/test'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

async function openLink(app: ElectronApplication, url: string) {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit(
      'open-url',
      { preventDefault: () => undefined } as Electron.Event,
      link
    )
  }, url)
}

test('app links navigate from settings and restore a minimized window', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  await openLink(electronApp, 'motrix://settings')
  await expect.poll(() => mainWindow.url()).toContain('#/settings')
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes('w=main'))
      ?.minimize()
  })
  await openLink(electronApp, 'motrix://task-list')
  await expect.poll(() => mainWindow.url()).toContain('#/downloads/active')
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().includes('w=main')
        )
        return Boolean(win?.isVisible() && !win.isMinimized())
      })
    )
    .toBe(true)
  await mainWindow.evaluate(() => {
    window.location.hash = '/downloads/all?type=http&q=stale'
  })
  await openLink(electronApp, 'motrix://downloads/completed')
  await expect
    .poll(() => new URL(mainWindow.url()).hash)
    .toBe('#/downloads/completed')
  await openLink(electronApp, 'motrix://about')
  await expect
    .poll(() => new URL(mainWindow.url()).hash)
    .toBe('#/settings/about')
  await expect(mainWindow.getByRole('dialog')).toBeVisible()
})

test('new-task prefill does not create a task; retired links only report a notice', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  const url = 'https://example.com/file%20name.zip?token=a%2Bb&part=1'
  await openLink(
    electronApp,
    `motrix://new-task?uri=${encodeURIComponent(url)}`
  )
  const addTask = await findAddTaskWindow(electronApp)
  await expect(addTask.getByRole('textbox', { name: 'URLs' })).toHaveValue(url)
  await electronApp.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      protocolNotices?: string[]
    }
    state.protocolNotices = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string }
      state.protocolNotices?.push(options.message)
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  for (const link of [
    'mo://task-list',
    'motrix://pause-all-task',
    `motrix://new-task?uri=${encodeURIComponent(url)}&silent=1`,
  ]) {
    await openLink(electronApp, link)
  }
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          (globalThis as typeof globalThis & { protocolNotices: string[] })
            .protocolNotices.length
      )
    )
    .toBe(3)
  const messages = await electronApp.evaluate(
    () =>
      (globalThis as typeof globalThis & { protocolNotices: string[] })
        .protocolNotices
  )
  expect(messages[0]).toContain('mo://')
  expect(messages[1]).toContain('retired')
  expect(messages[2]).toContain('unsupported parameters')
  const tasks = await mainWindow.evaluate(
    async (channel) => window.motrix.invoke(channel),
    Queries.ListTasks
  )
  expect(tasks).toEqual([])
  await expect(addTask.getByRole('textbox', { name: 'URLs' })).toHaveValue(url)
  await openLink(electronApp, 'motrix://new-bt-task')
  await expect(
    addTask.getByRole('tab', { name: 'Torrent', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await openLink(electronApp, 'motrix://new-task')
  await expect(addTask.getByRole('textbox', { name: 'URLs' })).toHaveValue('')
})

test('an early app link survives renderer startup and a released main window', async ({
  userDataDir,
  rpcPort,
}) => {
  const app = await launchMotrix({ userDataDir, rpcPort })
  try {
    await openLink(app, 'motrix://task-list')
    const page = await app.firstWindow()
    await expect.poll(() => new URL(page.url()).hash).toBe('#/downloads/active')
    await waitForEngineReady(page)
    const nextWindow = app.waitForEvent('window', {
      predicate: (candidate) => candidate !== page,
    })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('w=main'))
        ?.destroy()
    })
    await openLink(app, 'motrix://downloads/error')
    // A precreated add-task window may also appear during this test.
    await nextWindow
    await expect
      .poll(() =>
        app
          .windows()
          .some((window) => window.url().includes('#/downloads/error'))
      )
      .toBe(true)
  } finally {
    await app.close().catch(() => {})
  }
})
