import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { encode } from '@motrix/torrent'
import { expect, type Page, type TestInfo } from '@playwright/test'
import { Commands } from '../../src/shared/protocol/commands'
import { Queries } from '../../src/shared/protocol/queries'
import type { DownloadTask, TaskFile } from '../../src/shared/types/task'

type Channel =
  | (typeof Commands)[keyof typeof Commands]
  | (typeof Queries)[keyof typeof Queries]
export async function renameFilesFlow(options: {
  page: () => Page
  invoke: (channel: Channel, value?: unknown) => Promise<unknown>
  restart: () => Promise<void>
  saveDir: string
  info: TestInfo
}) {
  const { invoke, saveDir, info } = options
  const payload = Buffer.alloc(512 * 1024, 53)
  let blocked = true
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const first = Number(range?.[1] ?? 0),
      last = Math.min(
        Number(range?.[2] || payload.length - 1),
        payload.length - 1
      )
    response.writeHead(range ? 206 : 200, {
      'Content-Length': last - first + 1,
      ...(range
        ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` }
        : {}),
    })
    if (blocked && last > first)
      response.write(payload.subarray(first, first + 1))
    else response.end(payload.subarray(first, last + 1))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address')
  const tasks = async () => (await invoke(Queries.ListTasks)) as DownloadTask[]
  const files = async (id: string) =>
    (await invoke(Queries.GetTaskFiles, id)) as TaskFile[]
  const open = async (id: string) => {
    const page = options.page()
    await page.getByRole('link', { name: 'Downloads', exact: true }).click()
    await page.locator(`[data-task-id="${id}"]`).dblclick()
    await page
      .getByTestId('task-inspector-drawer-content')
      .getByRole('tab', { name: 'Files', exact: true })
      .click()
  }
  const edit = async (old: string, name: string, conflict = false) => {
    const page = options.page()
    await page
      .getByRole('button', {
        name: new RegExp(`Rename file:.*${old.replace('.', '\\.')}$`),
      })
      .click()
    const dialog = page.getByRole('dialog', {
      name: 'Rename file',
      exact: true,
    })
    await dialog.getByRole('textbox', { name: 'File name' }).fill(name)
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    if (conflict) {
      await expect(dialog.getByRole('alert')).toContainText('already in use')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await expect(dialog).toHaveCount(0)
  }
  await mkdir(saveDir, { recursive: true })
  const ids: string[] = []
  try {
    for (const multi of [false, true]) {
      const infoDict = {
        name: multi ? 'collection' : 'original.bin',
        'piece length': 16384,
        pieces: Buffer.concat(
          Array.from({ length: payload.length / 16384 }, (_, index) =>
            createHash('sha1')
              .update(payload.subarray(index * 16384, (index + 1) * 16384))
              .digest()
          )
        ),
        ...(multi
          ? {
              files: [
                { length: payload.length / 2, path: ['first.bin'] },
                { length: payload.length / 2, path: ['nested', 'second.bin'] },
              ],
            }
          : { length: payload.length }),
      }
      const metadata = encode({
        info: infoDict,
        'url-list': [`http://127.0.0.1:${address.port}/payload`],
      })
      await invoke(Commands.CreateTask, {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: Buffer.from(metadata).toString('base64'),
        },
        selectedFiles: multi ? [0, 1] : [0],
        saveDir,
        seedRatio: 0,
      })
      await expect
        .poll(
          async () =>
            (await tasks()).find((entry) => !ids.includes(entry.id))?.status
        )
        .toBe('downloading')
      const task = (await tasks()).find((entry) => !ids.includes(entry.id))
      if (!task) throw new Error('Created task missing')
      ids.push(task.id)
      await invoke(Commands.PauseTask, task.id)
      await expect
        .poll(
          async () =>
            (await tasks()).find((entry) => entry.id === task.id)?.status
        )
        .toBe('paused')
      await open(task.id)
      if (!multi) {
        await writeFile(path.join(saveDir, 'occupied.bin'), 'foreign bytes')
        await edit('original.bin', 'occupied.bin', true)
        expect(await readFile(path.join(saveDir, 'occupied.bin'), 'utf8')).toBe(
          'foreign bytes'
        )
      }
      await edit(
        multi ? 'second.bin' : 'original.bin',
        multi ? 'chosen.bin' : 'renamed.bin'
      )
      await expect
        .poll(async () =>
          (await files(task.id)).some((file) =>
            file.path.endsWith(multi ? 'nested/chosen.bin' : 'renamed.bin')
          )
        )
        .toBe(true)
      expect(
        (await tasks()).find((entry) => entry.id === task.id)?.engineTaskId
      ).toBe(task.engineTaskId)
      await options.page().screenshot({
        path: info.outputPath(
          multi ? 'multi-file-renamed.png' : 'single-file-renamed.png'
        ),
        animations: 'disabled',
      })
      await options.page().keyboard.press('Escape')
    }
    await options.restart()
    blocked = false
    for (const id of ids) {
      await invoke(Commands.ResumeTask, id)
      await expect
        .poll(
          async () =>
            ['seeding', 'completed'].includes(
              (await tasks()).find((entry) => entry.id === id)?.status ?? ''
            ),
          { timeout: 30000 }
        )
        .toBe(true)
      if (
        (await tasks()).find((entry) => entry.id === id)?.status === 'seeding'
      )
        await invoke(Commands.StopSeedingTask, id)
      await expect
        .poll(
          async () => (await tasks()).find((entry) => entry.id === id)?.status
        )
        .toBe('completed')
    }
    expect(await readFile(path.join(saveDir, 'renamed.bin'))).toEqual(payload)
    expect(
      await readFile(path.join(saveDir, 'collection/nested/chosen.bin'))
    ).toEqual(payload.subarray(payload.length / 2))
    const before = requests
    const prior = (await tasks()).find((entry) => entry.id === ids[1])
    if (!prior) throw new Error('Completed task missing')
    const oldGid = prior.engineTaskId
    await invoke(Commands.ReAddTask, ids[1])
    await expect
      .poll(
        async () =>
          (await tasks()).find((entry) => entry.id === ids[1])?.status,
        { timeout: 30000 }
      )
      .toBe('seeding')
    expect(
      (await tasks()).find((entry) => entry.id === ids[1])?.engineTaskId
    ).not.toBe(oldGid)
    expect(requests).toBe(before)
    expect(
      (await files(ids[1])).some((file) =>
        file.path.endsWith('nested/chosen.bin')
      )
    ).toBe(true)
    await invoke(Commands.StopSeedingTask, ids[1])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
