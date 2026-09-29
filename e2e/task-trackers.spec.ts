import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import type { DownloadTask } from '../src/shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { getFreePort } from './helpers/free-port'

const old = 'http://127.0.0.1:9/old'
const fresh = 'http://127.0.0.1:10/new'
const manual = 'http://127.0.0.1:11/manual'
const native = 'http://127.0.0.1:12/native'
const sources = [
  {
    id: 'first',
    label: 'First',
    url: 'http://127.0.0.1:9/first.txt',
    enabled: true,
    builtin: false,
  },
  {
    id: 'second',
    label: 'Second',
    url: 'http://127.0.0.1:9/second.txt',
    enabled: false,
    builtin: false,
  },
]

for (const active of [false, true]) {
  test(`task Tracker preview preserves ownership with active=${active}`, async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    test.setTimeout(90000)
    const now = Date.now()
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        app: { language: 'en-US', warnBeforeQuit: false },
        engine: {
          dhtEnabled: false,
          listenPort: await getFreePort(),
          btEnableLpd: false,
        },
        tracker: {
          autoSync: false,
          probeEnabled: false,
          blacklistEnabled: false,
          sources,
        },
        onboarding: { disclaimerAccepted: true },
      })
    )
    await writeFile(
      path.join(userDataDir, 'tracker.json'),
      JSON.stringify({
        version: 2,
        effective: [old],
        snapshots: Object.fromEntries(
          sources.map((source, index) => [
            `tracker:${source.id}`,
            {
              ...source,
              kind: 'tracker',
              urls: [index ? fresh : old],
              lastAttemptAt: now,
              lastSuccessAt: now,
              contentChangedAt: now,
              error: null,
              failures: 0,
              nextRetryAt: null,
            },
          ])
        ),
      })
    )
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      const page = await app.firstWindow()
      await waitForEngineReady(page)
      const invoke = (
        channel:
          | (typeof Commands)[keyof typeof Commands]
          | (typeof Queries)[keyof typeof Queries],
        value?: unknown
      ) =>
        page.evaluate(
          ({ channel, value }) => window.motrix.invoke(channel, value),
          { channel, value }
        )
      await expect
        .poll(
          async () =>
            ((await invoke(Queries.GetTrackerList)) as { effective: string[] })
              .effective
        )
        .toEqual([old])
      const payload = Buffer.from('0123456789')
      const torrent = Buffer.concat([
        Buffer.from(
          `d8:announce${native.length}:${native}4:infod6:lengthi10e4:name8:test.bin12:piece lengthi16384e6:pieces20:`
        ),
        createHash('sha1').update(payload).digest(),
        Buffer.from('ee'),
      ]).toString('base64')
      await invoke(Commands.CreateTask, {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: torrent },
        selectedFiles: [0],
        saveDir: path.join(userDataDir, 'downloads'),
      })
      const readTask = async () =>
        ((await invoke(Queries.ListTasks)) as DownloadTask[])[0]!
      await expect
        .poll(async () => (await readTask())?.engineTaskId)
        .toBeTruthy()
      const task = await readTask()
      await invoke(Commands.PauseTask, task.id)
      await invoke(Commands.SetTaskBtTracker, {
        taskId: task.id,
        engineGid: task.engineTaskId,
        trackers: [old, manual],
      })
      if (active) {
        await invoke(Commands.ResumeTask, task.id)
        await expect
          .poll(async () => (await readTask()).status)
          .toBe('downloading')
      }
      await invoke(Commands.UpdateSettings, {
        tracker: {
          sources: sources.map((source) => ({
            ...source,
            enabled: !source.enabled,
          })),
        },
      })
      await expect
        .poll(
          async () =>
            ((await invoke(Queries.GetTrackerList)) as { effective: string[] })
              .effective
        )
        .toEqual([fresh])
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await page.locator(`[data-task-id="${task.id}"]`).dblclick()
      const inspector = page.getByTestId('task-inspector-drawer-content')
      await inspector
        .getByRole('tab', { name: 'Trackers', exact: true })
        .click()
      await inspector.getByRole('button', { name: 'Sync', exact: true }).click()
      const dialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Update task trackers' }),
      })
      await expect(dialog).toBeVisible()
      const overlay = page.locator('[data-slot="dialog-overlay"]')
      await expect(overlay).toBeVisible()
      await expect(overlay).toHaveCSS('opacity', '1')
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
      await expect(dialog.getByText(old, { exact: true })).toBeVisible()
      await expect(dialog.getByText(fresh, { exact: true })).toBeVisible()
      await expect(dialog.getByText(/briefly pause/)).toHaveCount(
        active ? 1 : 0
      )
      await expect(dialog).toHaveCSS('opacity', '1')
      await page.screenshot({
        path: testInfo.outputPath('tracker-task-diff.png'),
        animations: 'disabled',
      })
      await dialog.getByRole('button', { name: 'Apply update' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(overlay).toHaveCount(0)
      await expect
        .poll(async () => (await readTask()).status)
        .toBe(active ? 'downloading' : 'paused')
      expect(
        await invoke(Queries.GetTaskBtTracker, { engineGid: task.engineTaskId })
      ).toEqual([manual, fresh])
      await expect(inspector.getByText(manual, { exact: true })).toBeVisible()
      const freshRow = inspector.getByText(fresh, { exact: true }).locator('..')
      await freshRow.hover()
      await freshRow.getByRole('button', { name: 'Delete tracker' }).click()
      await expect
        .poll(
          async () =>
            await invoke(Queries.GetTaskBtTracker, {
              engineGid: task.engineTaskId,
            })
        )
        .toEqual([manual])
      await inspector.getByRole('button', { name: 'Sync', exact: true }).click()
      await expect(
        dialog.getByRole('button', { name: 'Apply update' })
      ).toBeDisabled()
      await expect(dialog.getByText(/you removed/)).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('tracker-task-exclusion.png'),
        animations: 'disabled',
      })
    } finally {
      await app.close()
    }
  })
}
