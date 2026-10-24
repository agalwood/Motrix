import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import type { DownloadTask } from '../src/shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

async function invoke(
  page: Page,
  channel: string,
  input?: unknown
): Promise<unknown> {
  return page.evaluate(
    async ({ channel, input }) => {
      return (
        window as unknown as {
          motrix: {
            invoke: (channel: string, input?: unknown) => Promise<unknown>
          }
        }
      ).motrix.invoke(channel, input)
    },
    { channel, input }
  )
}

for (const mismatch of [false, true]) {
  test(`HTTP legacy content ${mismatch ? 'mismatch keeps original files without downloading' : 'verification resumes original file and survives restart'}`, async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    test.skip(
      process.env.MOTRIX_E2E_LEGACY_HTTP !== '1',
      'Requires the native HTTP redirect policy engine'
    )
    const total = 4194304
    const completed = 1638400
    const payload = Buffer.alloc(total)
    for (let index = 0; index < total; index++) payload[index] = index % 251
    if (mismatch) payload[completed - 1] ^= 255
    const ranges: string[] = []
    const server = createServer((request, response) => {
      const range = request.headers.range ?? ''
      ranges.push(range)
      if (
        request.headers.cookie !== 'session=e2e-fixture' ||
        request.headers['accept-encoding'] !== 'identity'
      ) {
        response.writeHead(403).end()
        return
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      const start = match ? Number(match[1]) : 0
      const end = match?.[2] ? Number(match[2]) : total - 1
      response.writeHead(match ? 206 : 200, {
        ETag: '"http-legacy-v1"',
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
      })
      response.end(payload.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing local server')
    const source = path.join(userDataDir, 'legacy-http-profile')
    const downloads = path.join(userDataDir, 'original-downloads')
    await mkdir(source)
    await mkdir(downloads)
    const original = gunzipSync(
      await readFile(
        'tests/fixtures/legacy-v1/generated/downloads/partial.bin.gz'
      )
    )
    const control = await readFile(
      'tests/fixtures/legacy-v1/generated/downloads/partial.bin.aria2'
    )
    const target = path.join(downloads, 'partial.bin')
    await writeFile(target, original, { mode: 0o600 })
    await writeFile(`${target}.aria2`, control, { mode: 0o600 })
    const inode = (await stat(target)).ino
    await writeFile(
      path.join(source, 'user.json'),
      JSON.stringify({ theme: 'auto' })
    )
    await writeFile(
      path.join(source, 'system.json'),
      JSON.stringify({ dir: downloads })
    )
    await writeFile(
      path.join(source, 'download.session'),
      `http://127.0.0.1:${address.port}/partial.bin\n gid=1234567890abcdef\n out=partial.bin\n pause=true\n header=Cookie: session=e2e-fixture\n`
    )
    let app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitForEngineReady(page)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Migrate', exact: true }).click()
      await page.getByRole('button', { name: 'View downloads' }).click()
      const tasks = (await invoke(page, Queries.ListTasks)) as DownloadTask[]
      expect(tasks).toHaveLength(1)
      const taskId = tasks[0].id
      await page.locator(`[data-task-id="${taskId}"]`).dblclick()
      const activate = page.getByRole('button', {
        name: 'Verify and continue',
        exact: true,
      })
      await expect(activate).toBeEnabled()
      await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        })
      }, downloads)
      await activate.click()
      if (mismatch) {
        await expect(
          page.getByText(
            'The downloaded data differs from the server content.',
            { exact: true }
          )
        ).toBeVisible()
        expect(await readFile(target)).toEqual(original)
        expect(
          ((await invoke(page, Queries.ListTasks)) as DownloadTask[])[0]
        ).toMatchObject({ engineTaskId: '', status: 'paused' })
        expect(ranges).not.toContain(`bytes=${completed}-${total - 1}`)
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (window) =>
                window.webContents.getURL().includes('w=add-task') &&
                window.isVisible()
            )
          )
        ).toBe(false)
      } else {
        await expect
          .poll(
            async () =>
              ((await invoke(page, Queries.ListTasks)) as DownloadTask[])[0]
          )
          .toMatchObject({
            status: 'completed',
            totalBytes: total,
            downloadedBytes: total,
          })
        expect(ranges).toContain(`bytes=${completed}-${total - 1}`)
        expect(
          createHash('sha256')
            .update(await readFile(target))
            .digest('hex')
        ).toBe(createHash('sha256').update(payload).digest('hex'))
        expect((await stat(target)).ino).toBe(inode)
        await page.screenshot({
          path: testInfo.outputPath('http-resumed.png'),
          animations: 'disabled',
        })
        await page.locator(`[data-task-id="${taskId}"]`).screenshot({
          path: testInfo.outputPath('http-resumed-row.png'),
          animations: 'disabled',
        })
        await app.close()
        app = await launchMotrix({
          userDataDir,
          rpcPort,
          extraEnv: { MOTRIX_LEGACY_PROFILE: source },
        })
        const restarted = await app.firstWindow()
        await restarted.waitForLoadState('domcontentloaded')
        await waitForEngineReady(restarted)
        await expect
          .poll(
            async () =>
              (
                (await invoke(restarted, Queries.ListTasks)) as DownloadTask[]
              )[0]
          )
          .toMatchObject({
            status: 'completed',
            totalBytes: total,
            downloadedBytes: total,
          })
        await invoke(restarted, Commands.RemoveTask, {
          taskId,
          deleteWithFiles: true,
        })
        expect(await invoke(restarted, Queries.ListTasks)).toEqual([])
        expect((await readFile(target)).equals(payload)).toBe(true)
      }
      expect(await readFile(`${target}.aria2`)).toEqual(control)
    } finally {
      server.closeAllConnections()
      await app.close().catch(() => {})
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
