import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTorrent } from '@motrix/torrent'
import { expect, test } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  TASK_FORM_WIDTH,
} from '../../src/shared/constants/add-task'
import { getFreePort } from '../helpers/free-port'

test('create on the server, download in the browser, and seed the original folder', async ({
  page,
}, info) => {
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-web-creator-'))
  )
  const data = path.join(root, 'data'),
    allowed = path.join(root, 'downloads'),
    content = path.join(allowed, 'collection')
  await mkdir(data, { recursive: true })
  await mkdir(content, { recursive: true })
  const payload = Buffer.alloc(65540, 77)
  await writeFile(path.join(content, 'disc.bin'), payload)
  await writeFile(path.join(allowed, 'single.bin'), 'local server data')
  await writeFile(
    path.join(data, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { language: 'en-US', defaultSaveDir: allowed },
      onboarding: { disclaimerAccepted: true },
      tracker: { autoSync: false },
      engine: { rpcPort: await getFreePort(), seedRatio: 0, seedTime: 0 },
    })
  )
  const port = await getFreePort(),
    token = randomUUID()
  const origin = `http://127.0.0.1:${port}`,
    base = `${origin}/motrix`
  const server = spawn(
    process.execPath,
    [path.join(repo, 'dist/server/index.mjs')],
    {
      cwd: repo,
      env: {
        ...process.env,
        PORT: String(port),
        MOTRIX_DATA_DIR: data,
        MOTRIX_DEFAULT_SAVE_DIR: allowed,
        MOTRIX_ALLOWED_SAVE_DIRS: allowed,
        MOTRIX_MDXP_PORT: '0',
        MOTRIX_MDXP_HOST: '127.0.0.1',
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'false',
        MOTRIX_PUBLIC_URL: origin,
        MOTRIX_WEB_BASE_PATH: '/motrix',
        MOTRIX_OPERATOR_TOKEN: token,
        MOTRIX_ARIA2_BIN: path.join(
          repo,
          'extra',
          process.platform,
          process.arch,
          process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
        ),
        MOTRIX_RENDERER_DIR: path.join(repo, 'dist/renderer-web'),
        MOTRIX_BUILTIN_PLUGIN_DIR: path.join(repo, 'dist/builtin-plugins'),
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let logs = ''
  const append = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-24000)
  }
  server.stdout.on('data', append)
  server.stderr.on('data', append)
  const exited = new Promise<void>((resolve) =>
    server.once('exit', () => resolve())
  )
  try {
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null) throw Error(logs)
          try {
            return (await page.request.get(`${base}/healthz`)).ok()
          } catch {
            return false
          }
        },
        { timeout: 25000 }
      )
      .toBe(true)
    expect(
      (
        await page.request.post(`${base}/rpc/auth/login`, {
          data: { token },
          headers: { origin },
        })
      ).ok()
    ).toBe(true)
    await page.goto(`${base}/`)
    const openFileMenu = async (label: string) => {
      await page.getByRole('button', { name: 'Motrix', exact: true }).click()
      await page.getByRole('menuitem', { name: 'File', exact: true }).hover()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }
    await openFileMenu('New Task…')
    const add = page.getByRole('dialog', { name: 'New Task' })
    await expect(add).toBeVisible()
    const size = () => add.boundingBox()
    await expect
      .poll(async () => Math.round((await size())?.height ?? 0))
      .toBe(ADD_TASK_COLLAPSED_HEIGHT)
    await expect
      .poll(async () => Math.round((await size())?.width ?? 0))
      .toBe(TASK_FORM_WIDTH)
    const addAdvanced = await add
      .getByRole('button', { name: 'Advanced', exact: true })
      .boundingBox()
    const addFooter = await add
      .locator('[data-slot="add-task-form-footer"]')
      .boundingBox()
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openFileMenu('Create Torrent File…')
    const maker = page.getByRole('dialog', { name: 'Create torrent' })
    await expect
      .poll(async () => Math.round((await maker.boundingBox())?.height ?? 0))
      .toBe(ADD_TASK_COLLAPSED_HEIGHT)
    await expect
      .poll(async () => Math.round((await maker.boundingBox())?.width ?? 0))
      .toBe(TASK_FORM_WIDTH)
    expect(
      (
        await maker
          .getByRole('button', { name: 'Advanced', exact: true })
          .boundingBox()
      )?.height
    ).toBe(addAdvanced?.height)
    expect((await maker.locator('footer').boundingBox())?.height).toBe(
      addFooter?.height
    )
    await maker.screenshot({ path: info.outputPath('server-creator.png') })
    await maker.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(maker.getByLabel('Comment', { exact: true })).toBeVisible()
    await maker.getByRole('button', { name: 'Advanced', exact: true }).click()
    await maker
      .getByRole('button', { name: 'Select folder', exact: true })
      .click()
    const picker = page.getByTestId('web-directory-picker')
    await picker.getByRole('option', { name: /collection/ }).click()
    await picker
      .getByRole('button', { name: 'Select folder', exact: true })
      .click()
    await maker
      .getByRole('textbox', { name: 'Trackers', exact: true })
      .fill('http://127.0.0.1:1/announce')
    await maker.getByRole('switch', { name: 'Private torrent' }).click()
    await maker
      .getByRole('switch', { name: 'Start seeding after saving' })
      .click()
    await maker.getByRole('button', { name: 'Create', exact: true }).click()
    const download = page.waitForEvent('download')
    await maker
      .getByRole('button', { name: 'Save .torrent', exact: true })
      .click()
    const file = await download
    expect(file.suggestedFilename()).toBe('collection.torrent')
    const downloaded = await file.path()
    if (!downloaded) throw new Error('Torrent download has no local artifact')
    const parsed = parseTorrent(new Uint8Array(await readFile(downloaded)))
    expect(parsed.v1?.multiFile).toBe(true)
    expect(parsed.v1?.pieces.length).toBe(3)
    expect(parsed.private).toBe(true)
    await expect(maker.getByRole('status')).toContainText(
      'The seeding task was submitted.'
    )
    const tasks = async () =>
      (
        await page.request.post(`${base}/rpc/query/query%3AlistTasks`, {
          data: { args: [] },
        })
      ).json()
    await expect
      .poll(
        async () =>
          (await tasks()).find(
            (t: { finalPath: string }) => t.finalPath === content
          )?.status,
        { timeout: 30000 }
      )
      .toBe('seeding')
    expect(await readFile(path.join(content, 'disc.bin'))).toEqual(payload)
    await maker
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click()
    await openFileMenu('Create Torrent File…')
    await maker
      .getByRole('button', { name: 'Select file', exact: true })
      .click()
    await picker.getByRole('option', { name: /single.bin/ }).click()
    await picker
      .getByRole('button', { name: 'Select file', exact: true })
      .click()
    await maker.getByRole('button', { name: 'Create', exact: true }).click()
    const download2 = page.waitForEvent('download')
    await maker
      .getByRole('button', { name: 'Save .torrent', exact: true })
      .click()
    expect((await download2).suggestedFilename()).toBe('single.bin.torrent')
    await expect(maker.getByRole('status')).toContainText('Download requested')
    expect(await tasks()).toHaveLength(1)
    await maker
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click()
    await page.setViewportSize({ width: 390, height: 600 })
    await page.getByRole('button', { name: 'Motrix', exact: true }).click()
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await page
      .getByRole('menuitem', { name: 'Create Torrent File…', exact: true })
      .click()
    await expect
      .poll(async () => Math.round((await maker.boundingBox())?.width ?? 0))
      .toBe(358)
    await maker.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(
      maker.getByRole('button', { name: 'Create', exact: true })
    ).toBeInViewport()
    await page.request.post(`${base}/rpc/command/command%3AupdateSettings`, {
      data: { args: [{ app: { language: 'zh-CN' } }] },
      headers: { origin },
    })
    const localized = page.getByRole('dialog', { name: '创建种子' })
    await localized.getByRole('button', { name: '高级', exact: true }).waitFor()
    await localized.screenshot({
      path: info.outputPath('server-narrow-zh.png'),
    })
    await page.setViewportSize({ width: 1024, height: 768 })
    await localized.getByRole('button', { name: '高级', exact: true }).click()
    await expect
      .poll(async () =>
        Math.round((await localized.boundingBox())?.height ?? 0)
      )
      .toBe(ADD_TASK_COLLAPSED_HEIGHT)
    await localized.screenshot({
      path: info.outputPath('server-creator-zh.png'),
    })
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timeout)
    }
    await rm(root, { recursive: true, force: true })
  }
})
