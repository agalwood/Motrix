import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

async function readTasks(page: Page): Promise<DownloadTask[]> {
  return page.evaluate(
    (channel) => window.motrix.invoke(channel),
    Queries.ListTasks
  ) as Promise<DownloadTask[]>
}

test('a missing magnet directory cannot block startup and its failed task remains removable', async ({
  userDataDir,
  rpcPort,
}) => {
  test.setTimeout(120_000)
  let app: ElectronApplication | undefined
  const infoHash = 'a'.repeat(40)
  const childGid = '2222222222222222'
  const missingDir = path.join(userDataDir, 'deleted-torrent')
  try {
    const retainedFile = path.join(userDataDir, 'downloads', 'retained.txt')
    await mkdir(path.dirname(retainedFile), { recursive: true })
    await writeFile(retainedFile, 'unrelated download')
    app = await launchMotrix({ userDataDir, rpcPort })
    let page = await app.firstWindow()
    await waitForEngineReady(page)
    const settings = JSON.parse(
      await readFile(path.join(userDataDir, 'settings.json'), 'utf8')
    ) as { engine: { rpcSecret: string } }
    const rpc = async (
      method: string,
      params: unknown[] = []
    ): Promise<unknown> => {
      const response = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'session-recovery',
          method: `aria2.${method}`,
          params: [`token:${settings.engine.rpcSecret}`, ...params],
        }),
      })
      const reply = (await response.json()) as {
        result: unknown
        error?: { message: string }
      }
      if (reply.error) throw new Error(reply.error.message)
      return reply.result
    }
    const healthyGid = (await rpc('addUri', [
      ['http://127.0.0.1:1/healthy.bin'],
      { pause: 'true' },
    ])) as string
    await rpc('saveSession')
    await app.close()
    app = undefined

    // Use the real engine's schema and an orphaned metadata ancestor, as can
    // remain after an earlier cleanup. The child serializes the ancestor GID.
    const db = new DatabaseSync(path.join(userDataDir, 'aria2.db'))
    try {
      const row = db
        .prepare('SELECT * FROM task WHERE gid = ?')
        .get(healthyGid)!
      const serialized = `magnet:?xt=urn:btih:${infoHash}\n gid=1111111111111111\n dir=${missingDir}\n pause=true\n`
      Object.assign(row, {
        gid: childGid,
        state: 'paused',
        serialized,
        queue_position: 1,
        digest: createHash('sha1').update(serialized).update('paused').digest(),
      })
      const columns = Object.keys(row)
      db.prepare(
        `INSERT INTO task (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      ).run(...Object.values(row))
    } finally {
      db.close()
    }
    await mkdir(missingDir)
    await rm(missingDir, { recursive: true })

    for (let boot = 0; boot < 2; boot++) {
      app = await launchMotrix({ userDataDir, rpcPort })
      page = await app.firstWindow()
      await waitForEngineReady(page)
      await expect
        .poll(
          async () =>
            (await readTasks(page)).find(
              (task) => task.engineTaskId === childGid
            )?.status
        )
        .toBe('error')
      const tasks = await readTasks(page)
      expect(tasks).toHaveLength(2)
      expect(
        tasks.find((task) => task.engineTaskId === healthyGid)?.status
      ).toBe('paused')
      const failed = tasks.find((task) => task.engineTaskId === childGid)!
      expect(failed.errorDetailKey).toBe('task.error.detail.filesMissing')
      await expect(access(missingDir)).rejects.toMatchObject({ code: 'ENOENT' })
      if (boot === 1) {
        await page.evaluate(
          ({ channel, taskId }) =>
            window.motrix.invoke(channel, { taskId, deleteWithFiles: true }),
          { channel: Commands.RemoveTask, taskId: failed.id }
        )
        await expect
          .poll(async () =>
            (await readTasks(page)).map((task) => task.engineTaskId)
          )
          .toEqual([healthyGid])
        expect(await readFile(retainedFile, 'utf8')).toBe('unrelated download')
      }
      await app.close()
      app = undefined
    }
  } finally {
    await app?.close().catch(() => {})
  }
})
