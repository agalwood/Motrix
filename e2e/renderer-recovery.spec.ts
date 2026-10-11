import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

async function recover(app: ElectronApplication, page: Page): Promise<Page> {
  const windowId = new URL(page.url()).searchParams.get('w')
  const next = app.waitForEvent('window', {
    predicate: (candidate) => candidate !== page,
  })
  await page.evaluate(
    async ({ query, command }) => {
      const session = (await window.motrix?.invoke(query)) as {
        generation: string
      }
      void window.motrix
        ?.invoke(command, { generation: session.generation })
        .catch(() => {})
    },
    {
      query: Queries.GetRendererSession,
      command: Commands.RecoverCurrentRenderer,
    }
  )
  await next
  await expect
    .poll(() =>
      app
        .windows()
        .some(
          (candidate) =>
            candidate !== page && candidate.url().includes(`w=${windowId}`)
        )
    )
    .toBe(true)
  const restored = app
    .windows()
    .find(
      (candidate) =>
        candidate !== page && candidate.url().includes(`w=${windowId}`)
    )
  if (!restored) throw new Error('Restored window missing')
  await restored.waitForLoadState('domcontentloaded')
  return restored
}

test('manual recovery keeps the application and engine alive and opens downloads', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  await expect(
    mainWindow.getByRole('button', { name: 'New task' })
  ).toBeVisible()
  const pid = electronApp.process().pid
  const restored = await recover(electronApp, mainWindow)
  await expect(
    restored.getByRole('heading', { name: 'All Downloads' })
  ).toBeVisible()
  await waitForEngineReady(restored)
  expect(electronApp.process().pid).toBe(pid)
  await expect(
    restored.getByRole('status').filter({ hasText: 'Interface restored' })
  ).toBeVisible()
  await expect(
    restored.getByRole('status').filter({ hasText: 'Interface restored' })
  ).toHaveCount(0)
})

test('native reload preserves the current page after leaving a settings dialog', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  await expect(
    mainWindow.getByRole('link', { name: 'Settings', exact: true })
  ).toBeVisible()
  await mainWindow.evaluate(() => {
    location.hash = '/settings/downloads'
  })
  await expect(mainWindow.getByRole('dialog')).toBeVisible()
  await expect
    .poll(() =>
      mainWindow.evaluate(async (query) => {
        const session = (await window.motrix.invoke(query)) as {
          route?: string
        }
        return session.route
      }, Queries.GetRendererSession)
    )
    .toBe('/settings/downloads')
  await mainWindow.getByRole('button', { name: 'Cancel', exact: true }).click()
  await mainWindow.getByRole('link', { name: 'Trackers', exact: true }).click()
  await expect(mainWindow).toHaveURL(/#\/trackers$/)
  await expect(mainWindow.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(() =>
      mainWindow.evaluate(async (query) => {
        const session = (await window.motrix.invoke(query)) as {
          route?: string
        }
        return session.route
      }, Queries.GetRendererSession)
    )
    .toBe('/trackers')

  // Even a late surface report must not override the URL on a normal reload.
  await mainWindow.evaluate(
    async ({ query, command }) => {
      const session = (await window.motrix.invoke(query)) as {
        generation: string
      }
      await window.motrix.invoke(command, {
        generation: session.generation,
        surface: 'app',
        capabilities: ['navigation'],
        documentVisible: true,
        route: '/settings/downloads',
      })
    },
    {
      query: Queries.GetRendererSession,
      command: Commands.ReportRendererSurface,
    }
  )

  const navigation = mainWindow.waitForEvent('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('w=main')
    )
    if (!main) throw new Error('Main window missing')
    // The native Reload menu role used by Cmd+R reloads this webContents.
    main.webContents.reload()
  })
  await navigation
  await expect(
    mainWindow.getByRole('heading', { name: 'Trackers', exact: true })
  ).toBeVisible()
  await expect(mainWindow).toHaveURL(/#\/trackers$/)
  await expect(mainWindow.getByRole('dialog')).toHaveCount(0)
})

for (const surface of ['app', 'fatal-fallback'] as const) {
  test(`a crashed ${surface} renderer recovers through native UI without an IPC-capable page`, async ({
    electronApp,
    mainWindow,
  }) => {
    await waitForEngineReady(mainWindow)
    await expect(
      mainWindow.getByRole('button', { name: 'New task' })
    ).toBeVisible()
    if (surface === 'fatal-fallback') {
      await mainWindow.evaluate(
        async ({ query, command }) => {
          const session = (await window.motrix.invoke(query)) as {
            generation: string
          }
          await window.motrix.invoke(command, {
            generation: session.generation,
            surface: 'fatal-fallback',
            capabilities: [],
            documentVisible: true,
          })
        },
        {
          query: Queries.GetRendererSession,
          command: Commands.ReportRendererSurface,
        }
      )
    }
    const next = electronApp.waitForEvent('window', {
      predicate: (candidate) => candidate !== mainWindow,
    })
    await electronApp.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
      const main = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('w=main')
      )
      if (!main) throw new Error('Main window missing')
      main.webContents.forcefullyCrashRenderer()
    })
    await next
    await expect
      .poll(() =>
        electronApp
          .windows()
          .some((page) => page !== mainWindow && page.url().includes('w=main'))
      )
      .toBe(true)
    const restored = electronApp
      .windows()
      .find((page) => page !== mainWindow && page.url().includes('w=main'))
    if (!restored) throw new Error('Main window missing')
    await expect(
      restored.getByRole('heading', { name: 'All Downloads' })
    ).toBeVisible()
    await waitForEngineReady(restored)
  })
}

test('navigation queued during a transient hang reaches the same document after its probe reply', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  await expect(
    mainWindow.getByRole('button', { name: 'New task' })
  ).toBeVisible()
  const before = await mainWindow.evaluate(
    async ({ query, command }) => {
      const session = (await window.motrix.invoke(query)) as {
        generation: string
      }
      await window.motrix.invoke(command, {
        generation: session.generation,
        surface: 'app',
        capabilities: ['navigation'],
        documentVisible: true,
      })
      return session
    },
    {
      query: Queries.GetRendererSession,
      command: Commands.ReportRendererSurface,
    }
  )
  await electronApp.evaluate(
    ({ BrowserWindow, app, ipcMain }, surfaceCommand) => {
      const main = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('w=main')
      )
      if (!main) throw new Error('Main window missing')
      // Isolate the probe recovery path: a visibility/capability surface report
      // would otherwise heal the suspect phase and mask a missing probe flush.
      ipcMain.removeHandler(surfaceCommand)
      ipcMain.handle(surfaceCommand, () => {})
      // Queue navigation before the main-world probe can reply.
      main.webContents.emit('unresponsive')
      app.emit(
        'open-url',
        { preventDefault() {} },
        'motrix://plugins/motrix.review'
      )
    },
    Commands.ReportRendererSurface
  )
  await expect(mainWindow).toHaveURL(/#\/plugins\/motrix\.review$/, {
    timeout: 20_000,
  })
  const after = await mainWindow.evaluate(async (query) => {
    return window.motrix.invoke(query) as Promise<{ generation: string }>
  }, Queries.GetRendererSession)
  expect(after.generation).toBe(before.generation)
})

test('recovering onboarding preserves the legal gate and does not quit', async ({
  userDataDir,
  rpcPort,
}) => {
  const app = await launchMotrix({
    userDataDir,
    rpcPort,
    disclaimerAccepted: false,
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('disclaimer-agree')).toBeVisible()
    const restored = await recover(app, page)
    await expect(restored.getByTestId('disclaimer-agree')).toBeVisible()
    expect(
      app.windows().some((candidate) => candidate.url().includes('w=main'))
    ).toBe(false)
  } finally {
    await app.close()
  }
})

test('add-task recovery restores a delivered link after its renderer acknowledged it', async ({
  electronApp,
  mainWindow,
}) => {
  await waitForEngineReady(mainWindow)
  const url = 'https://example.com/recovery-file.zip'
  await electronApp.evaluate(({ app }, url) => {
    app.emit(
      'open-url',
      { preventDefault() {} },
      `motrix://new-task?uri=${encodeURIComponent(url)}`
    )
  }, url)
  const page = await findAddTaskWindow(electronApp)
  await expect(page.getByRole('textbox', { name: 'URLs' })).toHaveValue(url)
  const restored = await recover(electronApp, page)
  await expect(restored.getByRole('textbox', { name: 'URLs' })).toHaveValue(url)
})

test('recovery preserves the current torrent and queue position', async ({
  electronApp,
  mainWindow,
  userDataDir,
}) => {
  test.skip(
    process.platform !== 'darwin',
    'File-open event is a macOS association entry point'
  )
  await waitForEngineReady(mainWindow)
  const files: string[] = []
  for (const name of ['first.bin', 'second.bin']) {
    const file = path.join(userDataDir, `${name}.torrent`)
    await writeFile(
      file,
      `d4:infod6:lengthi1e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:00000000000000000000ee`
    )
    files.push(file)
  }
  await electronApp.evaluate(({ app }, files) => {
    for (const file of files)
      app.emit('open-file', { preventDefault() {} }, file)
  }, files)
  const page = await findAddTaskWindow(electronApp)
  await expect(
    page.getByText('first.bin', { exact: true }).first()
  ).toBeVisible()
  const restored = await recover(electronApp, page)
  await expect(
    restored.getByText('first.bin', { exact: true }).first()
  ).toBeVisible()
  const next = await restored.evaluate(
    async (channel) => window.motrix?.invoke(channel),
    Commands.NextTorrent
  )
  expect(next).toEqual({ advanced: true })
  await expect(
    restored.getByText('second.bin', { exact: true }).first()
  ).toBeVisible()
})

test('an accepted submission survives renderer replacement without creating a duplicate', async ({
  electronApp,
  mainWindow,
  userDataDir,
}) => {
  await waitForEngineReady(mainWindow)
  const fixture = await startHttpFixture({
    size: 2 * 1024 * 1024,
    throttleBytesPerSecond: 128 * 1024,
  })
  try {
    await mainWindow.getByRole('button', { name: 'New task' }).click()
    const page = await findAddTaskWindow(electronApp)
    await expect(page.getByRole('textbox', { name: 'URLs' })).toBeVisible()
    await page.evaluate(
      async ({ query, command, create, uri, saveDir }) => {
        const session = (await window.motrix?.invoke(query)) as {
          generation: string
        }
        await window.motrix?.invoke(command, {
          id: crypto.randomUUID(),
          generation: session.generation,
          channel: create,
          args: [{ type: 'http', uris: [uri], saveDir, connections: 1 }],
        })
      },
      {
        query: Queries.GetRendererSession,
        command: Commands.ExecuteRendererSubmission,
        create: Commands.CreateTask,
        uri: fixture.fileUrl,
        saveDir: path.join(userDataDir, 'downloads'),
      }
    )
    const restored = await recover(electronApp, page)
    await expect(
      restored.getByRole('status').filter({ hasText: 'previous submission' })
    ).toBeVisible()
    await expect(restored.getByRole('textbox', { name: 'URLs' })).toHaveValue(
      ''
    )
    await expect
      .poll(
        async () =>
          mainWindow.evaluate(async (query) => {
            const tasks = (await window.motrix?.invoke(query)) as {
              status: string
            }[]
            return tasks.length === 1
              ? tasks[0].status
              : `${tasks.length} tasks`
          }, Queries.ListTasks),
        { timeout: 30_000 }
      )
      .toBe('completed')
    expect(
      await fixture.verifyFile(path.join(userDataDir, 'downloads', 'test.bin'))
    ).toBe(true)
  } finally {
    await fixture.close()
  }
})
