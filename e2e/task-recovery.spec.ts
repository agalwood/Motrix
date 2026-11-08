import type { ElectronApplication, Page } from '@playwright/test'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { type HttpFixture, startHttpFixture } from './fixtures/http-server'
import { getFreePort } from './helpers/free-port'

interface Task {
  id: string
  status: string
  uris: string[]
  engineTaskId: string
  errorMessage?: string
}

async function openMain(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function readFirstTask(page: Page): Promise<Task | undefined> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) return undefined
    const tasks = (await api.invoke('query:listTasks')) as Task[]
    return tasks[0]
  })
}

async function pauseTaskViaIpc(page: Page, taskId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    await api?.invoke('command:pauseTask', id)
  }, taskId)
}

test.describe('task recovery', () => {
  test('paused task is restored after a hard kill', async ({ userDataDir }) => {
    // Manage rpcPort + electronApp manually because we relaunch the
    // app inside this test. The fixture closes its app at end-of-test
    // which would conflict with us spawning a second instance.
    const port1 = await getFreePort()
    let fx: HttpFixture | undefined
    let app: ElectronApplication | undefined

    try {
      // 1MB at 64 KB/s ≈ 16s on the wire — plenty of room to pause
      // mid-download (transition save fires) before SIGKILL.
      fx = await startHttpFixture({
        size: 1024 * 1024,
        throttleBytesPerSecond: 64 * 1024,
      })

      // ─── Run 1: add → downloading → pause → SIGKILL ──────────────
      app = await launchMotrix({ userDataDir, rpcPort: port1 })
      let main = await openMain(app)
      await waitForEngineReady(main)

      await main.getByRole('button', { name: 'New task' }).click()
      const addTaskPage = await findAddTaskWindow(app)
      await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(fx.fileUrl)
      await addTaskPage.getByRole('button', { name: 'Download' }).click()

      await main.getByRole('link', { name: 'Downloads' }).click()
      await expect
        .poll(async () => (await readFirstTask(main))?.status, {
          timeout: 10_000,
        })
        .toBe('downloading')

      const taskBefore = await readFirstTask(main)
      expect(taskBefore?.id).toBeTruthy()

      // Pausing during Downloading triggers
      // shouldTriggerTransitionSave → SessionManager.save() flushes
      // motrix.db before we kill the process. Without this we'd race
      // the 15s auto-save interval; aria2's own --save-session would
      // still recover the GID, but the motrix-side task row would
      // arrive on relaunch as "discovered from engine" with a fresh
      // task id, making same-id assertions impossible.
      await pauseTaskViaIpc(main, taskBefore?.id ?? '')
      await expect
        .poll(async () => (await readFirstTask(main))?.status, {
          timeout: 5_000,
        })
        .toBe('paused')

      // Small grace window for the transition save's writeFile +
      // SQLite WAL fsync to land before we SIGKILL.
      await main.waitForTimeout(500)

      // SIGKILL (not close()) so before-quit / performCleanup don't
      // run. This is the crash scenario.
      const child = app.process()
      child.kill('SIGKILL')
      await app.waitForEvent('close', { timeout: 5_000 }).catch(() => {})
      app = undefined

      // ─── Run 2: relaunch → assert restore ────────────────────────
      // New port: the orphaned aria2 from run 1 may briefly hold
      // port1. Using a fresh port keeps the test deterministic.
      const port2 = await getFreePort()
      app = await launchMotrix({ userDataDir, rpcPort: port2 })
      main = await openMain(app)
      await waitForEngineReady(main)

      await main.getByRole('link', { name: 'Downloads' }).click()
      await expect
        .poll(async () => (await readFirstTask(main))?.id, { timeout: 15_000 })
        .toBe(taskBefore?.id)

      const taskAfter = await readFirstTask(main)
      expect(taskAfter?.uris).toEqual(taskBefore?.uris)
      // Status comes back as paused (or downloading/completed if
      // aria2 resumed before the snapshot). Just rule out the
      // failure modes.
      expect(taskAfter?.status).not.toBe('error')
      expect(taskAfter?.status).not.toBe('removed')
    } finally {
      if (app) await app.close().catch(() => {})
      if (fx) await fx.close()
    }
  })
})
