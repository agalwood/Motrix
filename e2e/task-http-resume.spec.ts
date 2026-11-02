import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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

for (const restart of [false, true]) {
  test(`HTTP Retry continues the original task after network loss (restart=${restart})`, async ({
    mainWindow,
    electronApp,
    userDataDir,
    rpcPort,
  }) => {
    test.setTimeout(90000)
    let page = mainWindow
    let restarted: ElectronApplication | undefined
    let interrupted = true
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x6d)
    const requests: Array<{ range?: string; authorization?: string }> = []
    const server = createServer((request, response) => {
      requests.push({
        range: request.headers.range,
        authorization: request.headers.authorization,
      })
      if (request.headers.authorization !== 'Bearer synthetic-resume-token') {
        response.writeHead(401).end()
        return
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const offset = Number(range?.[1] ?? 0)
      const end = range?.[2] ? Number(range[2]) : payload.length - 1
      const bytes = payload.subarray(offset, end + 1)
      response.writeHead(range ? 206 : 200, {
        'content-length': bytes.length,
        'accept-ranges': 'bytes',
        etag: '"original-fixture"',
        ...(range
          ? { 'content-range': `bytes ${offset}-${end}/${payload.length}` }
          : {}),
      })
      if (interrupted) {
        response.write(bytes.subarray(0, 512 * 1024))
        setTimeout(() => response.destroy(), 100)
      } else response.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const invoke = (
      target: Page,
      channel:
        | (typeof Commands)[keyof typeof Commands]
        | (typeof Queries)[keyof typeof Queries],
      value?: unknown
    ) =>
      target.evaluate(
        ({ channel, value }) => window.motrix.invoke(channel, value),
        { channel, value }
      )
    const tasks = async () =>
      (await invoke(page, Queries.ListTasks)) as DownloadTask[]
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('missing address')
      const saveDir = path.join(userDataDir, 'downloads')
      await mkdir(saveDir, { recursive: true })
      await waitForEngineReady(page)
      await invoke(page, Commands.UpdateSettings, {
        engine: {
          maxTries: 1,
          retryWait: 0,
          split: 1,
          maxConnectionPerServer: 1,
        },
      })
      await invoke(page, Commands.CreateTask, {
        type: 'http',
        uris: [`http://127.0.0.1:${address.port}/fixture.bin`],
        saveDir,
        filename: 'fixture.bin',
        headers: [
          { name: 'Authorization', value: 'Bearer synthetic-resume-token' },
        ],
      })
      await expect
        .poll(async () => (await tasks())[0]?.status, { timeout: 20000 })
        .toBe('error')
      const original = (await tasks())[0]
      const recipe = original.instances[0]?.payload.directReplay as
        | { engineContextVersion?: number }
        | undefined
      test.skip(
        recipe?.engineContextVersion !== 1 &&
          process.env.MOTRIX_REQUIRE_HTTP_RETRY_TEST !== '1',
        'Requires an engine with native HTTP retry support'
      )
      expect(recipe?.engineContextVersion).toBe(1)
      const partial = await readFile(original.diskPath)
      expect(partial.length).toBeGreaterThan(0)
      const mark = requests.length
      if (restart) {
        await electronApp.close()
        restarted = await launchMotrix({ userDataDir, rpcPort })
        page = await restarted.firstWindow()
        await waitForEngineReady(page)
        await expect.poll(async () => (await tasks())[0]?.status).toBe('error')
        expect(requests).toHaveLength(mark)
      }
      interrupted = false
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await page.locator(`[data-task-id="${original.id}"]`).dblclick()
      await page
        .getByRole('button', { name: 'Retry', exact: true })
        .first()
        .click()
      await expect
        .poll(async () => (await tasks())[0]?.status, { timeout: 20000 })
        .toBe('completed')
      expect(await tasks()).toHaveLength(1)
      const completed = (await tasks())[0]
      expect(completed).toMatchObject({
        id: original.id,
        engineTaskId: original.engineTaskId,
        finalName: 'fixture.bin',
      })
      expect(await readFile(completed.finalPath)).toEqual(payload)
      expect(
        (await readFile(completed.finalPath)).subarray(0, partial.length)
      ).toEqual(partial)
      expect(
        requests
          .slice(mark)
          .some((request) => /^bytes=[1-9]\d*-/.test(request.range ?? ''))
      ).toBe(true)
      expect(
        requests
          .slice(mark)
          .every(
            (request) =>
              request.authorization === 'Bearer synthetic-resume-token'
          )
      ).toBe(true)
      await expect(
        page.getByRole('dialog', { name: 'Retry download' })
      ).not.toBeVisible()
    } finally {
      await restarted?.close().catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
