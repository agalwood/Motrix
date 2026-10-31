import { writeFile } from 'node:fs/promises'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

test('the Downloads speed menu changes the limit of an already-running transfer in both directions', async ({
  electronApp,
  mainWindow: page,
}, testInfo) => {
  test.setTimeout(90_000)
  await waitForEngineReady(page)
  await page.evaluate(async (channel) => {
    await window.motrix.invoke(channel, {
      app: { byteUnitSystem: 'decimal', warnBeforeQuit: false },
      nat: { enabled: false },
      speedLimit: {
        turtle: 'off',
        base: { download: 100_000, upload: 0 },
        alt: { download: 512_000, upload: 0 },
      },
    })
  }, Commands.UpdateSettings)
  const server = await startHttpFixture({ size: 16 * 1024 * 1024 })
  const readTask = () =>
    page.evaluate(async (channel) => {
      const tasks = (await window.motrix.invoke(channel)) as DownloadTask[]
      return tasks[0]
    }, Queries.ListTasks)
  const readLimit = () =>
    page.evaluate(async (channel) => {
      const state = (await window.motrix.invoke(channel)) as {
        effective: { download: number }
      }
      return state.effective.download
    }, Queries.GetSpeedLimitState)
  const samples: Array<{
    time: number
    bytes: number
    speed: number
    limit: number
  }> = []
  const sample = async () => {
    const task = await readTask()
    samples.push({
      time: performance.now(),
      bytes: task?.downloadedBytes ?? 0,
      speed: task?.downloadSpeed ?? 0,
      limit: await readLimit(),
    })
    return task
  }
  const measureRate = async (seconds = 4) => {
    const before = await sample()
    const start = performance.now()
    // Sample transferred bytes over multiple engine polls, rather than only
    // checking the configured limit or a smoothed speed label.
    let after = before
    for (let i = 0; i < seconds; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      after = await sample()
    }
    expect(before?.status).toBe('downloading')
    expect(after?.status).toBe('downloading')
    expect(after?.engineTaskId).toBe(before?.engineTaskId)
    return (
      (((after?.downloadedBytes ?? 0) - (before?.downloadedBytes ?? 0)) *
        1000) /
      (performance.now() - start)
    )
  }
  const waitForSteadyRate = async (limit: number) => {
    let consecutive = 0
    // aria2 can briefly burst or drain its rate window after a limit changes.
    // Require multiple fresh polls in range before measuring sustained bytes.
    await expect
      .poll(
        async () => {
          const speed = (await readTask())?.downloadSpeed ?? 0
          consecutive =
            speed >= limit * 0.7 && speed <= limit * 1.4 ? consecutive + 1 : 0
          return consecutive
        },
        { timeout: 20_000, intervals: [1000] }
      )
      .toBeGreaterThanOrEqual(3)
  }
  try {
    await page.getByRole('button', { name: 'New task' }).click()
    const addTask = await findAddTaskWindow(electronApp)
    await addTask.getByRole('textbox', { name: 'URLs' }).fill(server.fileUrl)
    // Isolate profile switching from parallel connections starting new ranges.
    const connections = addTask.getByRole('spinbutton', {
      name: 'Connections',
      exact: true,
    })
    if (!(await connections.isVisible())) {
      await addTask
        .getByRole('button', { name: 'Advanced', exact: true })
        .click()
    }
    await connections.fill('1')
    await addTask.getByRole('button', { name: 'Download' }).click()
    await expect(
      page.getByRole('heading', { name: 'Task Inspector', exact: true })
    ).toBeVisible()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect
      .poll(async () => (await readTask())?.downloadedBytes ?? 0)
      .toBeGreaterThan(100_000)
    const initialTask = await readTask()
    expect(initialTask?.connections).toBe(1)
    expect(await readLimit()).toBe(100_000)
    await waitForSteadyRate(100_000)
    const standardRate = await measureRate()
    expect(standardRate).toBeGreaterThan(30_000)
    expect(standardRate).toBeLessThan(200_000)

    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Speed mode: Standard' }).click()
    await page.getByRole('menuitemradio', { name: 'Low-speed mode' }).click()
    await expect.poll(readLimit).toBe(512_000)
    // Include both the initial burst and subsequent throttling. Discarding the
    // burst biases a short sample even when the long-term cap is correct.
    const lowModeRate = await measureRate(12)
    expect(lowModeRate).toBeGreaterThan(250_000)
    expect(lowModeRate).toBeLessThan(800_000)

    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Speed mode: Low speed' }).click()
    await page.getByRole('menuitemradio', { name: 'Standard mode' }).click()
    await expect.poll(readLimit).toBe(100_000)
    await waitForSteadyRate(100_000)
    const restoredRate = await measureRate()
    expect(restoredRate).toBeGreaterThan(30_000)
    expect(restoredRate).toBeLessThan(200_000)
    expect((await readTask())?.engineTaskId).toBe(initialTask?.engineTaskId)

    const ratesFile = testInfo.outputPath('transfer-rates.json')
    await writeFile(
      ratesFile,
      JSON.stringify({ standardRate, lowModeRate, restoredRate })
    )
    await testInfo.attach('transfer-rates', {
      path: ratesFile,
      contentType: 'application/json',
    })
    await page.evaluate(
      async ({ channel, id }) => {
        await window.motrix.invoke(channel, id)
      },
      { channel: Commands.PauseTask, id: initialTask?.id }
    )
  } finally {
    await writeFile(
      testInfo.outputPath('transfer-samples.json'),
      JSON.stringify(samples, null, 2)
    )
    await server.close()
  }
})
