import type { ElectronApplication, Locator } from '@playwright/test'
import { DownloadErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type DownloadTask,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { makeMediaProgress } from '../src/test-utils/media-progress'
import { makeDownloadTask } from '../src/test-utils/task'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import {
  setTaskInspectorContentSize,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'

function makeTasks(count: number): DownloadTask[] {
  return Array.from({ length: count }, (_, index) => {
    const active = index >= count - 4
    return makeDownloadTask({
      id: `visibility-${index}`,
      name: `${active ? 'Active tail' : 'Completed history'} ${index}.bin`,
      status: active ? TaskStatus.Downloading : TaskStatus.Completed,
      progress: active ? 0.995 : 1,
      totalBytes: 1_000_000,
      sizeWhenDone: 1_000_000,
      downloadedBytes: active ? 995_000 : 1_000_000,
      downloadSpeed: active ? 64_000 : 0,
      connections: active ? 1 : 0,
      fileCount: 1,
    })
  })
}

async function publish(app: ElectronApplication, tasks: DownloadTask[]) {
  await app.evaluate(
    ({ webContents }, payload) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed())
          contents.send(payload.channel, payload.tasks)
      }
    },
    { channel: Events.TaskUpdated, tasks }
  )
}

async function expectUsable(row: Locator) {
  await expect(row).toBeVisible()
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const list = element.closest('[data-testid="virtual-list-container"]')
        const headerRow = list?.querySelector('[role="row"]')
        if (!list || !headerRow) return false
        const rect = element.getBoundingClientRect()
        const viewport = list.getBoundingClientRect()
        const header = headerRow.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + 120,
          rect.top + rect.height / 2
        )
        return (
          rect.top >= header.bottom - 1 &&
          rect.bottom <= viewport.bottom + 1 &&
          hit?.closest('[data-task-id]') === element
        )
      })
    )
    .toBe(true)
}

async function expectDrawerSettled(drawer: Locator) {
  await expect
    .poll(() =>
      drawer.evaluate((element) => {
        const style = getComputedStyle(element)
        const offset =
          Number.parseFloat(
            style.getPropertyValue('--drawer-snap-point-offset')
          ) || 0
        return (
          !element.hasAttribute('data-starting-style') &&
          !element
            .getAnimations()
            .some((animation) => animation.playState === 'running') &&
          Math.abs(new DOMMatrixReadOnly(style.transform).m42 - offset) < 0.5
        )
      })
    )
    .toBe(true)
}

test('media task progress follows segments, then the processing stage, until the output is saved', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await mainWindow.emulateMedia({ reducedMotion: 'reduce' })
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const task = makeDownloadTask({
    id: 'media-progress',
    name: 'Progress.mp4',
    kind: TaskKind.Hls,
    status: TaskStatus.Downloading,
    progress: 1,
    totalBytes: 100,
    downloadedBytes: 100,
    mediaProgress: makeMediaProgress(),
  })
  await publish(electronApp, [task])
  const row = mainWindow.locator('[data-task-id="media-progress"]')
  await expect(row.getByText('Downloading 0.1%', { exact: true })).toBeVisible()
  await expect(row.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '0.1'
  )
  await mainWindow
    .getByRole('button', { name: 'List View', exact: true })
    .click()
  await mainWindow
    .getByRole('menuitemcheckbox', { name: 'Status', exact: true })
    .click()
  await mainWindow.keyboard.press('Escape')
  await expect(row.getByText('Downloading 0.1%', { exact: true })).toBeVisible()
  const completeDownload = {
    progress: 1,
    completedParts: 1000,
    totalParts: 1000,
    totalBytes: null,
  }
  task.mediaProgress = makeMediaProgress({
    phase: 'muxing',
    download: completeDownload,
  })
  await publish(electronApp, [task])
  await expect(row.getByText('Merging —', { exact: true })).toBeVisible()
  await expect(row.getByRole('progressbar')).not.toHaveAttribute(
    'aria-valuenow'
  )
  task.mediaProgress = { ...task.mediaProgress, muxProgress: 0.42 }
  await publish(electronApp, [task])
  await expect(row.getByText('Merging 42%', { exact: true })).toBeVisible()
  await row.dblclick()
  const inspector = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await expect(
    inspector.getByText('Download progress', { exact: true })
  ).toBeVisible()
  await expect(inspector.getByText('100%', { exact: true })).toBeVisible()
  await expect(inspector.getByText('42%', { exact: true })).toBeVisible()
  await expect(
    inspector.getByText('1000 / 1000 segments', { exact: true })
  ).toBeVisible()
  await expect(
    inspector.getByRole('button', { name: 'Pause', exact: true })
  ).toHaveCount(0)
  await inspector
    .getByRole('separator', { name: 'Resize Inspector' })
    .press('End')
  await expectDrawerSettled(inspector)
  await mainWindow.screenshot({
    path: testInfo.outputPath('media-mux-progress.png'),
    animations: 'disabled',
  })
  await setTaskInspectorContentSize(electronApp, mainWindow, 914, 640)
  await expectDrawerSettled(inspector)
  await inspector
    .getByText('Download progress', { exact: true })
    .scrollIntoViewIfNeeded()
  expect(
    await mainWindow.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await mainWindow.screenshot({
    path: testInfo.outputPath('media-mux-progress-compact.png'),
    animations: 'disabled',
  })

  task.status = TaskStatus.Finalizing
  task.mediaProgress = {
    ...task.mediaProgress,
    phase: 'renaming',
    muxProgress: 1,
  }
  await publish(electronApp, [task])
  await expect(
    inspector.getByText('Saving', { exact: true }).first()
  ).toBeVisible()
  await expect(inspector.getByText('Completed', { exact: true })).toHaveCount(0)
  task.status = TaskStatus.Completed
  task.mediaProgress = { ...task.mediaProgress, outputBytes: 2_000_000 }
  task.sizeWhenDone = 2_000_000
  await publish(electronApp, [task])
  await expect(
    inspector.getByText('Completed', { exact: true }).first()
  ).toBeVisible()
  await expect(inspector.getByText('2.00 MB', { exact: true })).toBeVisible()
})

test('media file list shows every segment through virtual scrolling and stays read-only', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await electronApp.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () =>
      Array.from({ length: 2000 }, (_, index) => ({
        index,
        path:
          index === 0
            ? 'video/init.mp4'
            : index === 1999
              ? 'audio/001000.aac'
              : `video/${String(index).padStart(6, '0')}.ts`,
        size: index < 2 ? 1000 : 0,
        selected: true,
        completedBytes: index === 0 ? 1000 : index === 1 ? 500 : 0,
        progress: index === 0 ? 1 : index === 1 ? 0.5 : 0,
      }))
    )
  }, Queries.GetTaskFiles)
  const task = makeDownloadTask({
    id: 'hls-segments',
    name: 'Playlist.mp4',
    kind: TaskKind.Hls,
    status: TaskStatus.Downloading,
    progress: 0.25,
    fileCount: 1,
  })
  await publish(electronApp, [task])
  await mainWindow.locator('[data-task-id="hls-segments"]').dblclick()
  const inspector = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await inspector.getByRole('tab', { name: 'Files', exact: true }).click()
  const list = inspector.getByTestId('virtual-list-container')
  await expect(list.getByText('video/init.mp4', { exact: true })).toBeVisible()
  await expect(list.getByText('100%', { exact: true })).toBeVisible()
  await expect(list.getByText('50%', { exact: true })).toBeVisible()
  expect(await list.getByRole('checkbox').count()).toBeLessThan(50)
  await expect(list.getByRole('checkbox').first()).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  await expect(
    inspector.getByRole('button', { name: 'Save', exact: true })
  ).toHaveCount(0)
  await mainWindow.screenshot({
    path: testInfo.outputPath('media-segments.png'),
  })

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(
    list.getByText('audio/001000.aac', { exact: true })
  ).toBeVisible()
  expect(await list.getByRole('checkbox').count()).toBeLessThan(50)
  expect(
    await mainWindow.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight
    )
  ).toBe(true)
  await mainWindow.screenshot({
    path: testInfo.outputPath('media-segments-last.png'),
  })
})

test('download columns sort live tasks without losing selection or filter state', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const tasks = [10, 1, 2].map((index) =>
    makeDownloadTask({
      id: `sorting-${index}`,
      name: `File ${index}.bin`,
      status: index === 10 ? TaskStatus.Completed : TaskStatus.Downloading,
      sizeWhenDone: index * 1_000_000,
      totalBytes: index * 1_000_000,
      downloadSpeed: index * 1_000,
      etaSeconds: index * 60,
      createdAt: Date.parse('2026-09-13T01:00:00Z') + index * 3_600_000,
      finishedAt: index === 10 ? Date.parse('2026-09-13T12:30:00Z') : null,
    })
  )
  await publish(electronApp, tasks)
  const list = mainWindow.getByTestId('virtual-list-container')
  const rows = list.locator('[data-task-id]')
  await expect(rows).toHaveCount(3)
  const expectOrder = async (indices: number[]) => {
    await expect(rows).toHaveText(
      indices.map((index) => new RegExp(`File ${index}\\.bin`))
    )
  }
  await expectOrder([10, 2, 1])
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(0)
  await list.getByRole('button', { name: 'Name', exact: true }).hover()
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(0)
  await list.getByRole('row', { name: /File 2\.bin/ }).click()
  await list.getByRole('button', { name: 'Name', exact: true }).click()
  await expectOrder([1, 2, 10])
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(1)
  await expect(list.getByRole('row', { name: /File 2\.bin/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await list
    .getByRole('row', { name: /File 10\.bin/ })
    .click({ modifiers: ['Shift'] })
  await expect(list.getByRole('row', { name: /File 1\.bin/ })).toHaveAttribute(
    'aria-selected',
    'false'
  )
  await expect(list.getByRole('row', { name: /File 10\.bin/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  await list.getByRole('button', { name: 'Size', exact: true }).focus()
  await mainWindow.keyboard.press('Space')
  await expectOrder([10, 2, 1])
  await expect(list.getByRole('row', { name: /File 1\.bin/ })).toHaveAttribute(
    'aria-selected',
    'false'
  )
  await mainWindow.keyboard.press('Enter')
  await expectOrder([1, 2, 10])
  await mainWindow.keyboard.press('Enter')
  await expectOrder([10, 2, 1])
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(1)
  await mainWindow
    .getByRole('button', { name: 'List View', exact: true })
    .click()
  await mainWindow
    .getByRole('menuitem', { name: 'Restore default order', exact: true })
    .click()
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(0)

  await list.getByRole('button', { name: 'Date created', exact: true }).click()
  await expectOrder([10, 2, 1])
  await expect(list.locator('button[aria-pressed] svg')).toHaveCount(1)
  await list
    .getByRole('button', { name: 'Date created: descending', exact: true })
    .click()
  await expectOrder([1, 2, 10])
  await list
    .getByRole('button', { name: 'Date completed', exact: true })
    .click()
  await expectOrder([10, 1, 2])
  await expect(rows.locator('time')).toHaveCount(4)
  await expect(
    list
      .getByRole('row', { name: /File 10\.bin/ })
      .locator('time')
      .last()
  ).toHaveAttribute('datetime', '2026-09-13T12:30:00.000Z')
  await expect(
    list.getByRole('row', { name: /File 1\.bin/ }).locator('time')
  ).toHaveCount(1)
  await expect
    .poll(() =>
      mainWindow.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    )
    .toBe(true)

  await setTaskInspectorContentSize(electronApp, mainWindow, 1660, 900)
  await list.evaluate((element) => {
    element.scrollLeft = 0
  })
  await mainWindow.screenshot({
    path: testInfo.outputPath('sorted-timestamps.png'),
    animations: 'disabled',
  })
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)

  await list
    .getByRole('button', { name: 'Download speed', exact: true })
    .click()
  await expectOrder([2, 1, 10])
  tasks[1] = { ...tasks[1], downloadSpeed: 50_000 }
  await publish(electronApp, tasks)
  await expectOrder([1, 2, 10])
  await expect(list.getByRole('row', { name: /File 1\.bin/ })).toContainText(
    '50.0 KB/s'
  )
  await mainWindow
    .getByRole('button', { name: 'List View', exact: true })
    .click()
  const etaColumn = mainWindow.getByRole('menuitemcheckbox', {
    name: 'ETA',
    exact: true,
  })
  if ((await etaColumn.getAttribute('aria-checked')) !== 'true')
    await etaColumn.click()
  await mainWindow.keyboard.press('Escape')
  await list.getByRole('button', { name: 'ETA', exact: true }).click()
  await expectOrder([1, 2, 10])
  await list
    .getByRole('button', { name: 'ETA: ascending', exact: true })
    .click()
  await expectOrder([2, 1, 10])

  await mainWindow
    .getByRole('button', { name: 'All Downloads', exact: true })
    .click()
  await mainWindow.getByRole('menuitem', { name: /^Active/ }).click()
  await expectOrder([2, 1])
  await expect(
    list.getByRole('button', { name: 'ETA: descending', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await testInfo.attach('sorted-downloads', {
    body: await mainWindow.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
})

test('remembers a manual sort across app restarts and clears it when restoring the default', async ({
  userDataDir,
  rpcPort,
}) => {
  let app = await launchMotrix({ userDataDir, rpcPort })
  const tasks = [
    makeDownloadTask({ id: 'older', name: 'Alpha.bin', createdAt: 1_000 }),
    makeDownloadTask({ id: 'newer', name: 'Beta.bin', createdAt: 2_000 }),
  ]
  const openDownloads = async () => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForEngineReady(page)
    await page.getByRole('link', { name: 'Downloads', exact: true }).click()
    await expect(page.getByTestId('downloads-loading')).toHaveCount(0)
    await publish(app, tasks)
    const list = page.getByTestId('virtual-list-container')
    await expect(list.locator('[data-task-id]')).toHaveCount(tasks.length)
    return list
  }
  try {
    let list = await openDownloads()
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Beta.bin/,
      /Alpha.bin/,
    ])
    await list.getByRole('button', { name: 'Name', exact: true }).click()
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Alpha.bin/,
      /Beta.bin/,
    ])
    const page = list.page()
    const nameHeader = list.getByRole('button', {
      name: 'Name: ascending',
      exact: true,
    })
    await list.getByRole('button', { name: 'Size', exact: true }).hover()
    const target = await nameHeader.boundingBox()
    if (!target) throw new Error('Name header is not laid out')
    await page.mouse.down()
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height / 2,
      { steps: 12 }
    )
    // Chromium's HTML dragover requires a second move at the destination.
    await page.mouse.move(
      target.x + target.width / 2 + 1,
      target.y + target.height / 2
    )
    await page.mouse.up()
    await expect(list.getByRole('columnheader').first()).toContainText('Size')
    const nameResize = list.getByRole('separator', {
      name: 'Resize Name column',
    })
    await nameResize.focus()
    await nameResize.press('ArrowRight')
    await page.getByRole('button', { name: 'List View', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Date completed' }).click()
    await page.keyboard.press('Escape')
    await list.locator('[data-task-id]').first().click()
    await page
      .getByRole('button', { name: 'Show Inspector', exact: true })
      .click()
    await page
      .getByRole('separator', { name: 'Resize Inspector' })
      .press('Home')
    await app.close()

    app = await launchMotrix({ userDataDir, rpcPort })
    list = await openDownloads()
    await expect(list.getByRole('columnheader').first()).toContainText('Size')
    await expect(
      list.getByRole('separator', { name: 'Resize Name column' })
    ).toHaveAttribute('aria-valuenow', '256')
    await expect(
      list.getByRole('button', { name: 'Date completed', exact: true })
    ).toHaveCount(0)
    await expect(
      list.page().getByRole('dialog', { name: 'Task Inspector' })
    ).toBeHidden()
    await expect(
      list.page().getByRole('button', { name: 'Show Inspector', exact: true })
    ).toBeDisabled()
    await list.locator('[data-task-id]').first().click()
    await expect(
      list.page().getByRole('dialog', { name: 'Task Inspector' })
    ).toBeHidden()
    await list
      .page()
      .getByRole('button', { name: 'Show Inspector', exact: true })
      .click()
    await expect(
      list.page().getByRole('dialog', { name: 'Task Inspector' })
    ).toBeVisible()
    await expect(
      list.page().getByRole('separator', { name: 'Resize Inspector' })
    ).toHaveAttribute('aria-valuenow', '220')
    await expect(
      list.getByRole('button', { name: 'Name: ascending', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Alpha.bin/,
      /Beta.bin/,
    ])
    tasks.push(
      makeDownloadTask({ id: 'latest', name: 'Gamma.bin', createdAt: 3_000 })
    )
    await publish(app, tasks)
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Alpha.bin/,
      /Beta.bin/,
      /Gamma.bin/,
    ])
    await list
      .getByRole('button', { name: 'Name: ascending', exact: true })
      .click()
    await list
      .getByRole('button', { name: 'Name: descending', exact: true })
      .click()
    await list
      .page()
      .getByRole('button', { name: 'List View', exact: true })
      .click()
    await list
      .page()
      .getByRole('menuitem', { name: 'Restore default order', exact: true })
      .click()
    await expect(list.locator('button[aria-pressed] svg')).toHaveCount(0)
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Gamma.bin/,
      /Beta.bin/,
      /Alpha.bin/,
    ])
    await app.close()

    app = await launchMotrix({ userDataDir, rpcPort })
    list = await openDownloads()
    await expect(list.locator('button[aria-pressed] svg')).toHaveCount(0)
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Gamma.bin/,
      /Beta.bin/,
      /Alpha.bin/,
    ])
    tasks.push(
      makeDownloadTask({ id: 'newest', name: 'Delta.bin', createdAt: 4_000 })
    )
    await publish(app, tasks)
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Delta.bin/,
      /Gamma.bin/,
      /Beta.bin/,
      /Alpha.bin/,
    ])
  } finally {
    await app.close().catch(() => {})
  }
})

for (const { count, width, height, zoom } of [
  { count: 26, width: 1280, height: 900, zoom: 1 },
  { count: 200, width: 1000, height: 600, zoom: 1 },
  { count: 26, width: 1000, height: 667, zoom: 1.5 },
]) {
  test(`all downloads keeps tail tasks reachable with ${count} tasks at ${zoom}x DPI`, async ({
    electronApp,
    mainWindow,
  }, testInfo) => {
    await expect(async () => waitForEngineReady(mainWindow)).toPass({
      timeout: 30_000,
    })
    await setTaskInspectorContentSize(electronApp, mainWindow, width, height)
    const cdp = await mainWindow.context().newCDPSession(mainWindow)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: zoom,
      mobile: false,
    })
    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
    const tasks = makeTasks(count)
    await publish(electronApp, tasks)
    await expect(
      mainWindow.getByText(`${count}/${count}`, { exact: true })
    ).toBeVisible()
    const list = mainWindow.getByTestId('virtual-list-container')
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const tail = mainWindow.getByRole('row', {
      name: new RegExp(`Active tail ${count - 1}\\.bin`),
    })
    await expectUsable(tail)
    await expect(tail).toContainText('99%')
    await tail.click({ position: { x: 120, y: 18 } })
    const listBox = await list.boundingBox()
    await mainWindow
      .getByRole('button', { name: 'Show Inspector', exact: true })
      .click()
    const drawer = mainWindow.getByRole('dialog', {
      name: 'Task Inspector',
      exact: true,
    })
    await expect(drawer).toBeVisible()
    await expectDrawerSettled(drawer)
    expect(await list.boundingBox()).toEqual(listBox)

    await testInfo.attach('all-downloads-with-inspector', {
      body: await mainWindow.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })

    await drawer.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(tail).toHaveAttribute('aria-selected', 'true')
    await expectUsable(tail)

    // Same task moves from the last row of All to the fourth row of Active.
    // Returning must reveal it again even though the list remounts.
    await mainWindow
      .getByRole('button', { name: 'All Downloads', exact: true })
      .click()
    await mainWindow.getByRole('menuitem', { name: /^Active/ }).click()
    await expectUsable(tail)
    await mainWindow
      .getByRole('button', { name: 'Active Downloads', exact: true })
      .click()
    await mainWindow.getByRole('menuitem', { name: /^All/ }).click()
    await expectUsable(tail)

    // A manually scrolled-away focused row stays mounted for ARIA without
    // forcing the user's viewport back to it.
    if (count === 200) {
      // Finish closing the title menu before simulating a manual list scroll.
      await expect(mainWindow.getByRole('menu')).toHaveCount(0)
      await list.evaluate((element) => {
        element.scrollTop = 0
      })
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(0)
      const grid = mainWindow.locator('[data-downloads-grid]')
      const activeId = await grid.getAttribute('aria-activedescendant')
      expect(
        await mainWindow.evaluate(
          (id) => !!id && document.getElementById(id) !== null,
          activeId
        )
      ).toBe(true)
    }

    // Data updates must keep every task reachable without a route change.
    const added = makeDownloadTask({
      ...tasks.at(-1)!,
      id: 'new-tail',
      name: 'New active tail.bin',
    })
    await publish(electronApp, [...tasks, added])
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expectUsable(
      mainWindow.getByRole('row', { name: /New active tail\.bin/ })
    )
    await expect
      .poll(() =>
        mainWindow.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight
        )
      )
      .toBe(true)
  })
}

test('clears selection with modifier clicks, Escape and list whitespace', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1000, 672)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await publish(
    electronApp,
    [0, 1, 2].map((index) =>
      makeDownloadTask({
        id: `deselect-${index}`,
        name: `Deselect ${index}.bin`,
        createdAt: 3_000 - index,
        status: TaskStatus.Paused,
      })
    )
  )
  const grid = mainWindow.getByRole('grid', { name: 'Downloads' })
  const rows = grid.locator('[data-task-id]')
  const selected = grid.locator('[data-task-id][aria-selected="true"]')
  await expect(rows).toHaveCount(3)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await rows.nth(0).click()
  await rows.nth(0).click()
  await expect(selected).toHaveCount(1)
  await rows.nth(0).click({ modifiers: [modifier] })
  await expect(selected).toHaveCount(0)
  await rows.nth(0).click()
  await rows.nth(1).click({ modifiers: [modifier] })
  await rows.nth(0).click({ modifiers: [modifier] })
  await expect(selected).toHaveText([/Deselect 1/])
  const focusedRow = await grid.getAttribute('aria-activedescendant')
  await mainWindow.keyboard.press('Escape')
  await expect(selected).toHaveCount(0)
  await expect(grid).toBeFocused()
  await expect(grid).toHaveAttribute('aria-activedescendant', focusedRow!)
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
  await expect(grid).toHaveCSS('outline-style', 'none')
  await expect(rows.nth(0)).toHaveCSS('outline-style', 'none')
  await mainWindow.keyboard.press('Escape')
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
  await mainWindow.screenshot({
    path: testInfo.outputPath('pointer-escape-no-focus-ring.png'),
  })

  // The grid retains DOM focus so arrow navigation can resume immediately.
  await mainWindow.keyboard.press('ArrowDown')
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'true')
  await expect(grid).toHaveCSS('outline-style', 'solid')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(rows.nth(1)).toHaveCSS('outline-style', 'solid')
  await mainWindow.keyboard.press('Escape')
  await expect(selected).toHaveCount(0)
  await expect(grid).toHaveCSS('outline-style', 'solid')
  await mainWindow.screenshot({
    path: testInfo.outputPath('keyboard-escape-preserves-focus-ring.png'),
  })
  await rows.nth(0).click()
  await mainWindow.keyboard.press('Escape')
  await expect(grid).toHaveCSS('outline-style', 'none')

  await mainWindow.keyboard.press(`${modifier}+a`)
  await expect(selected).toHaveCount(3)
  await grid.getByRole('button', { name: 'Name', exact: true }).click()
  await expect(selected).toHaveCount(3)
  const last = (await rows.last().boundingBox())!
  const blank = { x: last.x + 100, y: last.y + last.height + 30 }
  await mainWindow.keyboard.down(modifier)
  await mainWindow.mouse.click(blank.x, blank.y)
  await mainWindow.keyboard.up(modifier)
  await expect(selected).toHaveCount(3)
  await mainWindow.mouse.click(blank.x, blank.y)
  await expect(selected).toHaveCount(0)
  await expect(grid).toBeFocused()
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'false')

  // Native menu selection must be just as easy to clear without a keyboard.
  await electronApp.evaluate(({ Menu, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('w=main')
    )
    const item = Menu.getApplicationMenu()?.getMenuItemById(
      'menubar.task.selectAll'
    )
    if (!main || !item?.enabled) throw new Error('Task Select All unavailable')
    item.click({}, main, main.webContents)
  })
  await expect(selected).toHaveCount(3)
  await mainWindow.mouse.click(blank.x, blank.y)
  await expect(selected).toHaveCount(0)
})

test('opens details by double click and keeps selection separate from inspector visibility', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await publish(
    electronApp,
    [TaskStatus.Paused, TaskStatus.Completed].map((status, index) =>
      makeDownloadTask({
        id: `details-${index}`,
        name: `Details ${index}.bin`,
        createdAt: 3_000 - index,
        status,
      })
    )
  )
  const grid = mainWindow.getByRole('grid', { name: 'Downloads' })
  const rows = grid.locator('[data-task-id]')
  const selected = grid.locator('[data-task-id][aria-selected="true"]')
  const drawer = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  const more = mainWindow.getByRole('button', { name: 'More' })
  const content = mainWindow.getByTestId('task-inspector-drawer-content')
  await expect(rows).toHaveCount(2)
  await expect(more).toBeEnabled()
  const listBounds = await grid.boundingBox()
  await rows.nth(0).click()
  await expect(drawer).toHaveCount(0)
  await rows.nth(1).click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(2)
  await expect(drawer).toHaveCount(0)
  await rows.nth(1).dblclick()
  await expect(selected).toHaveText([/Details 1/])
  await expect(
    content.getByText('Details 1.bin', { exact: true })
  ).toBeVisible()
  await expectDrawerSettled(drawer)
  expect(await grid.boundingBox()).toEqual(listBounds)
  const handle = drawer.getByRole('separator', { name: 'Resize Inspector' })
  const viewportHeight = await drawer.evaluate(
    (element) =>
      element.closest('[data-slot="drawer-viewport"]')!.getBoundingClientRect()
        .height
  )
  await expect(handle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(viewportHeight * 0.5))
  )
  await handle.press('End')
  await expectDrawerSettled(drawer)
  await expect(handle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(viewportHeight * 0.75))
  )
  await rows.nth(0).click()
  await expect(
    content.getByText('Details 0.bin', { exact: true })
  ).toBeVisible()
  await rows.nth(0).dblclick()
  await expect(drawer).toBeVisible()
  await expect(handle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(viewportHeight * 0.75))
  )
  await testInfo.attach('inspector-open', {
    body: await mainWindow.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await grid.press('Escape')
  await expect(selected).toHaveCount(0)
  await expect(drawer).toBeHidden()
  await expect(
    mainWindow.getByRole('button', { name: 'Show Inspector', exact: true })
  ).toBeDisabled()
  await testInfo.attach('inspector-selection-cleared', {
    body: await mainWindow.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await rows.nth(0).click()
  await expect(drawer).toBeHidden()
  await testInfo.attach('inspector-reselected-stays-closed', {
    body: await mainWindow.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await rows.nth(0).dblclick()
  await expect(drawer).toBeVisible()
  await expect(handle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(viewportHeight * 0.75))
  )
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(selected).toHaveText([/Details 0/])
  await rows.nth(1).click()
  await expect(drawer).toHaveCount(0)
  await rows.nth(1).dblclick()
  await expect(handle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(viewportHeight * 0.75))
  )
  await handle.press('Home')
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await mainWindow.getByRole('menuitem', { name: 'Show Inspector' }).click()
  await expect(handle).toHaveAttribute('aria-valuenow', '220')
  await expect(selected).toHaveText([/Details 1/])
})

test('marquee selection survives row feedback, data updates and blank-space drags', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1000, 672)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const tasks = Array.from({ length: 8 }, (_, index) =>
    makeDownloadTask({
      id: `marquee-${index}`,
      name: `Marquee ${index}.bin`,
      createdAt: 8_000 - index,
      status: TaskStatus.Paused,
    })
  )
  await publish(electronApp, tasks)
  const grid = mainWindow.locator('[data-downloads-grid]')
  const rows = grid.locator('[data-task-id]')
  await expect(rows).toHaveCount(8)
  const first = (await rows.nth(0).boundingBox())!
  const start = { x: first.x + 100, y: first.y + 18 }
  await mainWindow.mouse.move(start.x, start.y)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(start.x + 40, start.y + 36, { steps: 4 })
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(2)
  await publish(
    electronApp,
    tasks.map((task) => ({ ...task, downloadSpeed: 12_000 }))
  )
  await mainWindow.mouse.move(start.x + 100, start.y + 108, { steps: 8 })
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(4)
  await expect(grid.getByTestId('marquee-box')).toHaveCSS('opacity', '1')
  await mainWindow.screenshot({
    path: testInfo.outputPath('marquee-row-selection.png'),
  })
  await mainWindow.mouse.up()
  await expect(grid.getByTestId('marquee-box')).toHaveCSS('opacity', '0')
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(4)
  await mainWindow.keyboard.press('Escape')
  const last = (await rows.nth(7).boundingBox())!
  await mainWindow.mouse.move(start.x + 160, last.y + last.height + 30)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(start.x + 60, start.y + 4 * 36, { steps: 12 })
  await expect(grid.locator('[aria-selected="true"]')).toHaveCount(4)
  await mainWindow.mouse.up()
  await expect(grid.locator('[aria-selected="true"]')).toHaveText([
    /Marquee 4/,
    /Marquee 5/,
    /Marquee 6/,
    /Marquee 7/,
  ])

  await mainWindow.keyboard.press('Escape')
  await publish(
    electronApp,
    Array.from({ length: 50 }, (_, index) =>
      makeDownloadTask({
        id: `marquee-${index}`,
        name: `Marquee ${index}.bin`,
        createdAt: 8_000 - index,
        status: TaskStatus.Paused,
      })
    )
  )
  await expect(grid).toHaveAttribute('aria-rowcount', '51')
  const viewport = grid.getByTestId('virtual-list-container')
  const viewportBox = (await viewport.boundingBox())!
  await mainWindow.mouse.move(start.x, start.y + 4 * 36)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(
    start.x + 140,
    viewportBox.y + viewportBox.height - 8,
    { steps: 12 }
  )
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(300)
  await expect(grid.getByTestId('marquee-box')).toHaveCSS('opacity', '1')
  const rangeEnd = await grid
    .locator('[data-task-id][aria-selected="true"]')
    .last()
    .getAttribute('data-task-id')
  expect(Number(rangeEnd!.split('-')[1])).toBeGreaterThan(20)
  await mainWindow.mouse.up()
  await expect(grid.getByTestId('marquee-box')).toHaveCSS('opacity', '0')
  const releasedScroll = await viewport.evaluate((element) => element.scrollTop)
  await mainWindow.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(
    releasedScroll
  )

  await viewport.evaluate((element) => {
    element.scrollTop = 0
  })
  const selectionAtTop = () =>
    grid
      .locator('[data-task-id][aria-selected="true"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-task-id'))
      )
  const beforeScrollbar = await selectionAtTop()
  const thumb = grid.locator(
    '[data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]'
  )
  await thumb.hover()
  const thumbBox = (await thumb.boundingBox())!
  await mainWindow.mouse.move(
    thumbBox.x + thumbBox.width / 2,
    thumbBox.y + thumbBox.height / 2
  )
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(
    thumbBox.x + thumbBox.width / 2,
    thumbBox.y + thumbBox.height / 2 + 60,
    { steps: 8 }
  )
  await expect(grid.getByTestId('marquee-box')).toHaveCSS('opacity', '0')
  await mainWindow.mouse.up()
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await viewport.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect.poll(selectionAtTop).toEqual(beforeScrollbar)
})

test('inspector content stays fully reachable at every snap and window height', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await publish(electronApp, [
    makeDownloadTask({
      id: 'inspector-overflow',
      name: 'Inspector overflow.bin',
      status: TaskStatus.Completed,
      finishedAt: Date.parse('2026-09-13T12:30:00Z'),
    }),
  ])
  await mainWindow.getByRole('row', { name: /Inspector overflow.bin/ }).click()
  await mainWindow
    .getByRole('button', { name: 'Show Inspector', exact: true })
    .click()
  const drawer = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  const handle = drawer.getByRole('separator', { name: 'Resize Inspector' })
  const content = mainWindow.getByTestId('task-inspector-drawer-content')
  await expectDrawerSettled(drawer)
  for (const [width, height] of [
    [1280, 900],
    [914, 672],
    [1000, 600],
  ]) {
    await setTaskInspectorContentSize(electronApp, mainWindow, width, height)
    for (const snapKey of ['Home', 'ArrowUp', 'End']) {
      await handle.focus()
      await handle.press(snapKey)
      await expectDrawerSettled(drawer)
      const layout = await drawer.evaluate((element) => {
        const viewport = element
          .closest('[data-slot="drawer-viewport"]')!
          .getBoundingClientRect()
        return {
          available: viewport.height,
          visible: viewport.bottom - element.getBoundingClientRect().top,
        }
      })
      const expectedHeight =
        snapKey === 'Home'
          ? 220
          : Math.round(layout.available * (snapKey === 'End' ? 0.75 : 0.5))
      expect(layout.visible).toBeCloseTo(expectedHeight, 0)
      await content.evaluate((element) => {
        element.scrollTop = 0
      })
      await content.hover()
      await mainWindow.mouse.wheel(0, 10_000)
      await expect
        .poll(() =>
          content.evaluate(
            (element) =>
              element.scrollTop + element.clientHeight >=
              element.scrollHeight - 1
          )
        )
        .toBe(true)
      const geometry = await content.evaluate((element) => {
        const last = element.querySelector(
          'time[datetime="2026-09-13T12:30:00.000Z"]'
        )!
        const bounds = element.getBoundingClientRect()
        const lastBounds = last.getBoundingClientRect()
        const hit = document.elementFromPoint(
          lastBounds.left + lastBounds.width / 2,
          lastBounds.top + lastBounds.height / 2
        )
        return {
          viewportHeight: innerHeight,
          bottom: bounds.bottom,
          lastBottom: lastBounds.bottom,
          lastTop: lastBounds.top,
          top: bounds.top,
          reachable: hit === last || last.contains(hit),
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        }
      })
      await testInfo.attach(`geometry-${width}-${height}-${snapKey}`, {
        body: JSON.stringify(geometry),
        contentType: 'application/json',
      })
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
      expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.bottom)
      expect(geometry.lastTop).toBeGreaterThanOrEqual(geometry.top)
      expect(geometry.reachable).toBe(true)
      if (width === 914 && snapKey === 'Home') {
        await mainWindow.screenshot({
          path: testInfo.outputPath('compact-inspector-scrolled-to-bottom.png'),
        })
      }
    }
  }
})

test('native list controls preserve selection through context menus, column changes and drawer snaps', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await publish(electronApp, [
    makeDownloadTask({
      id: 'alpha',
      name: 'Alpha.bin',
      status: TaskStatus.Downloading,
    }),
    makeDownloadTask({
      id: 'beta',
      name: 'Beta.bin',
      status: TaskStatus.Paused,
    }),
    makeDownloadTask({
      id: 'gamma',
      name: 'Gamma.bin',
      status: TaskStatus.Completed,
    }),
  ])
  const grid = mainWindow.locator('[data-downloads-grid]')
  const alpha = grid.locator('[data-task-id=alpha]')
  const beta = grid.locator('[data-task-id=beta]')
  await alpha.click()
  await expect(grid).toBeFocused()
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
  expect(
    await grid.evaluate((element) => getComputedStyle(element).outlineStyle)
  ).toBe('none')
  await expect(
    mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  ).toHaveCount(0)
  await grid.locator('[data-task-id=gamma]').click({ button: 'right' })
  const completedMenu = mainWindow.getByRole('menu')
  await expect(completedMenu).toBeVisible()
  await expect(
    completedMenu.getByRole('menuitem', { name: 'Move Up in Queue' })
  ).toHaveCount(0)
  expect(
    await completedMenu.evaluate((menu) => {
      const roles = [
        ...menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
      ].map((element) => element.getAttribute('role'))
      return roles.some(
        (role, index) =>
          role === 'separator' && roles[index + 1] === 'separator'
      )
    })
  ).toBe(false)
  await mainWindow.screenshot({
    path: testInfo.outputPath('completed-task-context-menu.png'),
  })
  await mainWindow.keyboard.press('Escape')
  await alpha.click()
  await mainWindow.screenshot({
    path: testInfo.outputPath('pointer-selection.png'),
  })
  await beta.click({ modifiers: ['Meta'] })
  await beta.click({ button: 'right' })
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Pause', exact: true })
  ).toBeVisible()
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Resume', exact: true })
  ).toBeVisible()
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
  await expect(beta).toHaveAttribute('aria-selected', 'true')
  expect(
    (await mainWindow.getByRole('menu').boundingBox())!.width
  ).toBeGreaterThanOrEqual(192)
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-context-menu.png'),
  })
  await mainWindow.keyboard.press('Escape')
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)
  await expect(beta).toHaveAttribute('aria-selected', 'true')
  await alpha.click({ modifiers: ['Control'] })
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Resume', exact: true })
  ).toBeVisible()
  await expect(beta).toHaveAttribute('aria-selected', 'true')
  await mainWindow.keyboard.press('Escape')
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)

  await mainWindow.getByRole('button', { name: 'More', exact: true }).click()
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Resume', exact: true })
  ).toBeVisible()
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Pause All', exact: true })
  ).toBeEnabled()
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Resume All', exact: true })
  ).toBeEnabled()
  await mainWindow.screenshot({
    path: testInfo.outputPath('global-transfer-actions.png'),
  })
  await mainWindow.keyboard.press('Escape')
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)

  await grid.getByRole('button', { name: 'Name', exact: true }).focus()
  await mainWindow.keyboard.press('Shift+Tab')
  await expect(grid).toBeFocused()
  await expect(grid).toHaveAttribute('data-keyboard-focus', 'true')
  expect(
    await grid.evaluate((element) => getComputedStyle(element).outlineStyle)
  ).toBe('solid')

  await mainWindow.screenshot({
    path: testInfo.outputPath('keyboard-focus.png'),
  })
  const nameResize = grid.getByRole('separator', { name: 'Resize Name column' })
  await nameResize.focus()
  await mainWindow.keyboard.press('ArrowRight')
  await expect(nameResize).toHaveAttribute('aria-valuenow', '256')
  const nameHeader = grid.getByRole('button', { name: 'Name', exact: true })
  await nameHeader.click({ button: 'right' })
  await mainWindow
    .getByRole('menuitemcheckbox', { name: 'Date completed' })
    .click()
  await mainWindow.keyboard.press('Escape')
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)
  await expect(
    grid.getByRole('button', { name: 'Date completed', exact: true })
  ).toHaveCount(0)
  await expect(beta).toHaveAttribute('aria-selected', 'true')

  // A badge occupies its text width, independently of the status column.
  const badge = beta.getByTestId('task-status-pill')
  const badgeSize = await badge.boundingBox()
  const cellSize = await badge.locator('..').boundingBox()
  expect(badgeSize!.width).toBeLessThan(cellSize!.width - 16)

  await mainWindow
    .getByRole('button', { name: 'Show Inspector', exact: true })
    .click()
  const drawer = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await expect(drawer).toBeVisible()
  const handle = drawer.getByRole('separator', { name: 'Resize Inspector' })
  const header = drawer.locator('[data-slot="drawer-header"]')
  await expect(
    header.getByRole('separator', { name: 'Resize Inspector' })
  ).toBeVisible()
  await expect
    .poll(() =>
      header.evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBe(41)
  await handle.focus()
  await mainWindow.keyboard.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '220')
  await expectDrawerSettled(drawer)
  // Starting on a header action must not turn a canceled button click into a swipe.
  const closeBox = (await header
    .getByRole('button', { name: 'Close', exact: true })
    .boundingBox())!
  await mainWindow.mouse.move(
    closeBox.x + closeBox.width / 2,
    closeBox.y + closeBox.height / 2
  )
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(closeBox.x - 60, closeBox.y - 30, { steps: 4 })
  await expect(drawer).not.toHaveAttribute('data-swiping', '')
  await mainWindow.mouse.up()
  await expect(drawer).toBeVisible()
  await expect(handle).toHaveAttribute('aria-valuenow', '220')
  await handle.click({ trial: true })
  const box = await handle.boundingBox()
  await mainWindow.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(box!.x + box!.width / 2, box!.y - 12, {
    steps: 2,
  })
  await expect(drawer).toHaveAttribute('data-swiping', '')
  await mainWindow.mouse.move(box!.x + box!.width / 2, box!.y - 200, {
    steps: 16,
  })
  await mainWindow.mouse.up()
  await expect.poll(() => handle.getAttribute('aria-valuenow')).not.toBe('220')
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
  // A fully expanded overlay deliberately covers these rows. Collapse it
  // before verifying that the uncovered list stays interactive.
  await handle.focus()
  await handle.press('Home')
  await expectDrawerSettled(drawer)
  await beta.click()
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(beta).toHaveAttribute('aria-selected', 'true')
  await alpha.click()
  await expect(drawer).toHaveCount(0)
  await mainWindow
    .getByRole('button', { name: 'Show Inspector', exact: true })
    .click()
  await expect(drawer).toContainText('Alpha.bin')
  await expectDrawerSettled(drawer)
  await drawer
    .getByRole('separator', { name: 'Resize Inspector' })
    .click({ trial: true })
  await mainWindow.screenshot({
    path: testInfo.outputPath('native-list-and-snap-drawer.png'),
    animations: 'disabled',
  })
  await testInfo.attach('native-list-and-snap-drawer', {
    body: await mainWindow.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await mainWindow
    .getByRole('button', { name: 'Toggle sidebar', exact: true })
    .click()
  const toolbarButtons = mainWindow.locator(
    '[data-slot="panel-shell-actions"] button'
  )
  await expect(toolbarButtons).toHaveCount(4)
  for (const button of await toolbarButtons.all()) {
    await expect
      .poll(() =>
        button.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const icon = element.querySelector('svg')!.getBoundingClientRect()
          return [rect.width, rect.height, icon.width, icon.height]
        })
      )
      .toEqual([24, 24, 16, 16])
  }
  await alpha.click()
  await mainWindow.screenshot({
    path: testInfo.outputPath('collapsed-sidebar-selection.png'),
    animations: 'disabled',
  })
  await updateTaskInspectorAppearance(mainWindow, 'dark', 'zh-CN')
  await expect(mainWindow.locator('html')).toHaveClass(/dark/)
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await publish(electronApp, [
    makeDownloadTask({
      id: 'dark',
      name: '示例任务.zip',
      status: TaskStatus.Paused,
      createdAt: Date.now(),
    }),
  ])
  const darkRow = mainWindow.getByRole('row', { name: '示例任务.zip' })
  await darkRow.click()
  await expectDrawerSettled(
    mainWindow.getByRole('dialog', { name: '任务详情' })
  )
  await expect(darkRow.getByTestId('task-status-pill')).toHaveText('已暂停')
  await mainWindow.screenshot({
    path: testInfo.outputPath('dark-selection.png'),
    animations: 'disabled',
  })
  await darkRow.click({ button: 'right' })
  await expect(
    mainWindow.getByRole('menuitem', { name: '调整下载顺序' })
  ).toBeVisible()
  expect(
    (await mainWindow.getByRole('menu').boundingBox())!.width
  ).toBeGreaterThanOrEqual(192)
  await mainWindow.getByRole('menuitem', { name: '调整下载顺序' }).hover()
  await expect(
    mainWindow.getByRole('menuitem', { name: '在队列中上移' })
  ).toBeVisible()
  await expect(
    mainWindow.getByRole('menuitem', { name: '移至队列最前' })
  ).toBeVisible()
  await mainWindow.screenshot({
    path: testInfo.outputPath('dark-chinese-context-menu.png'),
  })
})

test('compact search filters the table and explains active query and type filters', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const tasks = [
    makeDownloadTask({ id: 'alpha', name: 'Alpha.iso', type: TaskType.Http }),
    makeDownloadTask({ id: 'beta', name: 'Beta.iso', type: TaskType.Http }),
    makeDownloadTask({ id: 'ftp', name: 'Alpha FTP.iso', type: TaskType.Ftp }),
  ]
  await publish(electronApp, tasks)
  const root = mainWindow.locator('[data-slot="downloads-search"]')
  const search = mainWindow.getByRole('button', {
    name: 'Search downloads',
    exact: true,
  })
  await expect(
    mainWindow.getByRole('button', { name: 'More', exact: true })
  ).toBeEnabled()
  await search.click()
  const input = mainWindow.getByRole('textbox', { name: 'Search downloads' })
  await expect(input).toBeFocused()
  await expect(root).toHaveAttribute('data-filter-active', 'false')
  const filter = mainWindow.getByRole('button', { name: /^Filters/ })
  await expect(filter.locator('svg')).toHaveClass(/lucide-list-filter/)
  await input.fill('alpha')
  await expect(mainWindow.locator('[data-task-id]')).toHaveCount(2)
  await expect(root).toHaveAttribute('data-filter-active', 'true')
  await expect(filter).toHaveCSS('color', 'rgb(0, 107, 214)')
  await filter.click()
  const filterPopup = mainWindow.getByRole('dialog', {
    name: 'Filters',
    exact: true,
  })
  await expect(filterPopup).toBeVisible()
  await expect
    .poll(async () => {
      const popup = (await filterPopup.boundingBox())!
      const field = (await root.boundingBox())!
      return Math.abs(popup.x - field.x) + Math.abs(popup.width - field.width)
    })
    .toBeLessThanOrEqual(1)
  await expect(mainWindow.getByRole('tooltip')).toHaveCount(0)
  await mainWindow.getByRole('button', { name: /^HTTP/ }).click()
  await expect(mainWindow.locator('[data-task-id]')).toHaveCount(1)
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-filter-popover-light.png'),
    animations: 'disabled',
  })
  await mainWindow.keyboard.press('Escape')
  await filter.hover()
  await expect(mainWindow.getByRole('tooltip')).toContainText('Search: alpha')
  await expect(mainWindow.getByRole('tooltip')).toContainText(
    'Type filter: HTTP'
  )
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-search-light.png'),
  })
  await mainWindow
    .getByRole('button', { name: 'Clear search', exact: true })
    .click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await expect(root).toHaveAttribute('data-filter-active', 'true')
  await expect(mainWindow.locator('[data-task-id]')).toHaveCount(2)
  await filter.click()
  await mainWindow
    .getByRole('button', { name: 'Reset filters', exact: true })
    .click()
  await mainWindow.keyboard.press('Escape')
  await expect(root).toHaveAttribute('data-filter-active', 'false')
  await input.click()
  await input.press('Escape')
  await expect(search).toBeFocused()
  await search.click()
  await mainWindow.getByRole('heading', { name: 'All Downloads' }).click()
  await expect(root).toHaveAttribute('data-expanded', 'false')
  await mainWindow.keyboard.press('Escape')

  await updateTaskInspectorAppearance(mainWindow, 'dark', 'zh-CN')
  await publish(electronApp, tasks)
  await mainWindow
    .getByRole('button', { name: '搜索下载任务', exact: true })
    .click()
  const zhInput = mainWindow.getByRole('textbox', { name: '搜索下载任务' })
  await zhInput.fill('alpha')
  const zhFilter = mainWindow.getByRole('button', { name: /^筛选/ })
  await zhFilter.click()
  await mainWindow.getByRole('button', { name: /^HTTP/ }).click()
  await mainWindow.getByRole('button', { name: /^FTP/ }).click()
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-filter-popover-dark.png'),
    animations: 'disabled',
  })
  await mainWindow.keyboard.press('Escape')
  await zhFilter.hover()
  await expect(mainWindow.getByRole('tooltip')).toContainText(
    '类型筛选：HTTP和FTP'
  )
  await expect(zhFilter).toHaveCSS('color', 'rgb(105, 174, 255)')
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-search-dark.png'),
  })
  // A stream update can remove every match of an already-selected type.
  await publish(
    electronApp,
    tasks.filter((task) => task.type !== TaskType.Ftp)
  )
  await zhFilter.click()
  const ftp = mainWindow.getByRole('button', { name: /^FTP/ })
  await expect(ftp).toBeEnabled()
  await expect(ftp).toHaveAttribute('aria-pressed', 'true')
  await ftp.click()
  await expect(ftp).toHaveAttribute('aria-pressed', 'false')
  await expect(ftp).toBeDisabled()
})

test('opens new tasks from empty, selected-row and whitespace context menus', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await expect(
    mainWindow.getByText('No downloads yet', { exact: true })
  ).toBeVisible()
  await mainWindow.locator('[data-slot="context-menu-trigger"]').click({
    button: 'right',
    position: { x: 20, y: 20 },
  })
  const create = mainWindow.getByRole('menuitem', {
    name: 'New Task…',
    exact: true,
  })
  await expect(create).toBeVisible()
  await expect(mainWindow.getByRole('menuitem')).toHaveCount(1)
  await expect(mainWindow.getByRole('menu').getByRole('separator')).toHaveCount(
    0
  )
  await create.click()
  const addTask = await findAddTaskWindow(electronApp)
  await expect(addTask.getByRole('textbox', { name: 'URLs' })).toBeVisible()
  await addTask.getByRole('button', { name: 'Cancel', exact: true }).click()
  await publish(electronApp, [
    makeDownloadTask({ id: 'new-task-context', name: 'Existing.bin' }),
  ])
  const row = mainWindow.getByRole('row', { name: 'Existing.bin', exact: true })
  await row.click()
  await row.click({ button: 'right' })
  await expect(create).toBeVisible()
  await expect(mainWindow.getByRole('menuitem').first()).toHaveAccessibleName(
    'Show Inspector'
  )
  await expect(create).toHaveAttribute(
    'aria-keyshortcuts',
    process.platform === 'darwin' ? 'Meta+N' : 'Control+N'
  )
  await mainWindow.screenshot({
    path: testInfo.outputPath('new-task-context-menu.png'),
    animations: 'disabled',
  })
  await create.click()
  const reopened = await findAddTaskWindow(electronApp)
  await expect(reopened.getByRole('textbox', { name: 'URLs' })).toBeVisible()
  await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  const rowBox = (await row.boundingBox())!
  await mainWindow.mouse.click(rowBox.x + 40, rowBox.y + rowBox.height + 40, {
    button: 'right',
  })
  await expect(create).toBeVisible()
  // An open context menu hides the background grid from the accessibility tree.
  await expect(
    mainWindow.locator('[data-task-id="new-task-context"]')
  ).toHaveAttribute('aria-selected', 'true')
  await mainWindow.keyboard.press('Escape')
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)
})

for (const compact of [false, true]) {
  test(`${compact ? 'compact' : 'standard'} toolbar overflows in priority order without losing input, focus or inspector state`, async ({
    electronApp,
    mainWindow,
  }, testInfo) => {
    await waitForEngineReady(mainWindow)
    await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
    await publish(electronApp, [
      makeDownloadTask({ id: 'alpha', name: 'Alpha.iso' }),
      makeDownloadTask({ id: 'beta', name: 'Beta.iso' }),
    ])
    const toggleSidebar = mainWindow.getByRole('button', {
      name: 'Toggle sidebar',
      exact: true,
    })
    if (compact) await toggleSidebar.click()
    const density = compact ? 'compact' : 'standard'
    const controlSize = compact ? 30 : 36
    const targetSize = compact ? 24 : 30
    const iconSize = compact ? 16 : 18
    const toolbar = mainWindow.locator('[data-slot="downloads-toolbar"]')
    const group = mainWindow.locator('[data-slot="downloads-action-group"]')
    const search = mainWindow.locator('[data-slot="downloads-search"]')
    await expect(toolbar).toHaveAttribute('data-density', density)
    await expect(toolbar).toHaveAttribute('data-visible-actions', '3')
    await expect
      .poll(async () => (await group.boundingBox())!.height)
      .toBe(controlSize)
    expect((await group.boundingBox())!.width).toBe(compact ? 86 : 104)
    await expect
      .poll(async () => (await search.boundingBox())!.width)
      .toBe(controlSize)
    const title = mainWindow.getByRole('heading', { name: 'All Downloads' })
    await expect(title).toHaveCSS('font-size', compact ? '14px' : '24px')
    await expect
      .poll(
        async () => (await mainWindow.locator('header').boundingBox())!.height
      )
      .toBe(compact ? 38 : 80)
    for (const button of await toolbar.getByRole('button').all()) {
      await expect
        .poll(() =>
          button.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const svg = element.querySelector('svg')!.getBoundingClientRect()
            return [rect.width, rect.height, svg.width, svg.height]
          })
        )
        .toEqual([targetSize, targetSize, iconSize, iconSize])
    }
    await mainWindow.screenshot({
      path: testInfo.outputPath(`${density}-toolbar-default.png`),
      animations: 'disabled',
    })
    await mainWindow
      .getByRole('button', { name: 'Search downloads', exact: true })
      .click()
    const input = mainWindow.getByRole('textbox', { name: 'Search downloads' })
    await input.fill('alpha')
    await expect.poll(async () => (await search.boundingBox())!.width).toBe(230)
    const heading = await mainWindow
      .getByRole('heading', { name: 'All Downloads' })
      .boundingBox()
    const controls = (await group.boundingBox())!
    expect(
      Math.abs(
        heading!.y + heading!.height / 2 - controls.y - controls.height / 2
      )
    ).toBeLessThanOrEqual(1)
    await mainWindow.getByRole('row', { name: 'Alpha.iso' }).dblclick()
    const drawer = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
    await expectDrawerSettled(drawer)
    await input.click()
    const fitToolbar = async (available: number) => {
      const bounds = (await toolbar.boundingBox())!
      const viewport = mainWindow.viewportSize()!
      await setTaskInspectorContentSize(
        electronApp,
        mainWindow,
        Math.round(viewport.width + available - bounds.width),
        900
      )
    }
    await fitToolbar(compact ? 308 : 320)
    await expect(toolbar).toHaveAttribute('data-visible-actions', '2')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('alpha')
    await expect(drawer).toBeVisible()
    await mainWindow.screenshot({
      path: testInfo.outputPath(`${density}-toolbar-two-actions.png`),
      animations: 'disabled',
    })
    const info = mainWindow.getByRole('button', {
      name: 'Hide Inspector',
      exact: true,
    })
    await info.focus()
    await fitToolbar(280)
    await expect(toolbar).toHaveAttribute('data-visible-actions', '1')
    const more = mainWindow.getByRole('button', { name: 'More', exact: true })
    await expect(more).toBeFocused()
    await expect(drawer).toBeVisible()
    expect((await search.boundingBox())!.x).toBeGreaterThanOrEqual(
      (await group.boundingBox())!.x + (await group.boundingBox())!.width + 7
    )
    await more.click()
    await expect(
      mainWindow.getByRole('menuitem', { name: 'List View' })
    ).toBeVisible()
    await expect(
      mainWindow.getByRole('menuitem', { name: 'Hide Inspector' })
    ).toBeVisible()
    await mainWindow.screenshot({
      path: testInfo.outputPath(`${density}-search-overflow.png`),
      animations: 'disabled',
    })
    await mainWindow.keyboard.press('Escape')
    await fitToolbar(400)
    await expect(toolbar).toHaveAttribute('data-visible-actions', '3')
    await expect(info).toBeVisible()
    await expect(input).toHaveValue('alpha')
    await expect(drawer).toBeVisible()
    await mainWindow.screenshot({
      path: testInfo.outputPath(`${density}-search-expanded.png`),
      animations: 'disabled',
    })
    // A density change must preserve the live search, selection and open inspector.
    await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
    await toggleSidebar.click()
    await expect(toolbar).toHaveAttribute(
      'data-density',
      compact ? 'standard' : 'compact'
    )
    await expect
      .poll(async () => (await group.boundingBox())!.height)
      .toBe(compact ? 36 : 30)
    await expect(input).toHaveValue('alpha')
    await expect(
      mainWindow.getByRole('row', { name: 'Alpha.iso' })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(drawer).toBeVisible()
    expect(
      await mainWindow.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight
      )
    ).toBe(false)
  })
}

test('context actions open files, select download files, reorder the queue and copy errors', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const channels = {
    open: Commands.OpenTaskFile,
    move: Commands.MoveTasks,
    files: Queries.GetTaskFiles,
    select: Commands.SetSelectedFiles,
  }
  await electronApp.evaluate(({ ipcMain }, channels) => {
    const calls: Array<{ channel: string; payload: unknown }> = []
    Object.assign(globalThis, { menuActionCalls: calls })
    for (const channel of Object.values(channels)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, payload) => {
        calls.push({ channel, payload })
        if (channel === channels.files)
          return [0, 1, 2].map((index) => ({
            index,
            path: `File ${index}.bin`,
            size: 1000,
            selected: index === 0,
            completedBytes: 0,
            uris: [],
          }))
        if (channel === channels.move)
          return { moved: payload.taskIds, unchanged: [], failed: [] }
        return undefined
      })
    }
  }, channels)
  const getCalls = () =>
    electronApp.evaluate(
      () =>
        (
          globalThis as unknown as {
            menuActionCalls: Array<{ channel: string; payload: unknown }>
          }
        ).menuActionCalls
    )
  const tasks = [
    makeDownloadTask({
      id: 'menu-completed',
      name: 'Completed.bin',
      status: TaskStatus.Completed,
      fileCount: 1,
      finalPath: '/downloads/Completed.bin',
    }),
    makeDownloadTask({
      id: 'menu-bt',
      name: 'Torrent collection',
      type: TaskType.Bt,
      status: TaskStatus.Paused,
      fileCount: 3,
      bt: {
        peers: 0,
        seeds: 0,
        ratio: 0,
        trackers: [],
        selectedFiles: [0],
        peersInSwarm: 0,
        seedsInSwarm: 0,
        announceList: [],
        comment: null,
        isPrivate: false,
        magnetUri: null,
        sequentialDownload: false,
      },
    }),
    makeDownloadTask({
      id: 'menu-error',
      name: 'Failed.bin',
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'ENOSPC: fixture disk is full',
    }),
  ]
  await publish(electronApp, tasks)
  const row = (id: string) => mainWindow.locator(`[data-task-id="${id}"]`)
  await row('menu-completed').click({ button: 'right' })
  await mainWindow
    .getByRole('menuitem', { name: 'Open file', exact: true })
    .click()
  await expect.poll(getCalls).toContainEqual({
    channel: channels.open,
    payload: { taskId: 'menu-completed' },
  })
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)

  await row('menu-bt').click({ button: 'right' })
  await mainWindow
    .getByRole('menuitem', { name: 'Download order', exact: true })
    .hover()
  await expect(
    mainWindow.getByRole('menuitem', { name: 'Move to Front', exact: true })
  ).toBeVisible()
  await mainWindow.screenshot({
    path: testInfo.outputPath('queue-submenu.png'),
  })
  await mainWindow
    .getByRole('menuitem', { name: 'Move to Front', exact: true })
    .click()
  await expect.poll(getCalls).toContainEqual({
    channel: channels.move,
    payload: { taskIds: ['menu-bt'], direction: 'top' },
  })
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)
  await row('menu-bt').click({ button: 'right' })
  await mainWindow
    .getByRole('menuitem', { name: 'Download order', exact: true })
    .focus()
  await mainWindow.keyboard.press('ArrowRight')
  await mainWindow
    .getByRole('menuitem', { name: 'Move to Back', exact: true })
    .click()
  await expect.poll(getCalls).toContainEqual({
    channel: channels.move,
    payload: { taskIds: ['menu-bt'], direction: 'bottom' },
  })
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)

  await row('menu-bt').click({ button: 'right' })
  await mainWindow
    .getByRole('menuitem', { name: 'Choose files…', exact: true })
    .click()
  const inspector = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await expect(inspector).toBeVisible()
  await expect(
    inspector.getByRole('tab', { name: 'Files', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await inspector
    .getByRole('checkbox', { name: 'File 1.bin', exact: true })
    .click()
  await inspector.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(getCalls).toContainEqual({
    channel: channels.select,
    payload: { taskId: 'menu-bt', indices: [0, 1] },
  })
  await inspector.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(inspector).toHaveCount(0)

  await row('menu-error').click({ button: 'right' })
  await mainWindow.screenshot({
    path: testInfo.outputPath('error-context-menu.png'),
  })
  await mainWindow
    .getByRole('menuitem', { name: 'Copy error information', exact: true })
    .click()
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('ENOSPC: fixture disk is full')
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('Task ID: menu-error')
})

test('inspector opens a completed file in a compact window', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await electronApp.evaluate(({ ipcMain }, channel) => {
    const calls: unknown[] = []
    Object.assign(globalThis, { inspectorOpenFileCalls: calls })
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, payload) => {
      calls.push(payload)
    })
  }, Commands.OpenTaskFile)
  await publish(electronApp, [
    makeDownloadTask({
      id: 'inspector-completed',
      name: 'Completed.bin',
      status: TaskStatus.Completed,
      fileCount: 1,
      finalPath: '/downloads/Completed.bin',
      diskPath: '/downloads/Completed.bin',
    }),
  ])
  await mainWindow.locator('[data-task-id="inspector-completed"]').dblclick()
  const inspector = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await expect(inspector).toBeVisible()
  await expectDrawerSettled(inspector)
  await setTaskInspectorContentSize(electronApp, mainWindow, 600, 650)
  await inspector
    .getByRole('button', { name: 'Open file', exact: true })
    .click()
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          (
            globalThis as unknown as {
              inspectorOpenFileCalls: unknown[]
            }
          ).inspectorOpenFileCalls
      )
    )
    .toEqual([{ taskId: 'inspector-completed' }])
  await expect(
    inspector.getByRole('button', { name: 'Open folder', exact: true })
  ).toBeVisible()
  await mainWindow.screenshot({
    path: testInfo.outputPath('inspector-open-file-compact.png'),
    animations: 'disabled',
  })
  await inspector.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(inspector).toHaveCount(0)
})

for (const [locale, downloads, createdColumn] of [
  ['en-US', 'Downloads', 'Date created'],
  ['zh-CN', '下载', '创建时间'],
  ['zh-TW', '下載', '建立時間'],
] as const) {
  test(`task timestamps show localized seconds and full details in ${locale}`, async ({
    electronApp,
    mainWindow,
  }, testInfo) => {
    await waitForEngineReady(mainWindow)
    await setTaskInspectorContentSize(electronApp, mainWindow, 1660, 900)
    await updateTaskInspectorAppearance(mainWindow, 'light', locale)
    await waitForEngineReady(mainWindow)
    await mainWindow.getByRole('link', { name: downloads, exact: true }).click()
    await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
    const dates = await mainWindow.evaluate((language) => {
      const now = new Date(2026, 8, 15, 14, 40).getTime()
      const first = new Date(2026, 8, 15, 14, 32, 8).getTime()
      const second = new Date(2026, 8, 15, 14, 32, 59).getTime()
      const yesterday = new Date(2026, 8, 14, 9, 18, 7).getTime()
      const historical = new Date(2025, 11, 8, 14, 32, 8).getTime()
      const full = new Intl.DateTimeFormat(language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
      const detailed = new Intl.DateTimeFormat(language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'shortOffset',
      })
      return {
        now,
        first,
        second,
        yesterday,
        historical,
        todayLabel: new Intl.RelativeTimeFormat(language, {
          numeric: 'auto',
        }).format(0, 'day'),
        yesterdayLabel: new Intl.RelativeTimeFormat(language, {
          numeric: 'auto',
        }).format(-1, 'day'),
        full: full.format(first),
        detailed: detailed.format(first),
        historicalLabel: full.format(historical),
      }
    }, locale)
    await mainWindow.clock.setFixedTime(dates.now)
    await publish(electronApp, [
      makeDownloadTask({
        id: 'date-first',
        name: 'First.bin',
        createdAt: dates.first,
        finishedAt: dates.second,
        status: TaskStatus.Completed,
      }),
      makeDownloadTask({
        id: 'date-second',
        name: 'Second.bin',
        createdAt: dates.second,
      }),
      makeDownloadTask({
        id: 'date-yesterday',
        name: 'Yesterday.bin',
        createdAt: dates.yesterday,
      }),
      makeDownloadTask({
        id: 'date-history',
        name: 'History.bin',
        createdAt: dates.historical,
      }),
    ])
    const list = mainWindow.getByTestId('virtual-list-container')
    const row = (id: string) => list.locator(`[data-task-id="${id}"]`)
    await expect(list.locator('[data-task-id]')).toHaveText([
      /Second.bin/,
      /First.bin/,
      /Yesterday.bin/,
      /History.bin/,
    ])
    const created = row('date-first').locator('time').first()
    await expect(created).toContainText(dates.todayLabel)
    await expect(created).toContainText(':32:08')
    await expect(row('date-first').locator('time').last()).toContainText(
      ':32:59'
    )
    await expect(row('date-yesterday').locator('time')).toContainText(
      dates.yesterdayLabel
    )
    await expect(row('date-history').locator('time')).toHaveText(
      dates.historicalLabel
    )
    await expect(created).toHaveAttribute('tabindex', '-1')
    await created.hover()
    await expect(mainWindow.getByRole('tooltip')).toHaveText(dates.detailed)
    await mainWindow.screenshot({
      path: testInfo.outputPath('timestamps-tooltip.png'),
    })
    // Timestamp text remains part of row selection, not a separate action.
    await created.click()
    await expect(row('date-first')).toHaveAttribute('aria-selected', 'true')
    await expect(mainWindow.getByRole('tooltip')).toHaveCount(0)
    const createdHeader = list
      .getByRole('columnheader')
      .filter({ hasText: createdColumn })
    // First click exposes the default descending state; the next reverses it.
    await createdHeader.getByRole('button').click()
    await createdHeader.getByRole('button').click()
    await expect(list.locator('[data-task-id]')).toHaveText([
      /History.bin/,
      /Yesterday.bin/,
      /First.bin/,
      /Second.bin/,
    ])
    for (const time of await list.locator('time').all()) {
      expect(
        await time.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true)
    }
    await mainWindow.screenshot({
      path: testInfo.outputPath('timestamps-list.png'),
    })
    await row('date-first').dblclick()
    const inspector = mainWindow.locator('[data-slot="drawer-content"]')
    await expect(inspector).toBeVisible()
    await expectDrawerSettled(inspector)
    const full = inspector.locator('time').first()
    await full.scrollIntoViewIfNeeded()
    await expect(full).toHaveText(dates.full)
    await full.hover()
    await expect(mainWindow.getByRole('tooltip')).toHaveText(dates.detailed)
    await mainWindow.screenshot({
      path: testInfo.outputPath('timestamps-inspector.png'),
    })
  })
}

test('organized context menus expose working scoped shortcuts and keep text editing intact', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1280, 900)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  await electronApp.evaluate(({ ipcMain }, channel) => {
    const calls: unknown[] = []
    Object.assign(globalThis, { shortcutRemoveCalls: calls })
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, payload) => {
      calls.push(payload)
      return { succeeded: payload.taskIds, failed: [] }
    })
  }, Commands.RemoveTasks)
  await publish(electronApp, [
    makeDownloadTask({
      id: 'shortcut-a',
      name: 'Alpha.bin',
      status: TaskStatus.Paused,
      uris: ['https://example.test/alpha.bin'],
    }),
    makeDownloadTask({
      id: 'shortcut-b',
      name: 'Beta.bin',
      status: TaskStatus.Paused,
      uris: ['https://example.test/beta.bin'],
    }),
  ])
  const macOS = process.platform === 'darwin'
  const primary = macOS ? 'Meta' : 'Control'
  const grid = mainWindow.locator('[data-downloads-grid]')
  const row = (id: string) => grid.locator(`[data-task-id="${id}"]`)
  const clipboard = () =>
    electronApp.evaluate(({ clipboard }) => clipboard.readText())
  const removeCalls = () =>
    electronApp.evaluate(
      () =>
        (globalThis as unknown as { shortcutRemoveCalls: unknown[] })
          .shortcutRemoveCalls
    )
  await row('shortcut-a').click()
  await row('shortcut-b').click({ modifiers: [primary] })
  await row('shortcut-b').click({ button: 'right' })
  const menu = mainWindow.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem').first()).toHaveAccessibleName(
    'Show Inspector'
  )
  await expect(menu.getByRole('menuitem').last()).toHaveAccessibleName('Remove')
  await expect(
    menu.getByRole('menuitem', { name: 'Copy URLs', exact: true })
  ).toHaveAttribute('aria-keyshortcuts', `${primary}+C`)
  expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(192)
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(288)
  await mainWindow.screenshot({
    path: testInfo.outputPath('organized-multiple-menu.png'),
    animations: 'disabled',
  })
  await mainWindow.keyboard.press(`${primary}+i`)
  await expect(menu).toHaveCount(0)
  const inspector = mainWindow.getByRole('dialog', { name: 'Task Inspector' })
  await expect(inspector).toBeVisible()
  await expect(grid).toBeFocused()
  await mainWindow.keyboard.press(`${primary}+i`)
  await expect(inspector).toHaveCount(0)

  await mainWindow.keyboard.press(`${primary}+c`)
  await expect
    .poll(clipboard)
    .toBe('https://example.test/alpha.bin\nhttps://example.test/beta.bin')
  await electronApp.evaluate(({ clipboard }) =>
    clipboard.writeText('before-menu-copy')
  )
  await row('shortcut-b').click({ button: 'right' })
  await mainWindow.keyboard.press(`${primary}+c`)
  await expect(menu).toHaveCount(0)
  await expect
    .poll(clipboard)
    .toBe('https://example.test/alpha.bin\nhttps://example.test/beta.bin')

  await mainWindow.keyboard.press(macOS ? 'Meta+Backspace' : 'Delete')
  const dialog = mainWindow.getByRole('dialog', {
    name: 'Remove 2 paused tasks?',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  expect(await removeCalls()).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  await mainWindow
    .getByRole('button', { name: 'Search downloads', exact: true })
    .click()
  const search = mainWindow.getByRole('textbox', {
    name: 'Search downloads',
    exact: true,
  })
  await search.fill('alpha')
  await search.selectText()
  await mainWindow.keyboard.press(`${primary}+c`)
  await expect.poll(clipboard).toBe('alpha')
  await mainWindow.keyboard.press(`${primary}+i`)
  await expect(inspector).toHaveCount(0)
  await search.fill('')
  await search.press('Escape')
  await row('shortcut-a').click()
  await row('shortcut-b').click({ modifiers: [primary] })
  await row('shortcut-b').click({ button: 'right' })
  await mainWindow.keyboard.press(macOS ? 'Meta+Backspace' : 'Delete')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect
    .poll(removeCalls)
    .toEqual([
      { taskIds: ['shortcut-a', 'shortcut-b'], deleteWithFiles: false },
    ])
})
