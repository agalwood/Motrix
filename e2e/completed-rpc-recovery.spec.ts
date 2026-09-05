import { access, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Queries } from '../src/shared/protocol/queries'
import type { DownloadTask } from '../src/shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { startHttpFixture } from './fixtures/http-server'

async function readTasks(page: Page): Promise<DownloadTask[]> {
  return page.evaluate(async (channel) => {
    const api = (
      window as unknown as {
        motrix: { invoke: (channel: string) => Promise<DownloadTask[]> }
      }
    ).motrix
    return api.invoke(channel)
  }, Queries.ListTasks)
}

test('completed raw RPC download stays deleted after restart and a new same-URL task stays independent', async ({
  userDataDir,
  rpcPort,
}) => {
  const fixture = await startHttpFixture({ size: 1024 })
  let app: ElectronApplication | undefined
  try {
    app = await launchMotrix({ userDataDir, rpcPort })
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForEngineReady(page)
    const settings = JSON.parse(
      await readFile(path.join(userDataDir, 'settings.json'), 'utf8')
    ) as { engine: { rpcSecret: string } }
    const rpc = async <T>(
      method: string,
      params: unknown[] = []
    ): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'completed-rpc-recovery',
          method: `aria2.${method}`,
          params: [`token:${settings.engine.rpcSecret}`, ...params],
        }),
      })
      const reply = (await response.json()) as {
        result: T
        error?: { message: string }
      }
      if (reply.error) throw new Error(reply.error.message)
      return reply.result
    }
    const gid = await rpc<string>('addUri', [[fixture.fileUrl]])
    await expect
      .poll(
        async () =>
          (await readTasks(page)).find((task) => task.engineTaskId === gid)
            ?.status
      )
      .toBe('completed')
    const before = (await readTasks(page)).find(
      (task) => task.engineTaskId === gid
    )!
    expect(before.diskPath).toBe(before.finalPath)
    expect(await fixture.verifyFile(before.finalPath)).toBe(true)
    await expect
      .poll(async () =>
        rpc('tellStatus', [gid]).then(
          () => false,
          (error: Error) => /not found/i.test(error.message)
        )
      )
      .toBe(true)
    await unlink(before.finalPath)
    await app.close()
    app = undefined
    fixture.resetRequests()

    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForEngineReady(page)
    await expect
      .poll(
        async () =>
          (await readTasks(page)).find((task) => task.id === before.id)?.status
      )
      .toBe('completed')
    const restored = (await readTasks(page)).find(
      (task) => task.id === before.id
    )
    expect(restored?.finishedAt).toBe(before.finishedAt)
    expect(restored?.downloadedBytes).toBe(fixture.fileSize)
    await expect(rpc('tellStatus', [gid])).rejects.toThrow(/not found/i)
    expect(fixture.requests()).toHaveLength(0)
    await expect(access(before.finalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const freshGid = await rpc<string>('addUri', [
      [fixture.fileUrl],
      { out: 'independent.bin' },
    ])
    expect(freshGid).not.toBe(gid)
    await expect
      .poll(
        async () =>
          (await readTasks(page)).find((task) => task.engineTaskId === freshGid)
            ?.status
      )
      .toBe('completed')
    expect(
      (await readTasks(page)).find((task) => task.id === before.id)?.finishedAt
    ).toBe(before.finishedAt)
    expect(
      await fixture.verifyFile(
        path.join(userDataDir, 'downloads', 'independent.bin')
      )
    ).toBe(true)
  } finally {
    await app?.close().catch(() => {})
    await fixture.close()
  }
})
