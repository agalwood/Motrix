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

test.describe('task recovery — no pause', () => {
  // Validates the contract added by createAndPersist's
  // `await sessionManager.requestSave()`: when the IPC handler
  // returns, the task identity row is durable. A SIGKILL right
  // after must NOT cause the relaunch to mint a fresh motrix id
  // for the same gid via the "discovered from engine" path.
  test('task identity survives an immediate hard kill', async ({
    userDataDir,
  }) => {
    const port1 = await getFreePort()
    let fx: HttpFixture | undefined
    let app: ElectronApplication | undefined

    try {
      // 256 KB / 128 KB/s ≈ 2s — small + slow enough that the
      // download is still in-flight when we SIGKILL (the create-time
      // durability guarantee is what we want to exercise), but fast
      // enough that the orphan aria2 from launch 1 doesn't keep the
      // throttled connection alive long after launch 2's relaunch.
      fx = await startHttpFixture({
        size: 256 * 1024,
        throttleBytesPerSecond: 128 * 1024,
      })

      app = await launchMotrix({ userDataDir, rpcPort: port1 })
      let main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await waitForEngineReady(main)

      await main.getByRole('button', { name: 'New task' }).click()
      const addTaskPage = await findAddTaskWindow(app)
      await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(fx.fileUrl)
      // Click submit. The renderer awaits Commands.CreateDownload,
      // which on the main side awaits requestSave. By the time the
      // form's promise resolves, motrix.db has the row.
      await addTaskPage.getByRole('button', { name: 'Download' }).click()

      // Wait for the AddTaskWindow to auto-close (its own signal that
      // CreateDownload returned successfully → durability guaranteed).
      await addTaskPage.waitForEvent('close', { timeout: 5_000 })

      await main.getByRole('link', { name: 'Downloads' }).click()
      const taskBefore = await readFirstTask(main)
      expect(taskBefore?.id).toBeTruthy()

      // SIGKILL immediately — no pause, no extra wait. This is the
      // "user clicked Add then pulled the plug" scenario.
      app.process().kill('SIGKILL')
      await app.waitForEvent('close', { timeout: 5_000 }).catch(() => {})
      app = undefined

      const port2 = await getFreePort()
      app = await launchMotrix({ userDataDir, rpcPort: port2 })
      main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await waitForEngineReady(main)

      await main.getByRole('link', { name: 'Downloads' }).click()
      // Critical assertion: SAME task id. If create-time save raced
      // the SIGKILL, polling would resurrect the gid as a fresh task
      // with a different motrix id and this would fail.
      await expect
        .poll(async () => (await readFirstTask(main))?.id, { timeout: 15_000 })
        .toBe(taskBefore?.id)

      const taskAfter = await readFirstTask(main)
      expect(taskAfter?.uris).toEqual(taskBefore?.uris)
      expect(taskAfter?.status).not.toBe('error')
      expect(taskAfter?.status).not.toBe('removed')
    } finally {
      if (app) await app.close().catch(() => {})
      if (fx) await fx.close()
    }
  })
})
