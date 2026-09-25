import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import type { TaskInspectorActivitySnapshot } from '@shared/types/task-inspector-activity'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

test('unlimited BT seeding, inspector metrics and re-seeding survive engine restart', async ({
  electronApp,
  mainWindow,
  userDataDir,
  rpcPort,
}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await startHttpFixture({ size: 16_384 })
  let restarted: Awaited<ReturnType<typeof launchMotrix>> | undefined
  try {
    const payload = Buffer.from(
      await (await fetch(fixture.fileUrl)).arrayBuffer()
    )
    // Private, local-webseed-only torrent: no tracker or public peer discovery.
    const torrent = Buffer.concat([
      Buffer.from(
        `d4:infod6:lengthi${payload.length}e4:name8:test.bin12:piece lengthi16384e6:pieces20:`
      ),
      createHash('sha1').update(payload).digest(),
      Buffer.from(
        `7:privatei1ee8:url-list${Buffer.byteLength(fixture.fileUrl)}:${fixture.fileUrl}e`
      ),
    ]).toString('base64')
    await waitForEngineReady(mainWindow)
    const invoke = (
      page: Page,
      channel:
        | (typeof Commands)[keyof typeof Commands]
        | (typeof Queries)[keyof typeof Queries],
      value?: unknown
    ) =>
      page.evaluate(
        ({ channel, value }) => window.motrix.invoke(channel, value),
        { channel, value }
      )
    await invoke(mainWindow, Commands.UpdateSettings, {
      engine: { seedTime: 1, seedRatio: 1 },
    })
    await invoke(mainWindow, Commands.UpdateSettings, {
      engine: { seedTime: 0, seedRatio: 0 },
    })
    await invoke(mainWindow, Commands.CreateTask, {
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: torrent },
      selectedFiles: [0],
      saveDir: path.join(userDataDir, 'downloads'),
    })
    const readTask = async (page = mainWindow) =>
      ((await invoke(page, Queries.ListTasks)) as DownloadTask[])[0]
    const expectInternalTorrentStorage = async (task: DownloadTask) => {
      expect(task.saveDir).toBe(path.join(userDataDir, 'downloads'))
      const metadataPath = path.join(
        userDataDir,
        'torrents',
        `${task.id}.torrent`
      )
      expect(task.torrentMetaPath).toBe(metadataPath)
      const bytes = Buffer.from(torrent, 'base64')
      expect(await readFile(metadataPath)).toEqual(bytes)
      const rpcMetadataName = `${createHash('sha1').update(bytes).digest('hex')}.torrent`
      expect(
        await readFile(path.join(`${metadataPath}.state`, rpcMetadataName))
      ).toEqual(bytes)
      expect(
        (await readdir(task.saveDir)).filter((name) =>
          name.endsWith('.torrent')
        )
      ).toEqual([])
    }
    const readActivity = async (page = mainWindow) => {
      const result = (await invoke(page, Queries.GetTaskInspectorActivity, {
        taskId: (await readTask(page)).id,
      })) as {
        ok: boolean
        value?: TaskInspectorActivitySnapshot
        error?: { message: string }
      }
      if (!result.ok || !result.value)
        throw new Error(result.error?.message ?? 'Inspector query failed')
      return result.value
    }
    const seedingMs = async (page = mainWindow) =>
      (await readActivity(page)).summary.seeding?.activeMs ?? 0
    await expect
      .poll(async () => (await readTask())?.status, { timeout: 25_000 })
      .toBe('seeding')
    const first = await readTask()
    expect(first.progress).toBe(1)
    expect(await fixture.verifyFile(first.finalPath)).toBe(true)
    await expectInternalTorrentStorage(first)
    // Inspector Activity publishes durable checkpoints every 30 seconds.
    await expect.poll(() => seedingMs(), { timeout: 40_000 }).toBeGreaterThan(0)
    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await mainWindow.locator(`[data-task-id="${first.id}"]`).dblclick()
    const inspector = mainWindow.getByTestId('task-inspector-drawer-content')
    await expect(inspector.getByText('Uploaded', { exact: true })).toBeVisible()
    await expect(
      inspector.getByText('Seeding time', { exact: true })
    ).toBeVisible()
    await expect(
      inspector.locator('[data-slot="task-seeding-duration"]')
    ).not.toHaveText('—')
    await mainWindow.screenshot({
      path: testInfo.outputPath('seeding-metrics.png'),
    })

    await invoke(mainWindow, Commands.PauseTask, first.id)
    await expect.poll(async () => (await readTask()).status).toBe('paused')
    const pausedMs = await seedingMs()
    await mainWindow.waitForTimeout(1500)
    expect(await seedingMs()).toBe(pausedMs)
    await invoke(mainWindow, Commands.ResumeTask, first.id)
    await expect.poll(async () => (await readTask()).status).toBe('seeding')
    await mainWindow.waitForTimeout(2500)
    await invoke(mainWindow, Commands.StopSeedingTask, first.id)
    await expect.poll(async () => (await readTask()).status).toBe('completed')
    const stoppedMs = await seedingMs()
    expect(stoppedMs).toBeGreaterThan(pausedMs)
    await invoke(mainWindow, Commands.ReAddTask, first.id)
    await expect.poll(async () => (await readTask()).status).toBe('seeding')
    expect((await readTask()).engineTaskId).not.toBe(first.engineTaskId)
    await expectInternalTorrentStorage(await readTask())
    await mainWindow.waitForTimeout(2500)
    const beforeRestart = await seedingMs()
    await electronApp.close()
    restarted = await launchMotrix({ userDataDir, rpcPort })
    const nextWindow = await restarted.firstWindow()
    await waitForEngineReady(nextWindow)
    await expect
      .poll(async () => (await readTask(nextWindow))?.status, {
        timeout: 15_000,
      })
      .toBe('seeding')
    await expectInternalTorrentStorage(await readTask(nextWindow))
    const afterRestart = await seedingMs(nextWindow)
    expect(afterRestart).toBeGreaterThanOrEqual(beforeRestart)
    expect(afterRestart).toBeGreaterThan(stoppedMs)
    await expect
      .poll(() => seedingMs(nextWindow), { timeout: 40_000 })
      .toBeGreaterThan(afterRestart)
  } finally {
    await restarted?.close()
    await fixture.close()
  }
})
