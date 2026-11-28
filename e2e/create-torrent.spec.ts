import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseTorrent } from '@motrix/torrent'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  TASK_FORM_WIDTH,
} from '@shared/constants/add-task'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

test('File → Create Torrent saves and seeds the selected original folder', async ({
  electronApp,
  mainWindow,
  userDataDir,
}, testInfo) => {
  test.setTimeout(90_000)
  await waitForEngineReady(mainWindow)
  await mainWindow.evaluate(
    (channel) =>
      window.motrix.invoke(channel, { engine: { seedRatio: 0, seedTime: 0 } }),
    Commands.UpdateSettings
  )
  await electronApp.evaluate(({ Menu, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('w=main')
    )
    const item = Menu.getApplicationMenu()?.getMenuItemById('menubar.task.new')
    if (!main || !item) throw Error('New Task menu unavailable')
    item.click({}, main, main.webContents)
  })
  const add = await findAddTaskWindow(electronApp)
  const cancel = add.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeVisible()
  await expect
    .poll(() => add.evaluate(() => [innerWidth, innerHeight]))
    .toEqual([TASK_FORM_WIDTH, ADD_TASK_COLLAPSED_HEIGHT])
  const taskSize = await add.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const taskAdvanced = await add
    .getByRole('button', { name: 'Advanced', exact: true })
    .boundingBox()
  const taskFooter = await add
    .locator('[data-slot="add-task-form-footer"]')
    .boundingBox()
  await cancel.click()
  const source = path.join(await realpath(userDataDir), 'shared')
  const payload = Buffer.concat([
    Buffer.alloc(32768, 1),
    Buffer.alloc(32768, 2),
    Buffer.from('tail'),
  ])
  await mkdir(path.join(source, 'nested'), { recursive: true })
  await writeFile(path.join(source, 'nested', 'payload.bin'), payload)
  const output = path.join(userDataDir, 'shared.torrent')
  const nextWindow = electronApp.waitForEvent('window', {
    predicate: async (win) => {
      await win.waitForLoadState('domcontentloaded')
      return win.url().includes('w=create-torrent')
    },
  })
  await electronApp.evaluate(
    ({ Menu, BrowserWindow, dialog }, { source, output }) => {
      dialog.showOpenDialog = async (
        arg: Electron.BaseWindow | Electron.OpenDialogOptions,
        options?: Electron.OpenDialogOptions
      ) => {
        const opts = options ?? (arg as Electron.OpenDialogOptions)
        if (opts.properties?.join() !== 'openDirectory')
          throw new Error('Expected directory-only picker')
        return { canceled: false, filePaths: [source] }
      }
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      })
      const main = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('w=main')
      )
      const menu = Menu.getApplicationMenu()?.getMenuItemById(
        'menubar.file.createTorrent'
      )
      if (!main || !menu?.enabled)
        throw new Error('Create torrent menu is unavailable')
      menu.click({}, main, main.webContents)
    },
    { source, output }
  )
  const creator = await nextWindow
  await creator.getByRole('button', { name: 'Select folder' }).waitFor()
  await expect
    .poll(() =>
      creator.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
    )
    .toEqual(taskSize)
  expect(
    (
      await creator
        .getByRole('button', { name: 'Advanced', exact: true })
        .boundingBox()
    )?.height
  ).toBe(taskAdvanced?.height)
  expect((await creator.locator('footer').boundingBox())?.height).toBe(
    taskFooter?.height
  )
  await creator.screenshot({
    path: testInfo.outputPath('creator-form.png'),
    scale: 'css',
  })
  await creator.getByRole('button', { name: 'Select folder' }).click()
  await creator
    .getByLabel('Trackers', { exact: true })
    .fill('http://127.0.0.1:1/announce')
  await creator.getByRole('switch', { name: 'Private torrent' }).click()
  await creator
    .getByRole('switch', { name: 'Start seeding after saving' })
    .click()
  await creator.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(creator.getByRole('textbox', { name: 'Trackers' })).toHaveCount(
    0
  )
  await creator.getByRole('button', { name: 'Save .torrent' }).click()
  await expect(creator.getByRole('status')).toContainText(
    'The seeding task was submitted.'
  )
  const parsed = parseTorrent(new Uint8Array(await readFile(output)))
  expect(parsed.private).toBe(true)
  expect(parsed.v1?.multiFile).toBe(true)
  expect(parsed.v1?.pieces.length).toBe(3)
  if (parsed.identity.kind === 'v2') throw new Error('Expected a v1 torrent')
  const infoHash = parsed.identity.sha1
  const getTasks = () =>
    mainWindow.evaluate(
      async (channel) =>
        (await window.motrix.invoke(channel)) as DownloadTask[],
      Queries.ListTasks
    )
  await expect
    .poll(
      async () =>
        (await getTasks()).find((task) => task.infoHash === infoHash)?.status,
      { timeout: 30_000 }
    )
    .toBe('seeding')
  expect(
    (await getTasks()).find((task) => task.infoHash === infoHash)?.finalPath
  ).toBe(source)
  expect(await readFile(path.join(source, 'nested', 'payload.bin'))).toEqual(
    payload
  )
})

test('cancelled export can be edited and saved without creating a task', async ({
  electronApp,
  mainWindow,
  userDataDir,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await mainWindow.evaluate(
    (channel) => window.motrix.invoke(channel, { app: { language: 'zh-CN' } }),
    Commands.UpdateSettings
  )
  const source = path.join(userDataDir, 'example.txt')
  const output = path.join(userDataDir, 'export.torrent')
  await writeFile(source, 'local source')
  const pending = electronApp.waitForEvent('window', {
    predicate: async (win) => {
      await win.waitForLoadState('domcontentloaded')
      return win.url().includes('w=create-torrent')
    },
  })
  await electronApp.evaluate(
    ({ Menu, BrowserWindow, dialog }, { source, output }) => {
      let first = true
      dialog.showOpenDialog = async (
        arg: Electron.BaseWindow | Electron.OpenDialogOptions,
        opts?: Electron.OpenDialogOptions
      ) => {
        if (
          (opts ?? (arg as Electron.OpenDialogOptions)).properties?.join() !==
          'openFile'
        )
          throw new Error('Expected file-only picker')
        return { canceled: false, filePaths: [source] }
      }
      dialog.showSaveDialog = async () => {
        if (first) {
          first = false
          return { canceled: true, filePath: '' }
        }
        return { canceled: false, filePath: output }
      }
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('w=main')
      )
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        'menubar.file.createTorrent'
      )
      if (!win || !item?.enabled) throw new Error('Missing create command')
      item.click({}, win, win.webContents)
    },
    { source, output }
  )
  const creator = await pending
  await creator.getByRole('button', { name: '选择文件', exact: true }).waitFor()
  await creator.screenshot({
    path: testInfo.outputPath('creator-zh-CN.png'),
    scale: 'css',
  })
  await creator.getByRole('button', { name: '高级' }).click()
  await expect
    .poll(() =>
      creator.evaluate(() => {
        const field = document.getElementById('creator-piece')
        const footer = document.querySelector('footer')
        return (
          !!field &&
          !!footer &&
          field.getBoundingClientRect().bottom <=
            footer.getBoundingClientRect().top
        )
      })
    )
    .toBe(true)
  await creator.screenshot({
    path: testInfo.outputPath('creator-advanced-zh-CN.png'),
    scale: 'css',
  })
  const pieces = creator.getByRole('combobox', { name: '分块大小' })
  await pieces.click()
  await creator.getByRole('option').last().click()
  await creator.getByRole('button', { name: '选择文件', exact: true }).click()
  // An invalid URL in a collapsed group must be visible and keyboard-accessible
  // when the user tries to create the torrent.
  const webSeeds = creator.getByRole('textbox', { name: 'Web 种子' })
  await webSeeds.fill('ftp://example.invalid/resource')
  await creator.getByRole('button', { name: '高级' }).click()
  await creator.getByRole('button', { name: '创建', exact: true }).click()
  await expect(webSeeds).toBeFocused()
  await expect(webSeeds).toHaveAttribute('aria-invalid', 'true')
  await webSeeds.fill('')
  await expect(creator.getByRole('alert')).toHaveCount(0)
  await creator.getByLabel('备注', { exact: true }).fill('first description')
  await creator.getByRole('button', { name: '创建', exact: true }).click()
  await creator.getByRole('button', { name: '保存 .torrent' }).click()
  await expect(
    creator.getByRole('button', { name: '编辑', exact: true })
  ).toBeEnabled()
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  await creator.getByRole('button', { name: '编辑', exact: true }).click()
  await creator
    .getByLabel('备注', { exact: true })
    .fill('corrected description')
  await creator.getByRole('button', { name: '创建', exact: true }).click()
  await creator.getByRole('button', { name: '保存 .torrent' }).waitFor()
  await creator.screenshot({
    path: testInfo.outputPath('creator-result-zh-CN.png'),
    scale: 'css',
  })
  await creator.getByRole('button', { name: '保存 .torrent' }).click()
  await expect(creator.getByRole('status')).toContainText('种子已保存')
  const metadata = parseTorrent(new Uint8Array(await readFile(output)))
  expect(metadata.comment).toBe('corrected description')
  expect(metadata.pieceLength).toBe(16 * 1024 ** 2)
  const tasks = await mainWindow.evaluate(
    async (channel) => (await window.motrix.invoke(channel)) as DownloadTask[],
    Queries.ListTasks
  )
  expect(tasks).toHaveLength(0)
})
