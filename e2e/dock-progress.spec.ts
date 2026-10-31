import type { Page } from '@playwright/test'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

type DockProbe = typeof globalThis & { dockProgressCalls: number[] }
const label = 'Show download progress in Dock'

async function openSettings(page: Page, card = 'Appearance') {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByText(card, { exact: true }).first().click()
  await expect(
    page.getByRole('button', { name: 'Save', exact: true })
  ).toBeEnabled()
}

test('Dock progress is opt-in, survives renderer release, and clears when disabled or finished', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'macOS Dock integration')
  test.setTimeout(90_000)
  await waitForEngineReady(mainWindow)
  await electronApp.evaluate(({ BaseWindow }) => {
    const probe = globalThis as DockProbe
    probe.dockProgressCalls = []
    const original = BaseWindow.prototype.setProgressBar
    BaseWindow.prototype.setProgressBar = function (progress, options) {
      probe.dockProgressCalls.push(progress)
      return original.call(this, progress, options)
    }
  })
  const calls = () =>
    electronApp.evaluate(() => (globalThis as DockProbe).dockProgressCalls)
  const latest = async () => (await calls()).at(-1)
  const server = await startHttpFixture({
    size: 2 * 1024 * 1024,
    throttleBytesPerSecond: 64 * 1024,
  })
  try {
    await mainWindow.getByRole('button', { name: 'New task' }).click()
    const addTask = await findAddTaskWindow(electronApp)
    await addTask.getByRole('textbox', { name: 'URLs' }).fill(server.fileUrl)
    await addTask.getByRole('button', { name: 'Download' }).click()
    // Task creation queues navigation to the inspector. Let it settle before
    // navigating away so that it cannot dismiss the settings dialog mid-edit.
    await expect(
      mainWindow.getByRole('heading', { name: 'Task Inspector', exact: true })
    ).toBeVisible()
    await openSettings(mainWindow, 'General')
    await mainWindow
      .getByRole('switch', { name: 'Save memory when the window is closed' })
      .click()
    await mainWindow.getByRole('button', { name: 'Save', exact: true }).click()
    await openSettings(mainWindow)
    await expect(
      mainWindow.getByRole('switch', { name: label })
    ).not.toBeChecked()
    expect(await calls()).toEqual([])
    await mainWindow.getByRole('switch', { name: label }).click()
    await mainWindow.screenshot({
      path: testInfo.outputPath('dock-progress-setting.png'),
    })
    await mainWindow.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(latest).toBeGreaterThan(0)

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('w=main'))
        ?.close()
    })
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(0)
    const previous = (await latest()) as number
    await expect.poll(latest).toBeGreaterThan(previous)
    expect(
      await electronApp.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)

    const reopened = electronApp.waitForEvent('window')
    await electronApp.evaluate(({ app }) => {
      app.emit('activate')
    })
    const page = await reopened
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)
    await expect(page.getByRole('switch', { name: label })).toBeChecked()
    await page.getByRole('switch', { name: label }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(latest).toBe(-1)

    await openSettings(page)
    await page.getByRole('switch', { name: label }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(latest).toBeGreaterThan(0)
    await expect.poll(latest, { timeout: 45_000 }).toBe(-1)
    const statuses = await page.evaluate(async (channel) => {
      const api = (
        window as unknown as {
          motrix: { invoke(channel: string): Promise<{ status: string }[]> }
        }
      ).motrix
      return (await api.invoke(channel)).map((task) => task.status)
    }, Queries.ListTasks)
    expect(statuses).toEqual(['completed'])
    expect(
      (await calls()).every(
        (value) => value === -1 || (value >= 0 && value < 1)
      )
    ).toBe(true)
  } finally {
    await server.close()
  }
})
