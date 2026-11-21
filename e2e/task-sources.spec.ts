import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { encode } from '@motrix/torrent'
import type { ElectronApplication } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

for (const type of ['http', 'bt'] as const) {
  test(`${type} source edits survive desktop restart and download from the new source`, async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    test.setTimeout(120000)
    const payload = Buffer.alloc(16384, 71)
    const server = createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const first = match ? Number(match[1]) : 0
      const last = Math.min(
        match?.[2] ? Number(match[2]) : payload.length - 1,
        payload.length - 1
      )
      response.writeHead(match ? 206 : 200, {
        'Content-Length': last - first + 1,
        ETag: '"source-fixture"',
        'Accept-Ranges': 'bytes',
        ...(match
          ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` }
          : {}),
      })
      if (request.url === '/old' && last > first)
        response.write(payload.subarray(first, first + 1))
      else response.end(payload.subarray(first, last + 1))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port')
    const old = `http://127.0.0.1:${address.port}/old`
    const next = `http://127.0.0.1:${address.port}/new`
    const saveDir = path.join(userDataDir, 'downloads')
    await mkdir(saveDir, { recursive: true })
    let app: ElectronApplication | undefined
    try {
      app = await launchMotrix({ userDataDir, rpcPort })
      let page = await app.firstWindow()
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
      const tasks = async () =>
        (await invoke(Queries.ListTasks)) as DownloadTask[]
      const torrent = encode({
        info: {
          name: 'payload.bin',
          length: payload.length,
          'piece length': 16384,
          pieces: createHash('sha1').update(payload).digest(),
        },
        'url-list': [old],
      })
      await invoke(
        Commands.CreateTask,
        type === 'http'
          ? { type, uris: [old], saveDir, filename: 'payload.bin' }
          : {
              type,
              payload: {
                kind: 'torrent-base64',
                base64: Buffer.from(torrent).toString('base64'),
              },
              selectedFiles: [0],
              saveDir,
              seedRatio: 0,
            }
      )
      await expect
        .poll(async () => (await tasks())[0]?.status)
        .toBe('downloading')
      const original = (await tasks())[0]
      await invoke(Commands.PauseTask, original.id)
      await expect.poll(async () => (await tasks())[0]?.status).toBe('paused')
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await page.locator(`[data-task-id="${original.id}"]`).dblclick()
      const title = type === 'http' ? 'Download sources' : 'Web seeds'
      const card = page.getByRole('region', { name: title })
      await expect(card.getByText(old, { exact: true })).toBeVisible()
      await card.getByRole('button', { name: 'Edit', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await dialog.getByRole('textbox', { name: title }).fill(next)
      await page.screenshot({
        path: testInfo.outputPath(`${type}-source-edit.png`),
        animations: 'disabled',
      })
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(card.getByText(next, { exact: true })).toBeVisible()
      await app.close()
      app = await launchMotrix({ userDataDir, rpcPort })
      page = await app.firstWindow()
      await waitForEngineReady(page)
      await expect
        .poll(async () => (await tasks())[0]?.engineTaskId)
        .toBe(original.engineTaskId)
      const request = {
        taskId: original.id,
        engineTaskId: original.engineTaskId,
      }
      expect(await invoke(Queries.GetTaskSources, request)).toMatchObject({
        uris: [next],
        editable: true,
      })
      await invoke(Commands.ResumeTask, original.id)
      await expect
        .poll(
          async () =>
            ['completed', 'seeding'].includes((await tasks())[0]?.status),
          { timeout: 30000 }
        )
        .toBe(true)
      if ((await tasks())[0].status === 'seeding') {
        await invoke(Commands.StopSeedingTask, original.id)
        await expect
          .poll(async () => (await tasks())[0].status)
          .toBe('completed')
      }
      expect(await readFile(path.join(saveDir, 'payload.bin'))).toEqual(payload)
      expect((await tasks()).map((task) => task.id)).toEqual([original.id])
    } finally {
      await app?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
