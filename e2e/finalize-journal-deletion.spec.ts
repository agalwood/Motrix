import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppNotification } from '@shared/types/notification'
import type { DownloadTask } from '@shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

const taskIds = ['finalize-single', 'finalize-bulk', 'finalize-cleaned']

function seedFailedTasks(userDataDir: string) {
  const db = new DatabaseSync(path.join(userDataDir, 'motrix.db'))
  try {
    for (const id of [...taskIds, 'finalize-legacy-orphan']) {
      const saveDir = path.join(userDataDir, 'downloads')
      const target = path.join(saveDir, `${id}.bin`)
      const source = `${target}.motrix`
      const phase = id === 'finalize-cleaned' ? 'cleaned' : 'prepared'
      const identity = {
        kind: 'file',
        size: 1,
        sha256: 'a'.repeat(64),
        platformFileId: `file-${id}`,
      }
      const record = {
        journalId: `journal-${id}`,
        phase,
        plan: {
          planId: `journal-${id}`,
          taskId: id,
          saveDir,
          sourcePath: source,
          targetPath: target,
          sourceIdentity: identity,
          metadataOps: [],
          contributors: [],
        },
      }
      db.prepare(`INSERT INTO plugin_finalize_journals (
        plan_id, task_id, phase, plan_json, source_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1000, 1000)`).run(
        record.journalId,
        id,
        phase,
        JSON.stringify(record),
        JSON.stringify(identity)
      )
      if (id === 'finalize-legacy-orphan') continue
      db.prepare(`INSERT INTO tasks (
        motrix_id, name, task_type, created_at, updated_at,
        save_dir, final_path, final_name, agg_status
      ) VALUES (?, ?, 'http', 1000, 1000, ?, ?, ?, 'error')`).run(
        id,
        id,
        saveDir,
        target,
        `${id}.bin`
      )
      db.prepare(`INSERT INTO task_instances (
        instance_id, motrix_id, phase, status, disk_path, created_at, updated_at
      ) VALUES (?, ?, 'http_download', 'error', ?, 1000, 1000)`).run(
        `instance-${id}`,
        id,
        source
      )
    }
  } finally {
    db.close()
  }
}

async function tasks(page: Page): Promise<DownloadTask[]> {
  return page.evaluate(
    (channel) => window.motrix.invoke(channel),
    Queries.ListTasks
  ) as Promise<DownloadTask[]>
}

async function taskNotifications(page: Page) {
  const notifications = (await page.evaluate(
    (channel) => window.motrix.invoke(channel),
    Queries.ListNotifications
  )) as AppNotification[]
  return notifications.filter(
    (notification) =>
      notification.taskId && taskIds.includes(notification.taskId)
  )
}

test('removed and cleared failed finalizations stay cancelled through two app restarts', async ({
  userDataDir,
  rpcPort,
}) => {
  test.setTimeout(120_000)
  let app: ElectronApplication | undefined
  try {
    app = await launchMotrix({ userDataDir, rpcPort })
    await waitForEngineReady(await app.firstWindow())
    await app.close()
    app = undefined
    seedFailedTasks(userDataDir)

    app = await launchMotrix({ userDataDir, rpcPort })
    let page = await app.firstWindow()
    await waitForEngineReady(page)
    await expect
      .poll(async () => (await tasks(page)).map((task) => task.id).sort())
      .toEqual([...taskIds].sort())
    const notifications = await taskNotifications(page)
    await page.evaluate(
      ({ channel, taskId }) =>
        window.motrix.invoke(channel, {
          taskId,
          deleteWithFiles: false,
        }),
      { channel: Commands.RemoveTask, taskId: taskIds[0] }
    )
    await page.evaluate(
      ({ channel, taskIds }) => window.motrix.invoke(channel, taskIds),
      {
        channel: Commands.ClearStoppedTasks,
        taskIds: taskIds.slice(1),
      }
    )
    await expect.poll(() => tasks(page)).toEqual([])
    await app.close()
    app = undefined

    for (let restart = 0; restart < 2; restart++) {
      app = await launchMotrix({ userDataDir, rpcPort })
      page = await app.firstWindow()
      await waitForEngineReady(page)
      expect(await tasks(page)).toEqual([])
      expect(await taskNotifications(page)).toEqual(notifications)
      await app.close()
      app = undefined
      const db = new DatabaseSync(path.join(userDataDir, 'motrix.db'))
      try {
        const journals = db
          .prepare(`SELECT task_id, phase, quarantine_reason
          FROM plugin_finalize_journals ORDER BY task_id`)
          .all()
        expect(journals).toEqual(
          ['finalize-bulk', 'finalize-legacy-orphan', 'finalize-single'].map(
            (taskId) => ({
              task_id: taskId,
              phase: 'quarantined',
              quarantine_reason: 'task-deleted',
            })
          )
        )
        expect(db.prepare('SELECT motrix_id FROM tasks').all()).toEqual([])
      } finally {
        db.close()
      }
    }
  } finally {
    await app?.close().catch(() => {})
  }
})
