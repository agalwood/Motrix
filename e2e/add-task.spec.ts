import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { ADD_TASK_COLLAPSED_HEIGHT } from '../src/shared/constants/add-task'
import { Queries } from '../src/shared/protocol/queries'
import {
  type DownloadTask,
  TaskStatus,
  TaskType,
} from '../src/shared/types/task'
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
  test('blank input stays idle and URL editing preserves the collapsed window height', async ({
    electronApp,
    mainWindow,
  }, testInfo) => {
    await waitForEngineReady(mainWindow)
    await mainWindow.getByRole('button', { name: 'New task' }).click()
    const page = await findAddTaskWindow(electronApp)
    const textbox = page.getByRole('textbox', { name: 'URLs' })
    const download = page.getByRole('button', { name: 'Download', exact: true })
    await expect(textbox).toBeVisible()
    await expect(page.getByText('URLs', { exact: true })).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => innerHeight))
      .toBe(ADD_TASK_COLLAPSED_HEIGHT)
    const heights = () =>
      page.evaluate(() => {
        const textarea = document.querySelector('textarea')!
        const content = document.querySelector<HTMLElement>(
          '[data-adaptive-content]'
        )!
        return {
          window: innerHeight,
          editor: textarea.clientHeight,
          natural: content.getBoundingClientRect().top + content.scrollHeight,
        }
      })
    const initial = await heights()
    expect(initial.editor).toBe(100)
    expect(initial.natural).toBeLessThanOrEqual(initial.window)
    await textbox.focus()
    await textbox.press('ControlOrMeta+Enter')
    await textbox.evaluate((element) => element.blur())
    await expect(textbox).toHaveAttribute('aria-invalid', 'false')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(download).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('url-editor-empty.png') })

    for (const value of [
      'htps://example.com',
      'https://example.com/file.zip\nhtps://example.com',
      Array.from(
        { length: 40 },
        (_, index) => `https://example.com/${index}`
      ).join('\n'),
      '  \n  ',
      '',
    ]) {
      await textbox.fill(value)
      await textbox.evaluate((element) => element.blur())
      // Let both ResizeObserver and the adaptive sizing frame settle.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
      )
      expect(await heights()).toEqual(initial)
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    await expect(textbox).toHaveAttribute('aria-invalid', 'false')
    await expect(download).toBeDisabled()
    await textbox.fill('https://example.com/dir\\file.zip')
    await page.getByRole('button', { name: /^Line 1:/ }).click()
    await page
      .getByRole('button', { name: 'Encode as literal characters' })
      .click()
    const undo = page.getByRole('button', { name: 'Undo URL correction' })
    await expect(undo).toBeVisible()
    expect(await heights()).toEqual(initial)
    await page.screenshot({
      path: testInfo.outputPath('url-editor-corrected.png'),
    })
    await undo.click()
    expect(await heights()).toEqual(initial)
    const advanced = page.getByRole('button', { name: 'Advanced', exact: true })
    await advanced.click()
    await expect
      .poll(() => page.evaluate(() => innerHeight))
      .toBeGreaterThan(initial.window)
    await advanced.click()
    await expect
      .poll(() => page.evaluate(() => innerHeight))
      .toBe(initial.window)
  })

  test('URL editor highlights tokens and keeps diagnostics aligned through wrapping, scrolling and resizing', async ({
    electronApp,
    mainWindow,
  }, testInfo) => {
    await waitForEngineReady(mainWindow)
    await mainWindow.getByRole('button', { name: 'New task' }).click()
    const page = await findAddTaskWindow(electronApp)
    await page.bringToFront()
    const textbox = page.getByRole('textbox', { name: 'URLs' })
    const marker = page.getByRole('button', {
      name: 'Line 1: This URL protocol is not supported for this download.',
    })
    const sample =
      'htps://exmaple.com\nhttps://example.com/file.zip\nftp://files.example.com/archive.zip\nhttps://example.com/video.mp4'
    await textbox.fill(sample)
    await textbox.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await textbox.evaluate((element) => element.blur())
    await expect(page.locator('.url-editor-error')).toHaveText('htps')
    await expect(
      page.getByRole('button', { name: 'Download', exact: true })
    ).toBeEnabled()
    await page.mouse.move(8, 80)
    await marker.hover()
    await expect(page.getByRole('tooltip')).toHaveText(
      'Line 1: This URL protocol is not supported for this download.'
    )
    await page.screenshot({ path: testInfo.outputPath('url-editor-hover.png') })
    await marker.click()
    await expect(textbox).toBeFocused()
    expect(
      await textbox.evaluate((element: HTMLTextAreaElement) =>
        element.value.slice(element.selectionStart, element.selectionEnd)
      )
    ).toBe('htps')
    await page.keyboard.insertText('https')
    await expect(marker).toHaveCount(0)
    await textbox.press('ControlOrMeta+z')
    await expect(textbox).toHaveValue(sample)

    const longUrl = `htps://example.com/${'segment-'.repeat(19)}file.zip`
    await textbox.fill(
      [
        longUrl,
        ...Array.from(
          { length: 16 },
          (_, index) => `https://example.com/${index}`
        ),
      ].join('\n')
    )
    // Native fill places the caret at the end and scrolls there.
    await textbox.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await expect(marker).toBeVisible()
    const measure = () =>
      page.evaluate(() => {
        const textarea = document.querySelector('textarea')!
        const mirror =
          document.querySelector<HTMLElement>('.url-editor-mirror')!
        const row = mirror.querySelector<HTMLElement>('[data-url-line="0"]')!
        const icon = document.querySelector<HTMLElement>(
          '[data-url-diagnostic="0"]'
        )!
        const lineHeight = Number.parseFloat(
          getComputedStyle(textarea).lineHeight
        )
        const rowRect = row.getBoundingClientRect()
        const iconRect = icon?.getBoundingClientRect()
        return {
          lineHeight,
          rows: rowRect.height / lineHeight,
          centerDifference: iconRect
            ? Math.abs(
                iconRect.y +
                  iconRect.height / 2 -
                  (rowRect.bottom - lineHeight / 2)
              )
            : Number.POSITIVE_INFINITY,
          nativeHeight: textarea.scrollHeight,
          mirrorHeight: mirror.offsetHeight,
          rightGap: iconRect
            ? textarea.getBoundingClientRect().right - iconRect.right
            : 0,
          lastLineY:
            rowRect.bottom -
            lineHeight / 2 -
            textarea.getBoundingClientRect().top,
        }
      })
    await expect
      .poll(async () => (await measure()).centerDifference)
      .toBeLessThan(1)
    const initial = await measure()
    expect(initial.rows).toBeGreaterThan(1)
    expect(initial.nativeHeight).toBe(initial.mirrorHeight)
    expect(initial.rightGap).toBeGreaterThanOrEqual(24)
    // Hit-test against the real native textarea, not only mirror geometry.
    await textbox.click({ position: { x: 16, y: initial.lastLineY } })
    const cursor = await textbox.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart
    )
    expect(cursor).toBeGreaterThan(0)
    expect(cursor).toBeLessThan(longUrl.length)
    await textbox.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = 22
      element.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(async () => (await measure()).centerDifference)
      .toBeLessThan(1)
    await textbox.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    await expect(marker).toHaveCount(0)
    await textbox.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('w=add-task')
      )!
      window.setMinimumSize(420, 400)
      window.setSize(440, 640)
    })
    await expect
      .poll(async () => (await measure()).rows)
      .toBeGreaterThan(initial.rows)
    // The compact editor scrolls to reach the final row of a long URL.
    await textbox.evaluate((textarea: HTMLTextAreaElement) => {
      const row = document.querySelector<HTMLElement>('[data-url-line="0"]')!
      textarea.scrollTop = Math.max(
        0,
        row.offsetTop + row.offsetHeight + 12 - textarea.clientHeight
      )
      textarea.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(async () => (await measure()).centerDifference)
      .toBeLessThan(1)
    const narrow = await measure()
    expect(narrow.nativeHeight).toBe(narrow.mirrorHeight)
    expect(narrow.rightGap).toBeGreaterThanOrEqual(24)
    await marker.hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    const tooltipBounds = await page.getByRole('tooltip').boundingBox()
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))
    expect(tooltipBounds!.x).toBeGreaterThanOrEqual(0)
    expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(
      viewport.width
    )
    await page.screenshot({
      path: testInfo.outputPath('url-editor-wrapped.png'),
    })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: testInfo.outputPath('url-editor-dark.png') })
    // A short hash expands on blur and wraps in this narrow window. Clicking
    // another line's correction must still hit its icon and edit that line.
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    await textbox.fill(`${hash}\nhttps://example.com/dir\\file`)
    await page.getByRole('button', { name: /^Line 2:/ }).click()
    await page
      .getByRole('button', { name: 'Encode as literal characters' })
      .click()
    await expect(textbox).toHaveValue(
      `magnet:?xt=urn:btih:${hash}\nhttps://example.com/dir%5Cfile`
    )
  })

  test('partial URL submission retains invalid input and correction is reversible', async ({
    electronApp,
    mainWindow,
    httpFixture,
  }) => {
    await waitForEngineReady(mainWindow)
    await mainWindow.getByRole('button', { name: 'New task' }).click()
    const page = await findAddTaskWindow(electronApp)
    const textbox = page.getByRole('textbox', { name: 'URLs' })
    const invalid = 'https://example.test/dir\\file?sig=%2f+%252F'
    await textbox.fill(`${httpFixture.fileUrl}\n${invalid}`)
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    try {
      await expect(textbox).toHaveValue(invalid)
      await expect
        .poll(
          async () =>
            (
              (await mainWindow.evaluate(
                (channel) => window.motrix.invoke(channel),
                Queries.ListTasks
              )) as DownloadTask[]
            ).length
        )
        .toBe(1)
      await page.getByRole('button', { name: /^Line 1:/ }).click()
      await page
        .getByRole('button', { name: 'Encode as literal characters' })
        .click()
      await expect(textbox).toHaveValue(
        'https://example.test/dir%5Cfile?sig=%2f+%252F'
      )
      await page.getByRole('button', { name: 'Undo URL correction' }).click()
      await expect(textbox).toHaveValue(invalid)
      await expect(
        page.getByRole('button', { name: 'Download', exact: true })
      ).toBeDisabled()
    } finally {
      await removeAllTasks(mainWindow).catch(() => undefined)
    }
  })

  for (const { input, hash } of [
    {
      input: 'A03E3F9A05341AA336E9D9D3F06B33CDDAFE0BDC',
      hash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    },
    {
      input: 'ua7d7gqfgqnkgnxj3hj7a2ztzxnp4c64',
      hash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    },
  ]) {
    test(`bare ${input.length}-character info hash creates a magnet task`, async ({
      electronApp,
      mainWindow,
    }) => {
      await waitForEngineReady(mainWindow)
      await mainWindow.getByRole('button', { name: 'New task' }).click()
      const addTaskPage = await findAddTaskWindow(electronApp)
      await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(input)
      await expect(
        addTaskPage.getByText('1 URL', { exact: true })
      ).toBeVisible()

      try {
        await addTaskPage.getByRole('button', { name: 'Download' }).click()
        await expect
          .poll(async () => {
            const tasks = (await mainWindow.evaluate(async (channel) => {
              return window.motrix.invoke(channel)
            }, Queries.ListTasks)) as DownloadTask[]
            const task = tasks.find((entry) => entry.infoHash === hash)
            return task
              ? {
                  type: task.type,
                  hasEngineTask: Boolean(task.engineTaskId),
                  failed: task.status === TaskStatus.Error,
                }
              : null
          })
          .toEqual({
            type: TaskType.Magnet,
            hasEngineTask: true,
            failed: false,
          })
      } finally {
        // No peers serve this test hash; remove its pending metadata task.
        await removeAllTasks(mainWindow).catch(() => undefined)
      }
    })
  }

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
    const row = mainWindow
      .locator('[data-task-id]')
      .filter({ hasText: 'test.bin' })
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
        mainWindow.locator('[data-task-id]').filter({ hasText: 'beta.bin' })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        mainWindow.locator('[data-task-id]').filter({ hasText: 'gamma.bin' })
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        mainWindow.locator('[data-task-id]').filter({ hasText: 'alpha.bin' })
      ).toHaveCount(0)
    } finally {
      // These unreachable-tracker one-byte tasks intentionally remain active.
      // Remove them so aria2 has no live BT jobs keeping E2E teardown open.
      await removeAllTasks(mainWindow).catch(() => undefined)
    }
  })
})
