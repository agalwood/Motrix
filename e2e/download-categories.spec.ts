import path from 'node:path'
import type { Page } from '@playwright/test'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import type { DownloadTask } from '../src/shared/types/task'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { type HttpFixture, startHttpFixture } from './fixtures/http-server'

async function invoke<T>(
  page: Page,
  channel: string,
  payload?: unknown
): Promise<T> {
  return page.evaluate(
    async ({ channel, payload }) => {
      const api = (
        window as unknown as {
          motrix: { invoke(channel: string, payload?: unknown): Promise<T> }
        }
      ).motrix
      return api.invoke(channel, payload)
    },
    { channel, payload }
  )
}

test('downloads into six category folders and filters the real task list', async ({
  electronApp,
  mainWindow,
  userDataDir,
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForEngineReady(mainWindow)
  await invoke(mainWindow, Commands.UpdateSettings, {
    app: { notifyOnComplete: false, notifyOnError: false },
  })
  const fixtures: HttpFixture[] = []
  const samples = [
    ['Compressed', 'archive.zip'],
    ['Documents', 'manual.pdf'],
    ['Music', 'song.mp3'],
    ['Programs', 'setup.exe'],
    ['Video', 'clip.mp4'],
    ['Other', 'unknown.bin'],
  ] as const
  const saveDir = path.join(userDataDir, 'downloads')
  try {
    for (const [index, [, filename]] of samples.entries()) {
      const fixture = await startHttpFixture({
        pathname: `/${filename}`,
        size: 8192,
      })
      fixtures.push(fixture)
      if (index === 0) {
        await mainWindow.getByRole('button', { name: 'New task' }).click()
        const addWindow = await findAddTaskWindow(electronApp)
        await addWindow
          .getByRole('textbox', { name: 'URLs' })
          .fill(fixture.fileUrl)
        await addWindow
          .getByRole('button', { name: 'Download', exact: true })
          .click()
      } else {
        await invoke(mainWindow, Commands.CreateTask, {
          type: 'http',
          uris: [fixture.fileUrl],
          saveDir,
          headers: [],
        })
      }
    }
    await expect
      .poll(
        async () => {
          const tasks = await invoke<DownloadTask[]>(
            mainWindow,
            Queries.ListTasks
          )
          return tasks.filter((task) => task.status === 'completed').length
        },
        { timeout: 60_000 }
      )
      .toBe(6)
    const tasks = await invoke<DownloadTask[]>(mainWindow, Queries.ListTasks)
    for (const [index, [folder, filename]] of samples.entries()) {
      const task = tasks.find((task) => task.finalName === filename)!
      expect(task.category).toBe(folder.toLowerCase())
      expect(task.finalPath).toBe(path.join(saveDir, folder, filename))
      expect(await fixtures[index].verifyFile(task.finalPath)).toBe(true)
      await mainWindow.getByRole('link', { name: folder, exact: true }).click()
      await expect(mainWindow.locator('[data-task-id]')).toHaveCount(1)
      await expect(mainWindow.locator('[data-task-id]')).toHaveAttribute(
        'data-task-id',
        task.id
      )
    }
    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await expect(mainWindow.locator('[data-task-id]')).toHaveCount(6)
    await mainWindow.screenshot({
      path: testInfo.outputPath('download-categories.png'),
    })

    await invoke(mainWindow, Commands.UpdateSettings, {
      app: { autoCategorizeDownloads: false },
    })
    await invoke(mainWindow, Commands.CreateTask, {
      type: 'http',
      uris: [fixtures[1].fileUrl],
      saveDir,
      filename: 'unsorted.pdf',
      headers: [],
    })
    await expect
      .poll(async () => {
        const tasks = await invoke<DownloadTask[]>(
          mainWindow,
          Queries.ListTasks
        )
        return tasks.find((task) => task.finalName === 'unsorted.pdf')?.status
      })
      .toBe('completed')
    const plain = (
      await invoke<DownloadTask[]>(mainWindow, Queries.ListTasks)
    ).find((task) => task.finalName === 'unsorted.pdf')!
    expect(plain.finalPath).toBe(path.join(saveDir, 'unsorted.pdf'))
    expect(await fixtures[1].verifyFile(plain.finalPath)).toBe(true)
  } finally {
    for (const fixture of fixtures) await fixture.close()
  }
})
