import type { ElectronApplication, Locator } from '@playwright/test'
import { Events } from '@shared/protocol/events'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '../src/test-utils/task'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'
import { setTaskInspectorContentSize } from './fixtures/task-inspector-activity'

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
        if (!list?.firstElementChild) return false
        const rect = element.getBoundingClientRect()
        const viewport = list.getBoundingClientRect()
        const header = list.firstElementChild!.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + 120,
          rect.top + rect.height / 2
        )
        return (
          rect.top >= header.bottom - 1 &&
          rect.bottom <= viewport.bottom + 1 &&
          hit?.closest('[role="option"]') === element
        )
      })
    )
    .toBe(true)
}

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
    const tail = mainWindow.getByRole('option', {
      name: new RegExp(`Active tail ${count - 1}\\.bin`),
    })
    await expectUsable(tail)
    await expect(tail).toContainText('99%')
    await tail.click({ position: { x: 120, y: 24 } })
    const drawer = mainWindow.getByRole('dialog', {
      name: 'Downloads',
      exact: true,
    })
    await expect(drawer).toBeVisible()
    await expectUsable(tail)
    await expect
      .poll(async () => {
        const a = await list.boundingBox()
        const b = await drawer.boundingBox()
        return !!a && !!b && a.y + a.height <= b.y
      })
      .toBe(true)

    await testInfo.attach('all-downloads-with-inspector', {
      body: await mainWindow.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })

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
    await mainWindow.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expectUsable(tail)

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
      mainWindow.getByRole('option', { name: /New active tail\.bin/ })
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
