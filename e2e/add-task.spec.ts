import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

const TORRENT_ANNOUNCE = 'http://127.0.0.1:9/announce'

function singleFileTorrent(name: string): Buffer {
  return Buffer.from(
    `d8:announce${TORRENT_ANNOUNCE.length}:${TORRENT_ANNOUNCE}4:infod6:lengthi1e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:00000000000000000000ee`
  )
}

async function writeTorrentFixtures(
  directory: string,
  names: readonly string[]
): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(directory, `${name}.torrent`)
      await writeFile(filePath, singleFileTorrent(name))
      return filePath
    })
  )
}

async function removeAllTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) return
    const tasks = (await api.invoke('query:listTasks')) as Array<{ id: string }>
    if (tasks.length === 0) return
    await api.invoke('command:removeTasks', {
      taskIds: tasks.map((task) => task.id),
      deleteWithFiles: true,
    })
  })
}

test.describe('add task', () => {
  test('http url submitted via the add-task window appears in Downloads', async ({
    electronApp,
    mainWindow,
    httpFixture,
  }) => {
    // Engine has to be Ready before we submit — otherwise the IPC
    // handler that bridges to aria2 will reject and the renderer
    // surfaces a toast instead of a row in the list.
    await waitForEngineReady(mainWindow)

    // The trigger sits in the WindowChrome of the main window. Scope
    // the locator to mainWindow so it can't accidentally match the
    // identical-aria-label button inside the add-task window once that
    // window opens.
    await mainWindow.getByRole('button', { name: 'New task' }).click()

    const addTaskPage = await findAddTaskWindow(electronApp)

    // UrlTextarea exposes aria-label="URLs". Use fill() rather than
    // type() — the textarea has a paste interpreter wired up to a
    // ClipboardEvent handler, but plain typing/fill bypasses that and
    // just sets the value normally.
    await addTaskPage
      .getByRole('textbox', { name: 'URLs' })
      .fill(httpFixture.fileUrl)

    // FooterActions renders the submit as <Button> with text "Download"
    // (common.download). After submit the AddTaskWindow auto-closes
    // via electronServices.closeHost; we don't assert on that since
    // hide-vs-close is a window-manager detail.
    await addTaskPage.getByRole('button', { name: 'Download' }).click()

    // Switch the main window to the Downloads route. NavLink renders
    // an <a>; getByRole('link') is the stable accessor across i18n.
    await mainWindow.getByRole('link', { name: 'Downloads' }).click()
    await expect.poll(() => mainWindow.url()).toContain('#/downloads')

    // The row should show the URL-derived name once aria2's first
    // poll lands. Scoping by name ensures we don't pass on an "error"
    // row that aria2 emitted from a previous failure (a real risk
    // we hit during development — see git log around the
    // createTaskHandler `.motrix` mkdir guard).
    const row = mainWindow.getByRole('option').filter({ hasText: 'test.bin' })
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Sanity-check via IPC that the task isn't in `error` — the row
    // appearing is necessary but not sufficient. Lifecycle spec covers
    // the full Downloading → Completed transition; here we just want
    // the add path to land successfully.
    const status = await mainWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          motrix?: { invoke: (channel: string) => Promise<unknown> }
        }
      ).motrix
      const tasks = (await api?.invoke('query:listTasks')) as
        | Array<{ status: string }>
        | undefined
      return tasks?.[0]?.status
    })
    expect(status).not.toBe('error')
  })

  test('macOS open-file queues multiple torrents and downloads the remaining batch', async ({
    electronApp,
    mainWindow,
    userDataDir,
  }) => {
    await waitForEngineReady(mainWindow)

    const torrentPaths = await writeTorrentFixtures(userDataDir, [
      'alpha.bin',
      'beta.bin',
      'gamma.bin',
    ])

    try {
      // macOS sends one open-file event per Finder selection. Emit the three
      // events in one main-process turn so the test covers the real launcher →
      // parser → add-task queue rather than calling an IPC command directly.
      await electronApp.evaluate(({ app }, filePaths) => {
        for (const filePath of filePaths) {
          app.emit(
            'open-file',
            { preventDefault: () => undefined } as Electron.Event,
            filePath
          )
        }
      }, torrentPaths)

      const addTaskPage = await findAddTaskWindow(electronApp)
      await expect(
        addTaskPage.getByText('Torrent 1 of 3', { exact: true })
      ).toBeVisible()
      await expect(
        addTaskPage.getByText('alpha.bin', { exact: true }).first()
      ).toBeVisible()
      await expect(
        addTaskPage.getByRole('button', { name: 'Download All (3)' })
      ).toBeVisible()

      await addTaskPage.getByRole('button', { name: 'Skip' }).click()

      await expect(
        addTaskPage.getByText('Torrent 2 of 3', { exact: true })
      ).toBeVisible()
      await expect(
        addTaskPage.getByText('beta.bin', { exact: true }).first()
      ).toBeVisible()
      await expect(
        addTaskPage.getByRole('button', { name: 'Download All (2)' })
      ).toBeVisible()

      await addTaskPage
        .getByRole('button', { name: 'Download All (2)' })
        .click()

      await expect
        .poll(() => mainWindow.url())
        .toContain('#/downloads/all?task=')
      await expect(
        mainWindow.getByRole('option').filter({ hasText: 'beta.bin' })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        mainWindow.getByRole('option').filter({ hasText: 'gamma.bin' })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        mainWindow.getByRole('option').filter({ hasText: 'alpha.bin' })
      ).toHaveCount(0)
    } finally {
      // These unreachable-tracker one-byte tasks intentionally remain active.
      // Remove them so aria2 has no live BT jobs keeping E2E teardown open.
      await removeAllTasks(mainWindow).catch(() => undefined)
    }
  })
})
