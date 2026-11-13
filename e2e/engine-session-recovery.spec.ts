import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

test('a missing paused magnet directory cannot block startup or be recreated and the task remains removable', async ({
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
          method: `taiji.${method}`,
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
    await rpc('addUri', [
      [`magnet:?xt=urn:btih:${infoHash}`],
      { gid: childGid, dir: missingDir, pause: 'true' },
    ])
    await rpc('saveSession')
    await app.close()
    app = undefined

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
        .toBe('paused')
      const tasks = await readTasks(page)
      expect(tasks).toHaveLength(2)
      expect(
        tasks.find((task) => task.engineTaskId === healthyGid)?.status
      ).toBe('paused')
      const paused = tasks.find((task) => task.engineTaskId === childGid)!
      await expect(access(missingDir)).rejects.toMatchObject({ code: 'ENOENT' })
      if (boot === 1) {
        await page.evaluate(
          ({ channel, taskId }) =>
            window.motrix.invoke(channel, { taskId, deleteWithFiles: true }),
          { channel: Commands.RemoveTask, taskId: paused.id }
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
