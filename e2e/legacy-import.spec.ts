import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  launchMotrix,
  test,
  waitForQueryHandlers,
} from './fixtures/electron-app'

/** Minimal synthetic source for the isolated consent and lifecycle cases. */
async function legacyProfile(userDataDir: string): Promise<string> {
  const root = path.join(userDataDir, 'legacy-v1')
  const dir = path.join(root, 'downloads')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(root, 'user.json'),
    JSON.stringify({ theme: 'auto', locale: 'en-US' })
  )
  await writeFile(path.join(root, 'system.json'), JSON.stringify({ dir }))
  await writeFile(
    path.join(root, 'download.session'),
    `https://example.invalid/archive.zip\n gid=1234567890abcdef\n dir=${dir}\n out=archive.zip\n pause=true\n`
  )
  await writeFile(path.join(dir, 'archive.zip'), 'original v1 bytes')
  return root
}

async function invoke(
  page: Page,
  channel: string,
  input?: unknown
): Promise<unknown> {
  return page.evaluate(
    async ({ channel, input }) => {
      const api = (
        window as unknown as {
          motrix: {
            invoke: (channel: string, input?: unknown) => Promise<unknown>
          }
        }
      ).motrix
      return input === undefined
        ? api.invoke(channel)
        : api.invoke(channel, input)
    },
    { channel, input }
  )
}

async function invitation(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

test.describe('v1 task import', () => {
  test('authorizes an external v1-generated torrent and preserves task selection', async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    const root = path.join(userDataDir, 'generated-v1')
    await cp('tests/fixtures/legacy-v1/generated', root, { recursive: true })
    const source = path.join(root, 'profile')
    const downloads = path.join(root, 'downloads')
    for (const name of ['download.session', 'system.json']) {
      const filename = path.join(source, name)
      const content = await readFile(filename, 'utf8')
      await writeFile(
        filename,
        content
          .replaceAll('__FIXTURE_ROOT__', source)
          .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
          .replaceAll('__FIXTURE_HTTP_PORT__', String(rpcPort))
      )
    }
    const torrentPath = path.join(
      downloads,
      'a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent'
    )
    const original = await readFile(torrentPath)
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await invitation(app)
      await expect(page.getByText('Downloads found: 3')).toBeVisible()
      await page.getByRole('button', { name: 'Choose downloads' }).click()
      await page
        .getByRole('checkbox', { name: 'partial.bin', exact: true })
        .uncheck()
      await page.getByText('Skipped: 1', { exact: true }).click()
      const choose = page.getByRole('button', { name: 'Choose torrent…' })
      await expect(choose).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('external-torrent.png'),
      })
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
      })
      await choose.click()
      await expect(choose).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Import 1' })).toBeEnabled()
      await app.evaluate(({ dialog }, torrentPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [torrentPath],
        })
      }, torrentPath)
      await choose.click()
      await expect(
        page.getByRole('checkbox', { name: 'fixture-bundle', exact: true })
      ).toBeChecked()
      await expect(
        page.getByRole('checkbox', { name: 'partial.bin', exact: true })
      ).not.toBeChecked()
      await expect(page.getByRole('button', { name: 'Import 2' })).toBeEnabled()
      await page.screenshot({
        path: testInfo.outputPath('authorized-torrent.png'),
      })
      await page.getByRole('button', { name: 'Import 2' }).click()
      await expect(page.getByText('Imported 2', { exact: true })).toBeVisible()
      const opened = app.waitForEvent('window')
      await page.getByRole('button', { name: 'View downloads' }).click()
      const main = await opened
      await main.waitForLoadState('domcontentloaded')
      await waitForQueryHandlers(main)
      const tasks = (await invoke(main, Queries.ListTasks)) as Array<{
        name: string
        status: string
        engineTaskId: string
      }>
      expect(tasks).toHaveLength(2)
      expect(
        tasks.every((task) => task.status === 'paused' && !task.engineTaskId)
      ).toBe(true)
      expect(await readFile(torrentPath)).toEqual(original)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps engine stopped through consent and invitation, imports paused records and preserves old bytes', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    let app = await launchMotrix({
      userDataDir,
      rpcPort,
      disclaimerAccepted: false,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await invitation(app)
      await expect(page.getByTestId('disclaimer-panel')).toBeVisible()
      await expect(invoke(page, Queries.DiscoverLegacyImport)).rejects.toThrow(
        /consentRequired/
      )
      await page.getByTestId('disclaimer-agree').click()
      await expect(page.getByText('Downloads found: 1')).toBeVisible()
      await expect(invoke(page, Queries.GetEngineStatus)).rejects.toThrow(
        /No handler registered/
      )
      expect(
        app.windows().some((window) => window.url().includes('w=main'))
      ).toBe(false)
      await page.getByRole('button', { name: 'Choose downloads' }).click()
      await page.getByRole('button', { name: 'Import 1' }).click()
      await expect(page.getByText('Imported 1', { exact: true })).toBeVisible()
      const opened = app.waitForEvent('window')
      await page.getByRole('button', { name: 'View downloads' }).click()
      const main = await opened
      await main.waitForLoadState('domcontentloaded')
      await waitForQueryHandlers(main)
      const tasks = (await invoke(main, Queries.ListTasks)) as Array<{
        id: string
        status: string
        engineTaskId: string
        downloadedBytes: number
      }>
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        status: 'paused',
        engineTaskId: '',
        downloadedBytes: 0,
      })
      await expect(
        invoke(
          main,
          Commands.ResumeTask,
          (tasks[0] as unknown as { id: string }).id
        )
      ).rejects.toThrow()
      expect(
        await readFile(path.join(source, 'downloads', 'archive.zip'), 'utf8')
      ).toBe('original v1 bytes')
      await app.close()
      app = await launchMotrix({
        userDataDir,
        rpcPort,
        extraEnv: { MOTRIX_LEGACY_PROFILE: source },
      })
      const restarted = await app.firstWindow()
      await restarted.waitForLoadState('domcontentloaded')
      await waitForQueryHandlers(restarted)
      await expect.poll(() => restarted.url()).toContain('w=main')
      expect(await invoke(restarted, Queries.ListTasks)).toEqual([
        expect.objectContaining({
          id: tasks[0].id,
          status: 'paused',
          engineTaskId: '',
          downloadedBytes: 0,
        }),
      ])
      // Even an older renderer asking for file deletion must preserve v1 bytes.
      await invoke(restarted, Commands.RemoveTask, {
        taskId: tasks[0].id,
        deleteWithFiles: true,
      })
      expect(await invoke(restarted, Queries.ListTasks)).toEqual([])
      expect(
        await readFile(path.join(source, 'downloads', 'archive.zip'), 'utf8')
      ).toBe('original v1 bytes')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('closing the invitation after acceptance terminates the app without a startup-drain deadlock', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      disclaimerAccepted: false,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await invitation(app)
      await page.getByTestId('disclaimer-agree').click()
      await expect(page.getByText('Downloads found: 1')).toBeVisible()
      const closed = app.waitForEvent('close', { timeout: 15000 })
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) =>
            window.webContents.getURL().includes('w=onboarding')
          )
          ?.close()
      })
      await closed
      expect(
        await readFile(path.join(source, 'downloads', 'archive.zip'), 'utf8')
      ).toBe('original v1 bytes')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('dismissal survives restart, and manual import preserves the Advanced draft when going back', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    let app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await invitation(app)
      await expect(page.getByText('Downloads found: 1')).toBeVisible()
      const opened = app.waitForEvent('window')
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await opened
      await app.close()
      app = await launchMotrix({
        userDataDir,
        rpcPort,
        extraEnv: { MOTRIX_LEGACY_PROFILE: source },
      })
      const main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await expect.poll(() => main.url()).toContain('w=main')
      await waitForQueryHandlers(main)
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Advanced', { exact: true }).first().click()
      const port = main.getByRole('spinbutton').first()
      await port.fill('17000')
      await main.getByRole('button', { name: 'Import…', exact: true }).click()
      await expect(main.getByRole('button', { name: 'Import 1' })).toBeVisible()
      await main.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(port).toHaveValue('17000')
      expect(await invoke(main, Queries.ListTasks)).toEqual([])
    } finally {
      await app.close().catch(() => {})
    }
  })
})
