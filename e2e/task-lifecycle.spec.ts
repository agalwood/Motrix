import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

interface Task {
  status: string
  progress: number
  downloadedBytes: number
  downloadSpeed: number
  uploadSpeed: number
  etaSeconds: number
  connections: number
  finalPath?: string
  errorMessage?: string
}

test.describe('task lifecycle', () => {
  test('http download transitions Downloading → Completed', async ({
    electronApp,
    mainWindow,
    userDataDir,
  }) => {
    await waitForEngineReady(mainWindow)

    // 1MB at 256 KB/s ≈ 4s on the wire — long enough for aria2 to
    // emit at least 2-3 polling cycles in the Downloading state, but
    // short enough that the test doesn't drag. Spec timeout is 60s.
    const fx = await startHttpFixture({
      size: 1024 * 1024,
      throttleBytesPerSecond: 256 * 1024,
    })

    try {
      await mainWindow.getByRole('button', { name: 'New task' }).click()
      const addTaskPage = await findAddTaskWindow(electronApp)
      await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(fx.fileUrl)
      await addTaskPage.getByRole('button', { name: 'Download' }).click()

      await mainWindow.getByRole('link', { name: 'Downloads' }).click()
      await expect.poll(() => mainWindow.url()).toContain('#/downloads')

      const row = mainWindow.getByRole('option').first()
      await expect(row).toBeVisible({ timeout: 10_000 })

      // Reads through window.motrix.invoke so the assertion exercises
      // the IPC pipeline alongside the engine. Asserting on the
      // canonical `TaskStatus` enum value (lowercase string) avoids
      // coupling to StatusPill's i18n mapping.
      const readTask = async (): Promise<Task | undefined> =>
        await mainWindow.evaluate(async () => {
          const api = (
            window as unknown as {
              motrix?: { invoke: (channel: string) => Promise<unknown> }
            }
          ).motrix
          if (!api) return undefined
          const tasks = (await api.invoke('query:listTasks')) as Task[]
          return tasks[0]
        })

      // Throttled stream → at least a couple of poll cycles in
      // Downloading before the body finishes.
      await expect
        .poll(async () => (await readTask())?.status, { timeout: 10_000 })
        .toBe('downloading')

      // Body (~4s) + finalize round-trip (rename `.motrix` → final).
      await expect
        .poll(async () => (await readTask())?.status, { timeout: 20_000 })
        .toBe('completed')

      // Final state checks — fail fast if status flipped to Completed
      // but the metrics / file path don't match expectations.
      const final = await readTask()
      expect(final?.progress).toBe(1)
      expect(final?.downloadedBytes).toBe(fx.fileSize)
      expect(final?.downloadSpeed).toBe(0)
      expect(final?.uploadSpeed).toBe(0)
      expect(final?.etaSeconds).toBe(0)
      expect(final?.connections).toBe(0)
      expect(final?.finalPath).toBe(
        path.join(userDataDir, 'downloads', 'test.bin')
      )
      // Renamed away from the `.motrix` in-flight container — the
      // finalize step's whole job.
      expect(existsSync(final?.finalPath ?? '')).toBe(true)
    } finally {
      await fx.close()
    }
  })
})
