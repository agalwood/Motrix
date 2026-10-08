import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
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

async function firstPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

const sourceTitle = 'Where would you like to migrate from?'

async function expandTaskGroups(page: Page) {
  for (const type of ['http', 'bt', 'magnet', 'unknown']) {
    const disclosure = page.locator(
      `[data-import-group="${type}"] button[aria-expanded="false"]`
    )
    if (await disclosure.count()) await disclosure.click()
  }
}

test.describe('v1 task import', () => {
  test('retains invalid source paths and recovers through the native folder picker', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    const systemPath = path.join(source, 'system.json')
    const originalSystem = await readFile(systemPath, 'utf8')
    await writeFile(systemPath, '{}')
    const rejected = path.join(userDataDir, 'not-a-profile')
    await mkdir(rejected)
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await firstPage(app)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(
        'Unable to read downloads from this location'
      )
      await expect(page.getByRole('radio', { name: source })).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Check again', exact: true })
      ).toHaveCount(0)
      const choose = page.getByRole('button', {
        name: 'Choose another location…',
        exact: true,
      })
      await app.evaluate(({ dialog }, dataPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dataPath],
        })
      }, rejected)
      await choose.click()
      await expect(page.getByRole('radio', { name: rejected })).toBeDisabled()
      await expect(page.getByRole('radio', { name: source })).toBeDisabled()
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
      })
      await choose.click()
      await expect(choose).toBeEnabled()
      await expect(page.getByRole('alert')).toBeVisible()
      await writeFile(systemPath, originalSystem)
      await app.evaluate(({ dialog }, dataPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dataPath],
        })
      }, source)
      await choose.click()
      await expect(page.getByRole('radio', { name: source })).toBeEnabled()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Choose what to migrate' })
      ).toBeVisible()
      expect(await invoke(page, Queries.ListTasks)).toEqual([])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps group selection and disclosure independent across source navigation', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    const sessionPath = path.join(source, 'download.session')
    await writeFile(
      sessionPath,
      `${await readFile(sessionPath, 'utf8')}https://example.invalid/second.zip\n gid=2234567890abcdef\n dir=${path.join(source, 'downloads')}\n out=second.zip\n pause=true\n`
    )
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await firstPage(app)
      await page
        .getByRole('button', { name: 'Continue', exact: true })
        .dblclick()
      await expect(
        page.getByRole('heading', {
          name: 'Choose what to migrate',
          exact: true,
        })
      ).toBeVisible()
      expect(await invoke(page, Queries.ListTasks)).toEqual([])
      await expandTaskGroups(page)
      const group = page.locator('[data-import-group="http"]')
      const groupCheckbox = group.getByRole('checkbox').first()
      const disclosure = group.locator('button[aria-expanded]')
      const archive = page.getByRole('checkbox', {
        name: 'archive.zip',
        exact: true,
      })
      await archive.uncheck()
      await expect(groupCheckbox).toHaveAttribute('aria-checked', 'mixed')
      await disclosure.click()
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeEnabled()
      await disclosure.press('Enter')
      await expect(archive).not.toBeChecked()
      await groupCheckbox.press('Space')
      await expect(archive).toBeChecked()
      await expect(
        page.getByRole('checkbox', { name: 'second.zip', exact: true })
      ).toBeChecked()
      await groupCheckbox.press('Space')
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeDisabled()
      await archive.check()
      await page
        .getByRole('button', { name: 'Back to source', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Continue', exact: true })
        .press('Enter')
      await expect(
        page.getByRole('heading', {
          name: 'Choose what to migrate',
          exact: true,
        })
      ).toBeFocused()
      await expandTaskGroups(page)
      await expect(archive).toBeChecked()
      await expect(
        page.getByRole('checkbox', { name: 'second.zip', exact: true })
      ).not.toBeChecked()
      await page.getByRole('button', { name: /^Migrate$/ }).click()
      await expect(
        page
          .getByLabel('Migration summary')
          .getByText('1 task', { exact: true })
      ).toBeVisible()
      expect(await invoke(page, Queries.ListTasks)).toEqual([
        expect.objectContaining({
          name: 'archive.zip',
          status: 'paused',
          engineTaskId: '',
        }),
      ])
    } finally {
      await app.close().catch(() => {})
    }
  })

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
      const page = await firstPage(app)
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      await expect(
        page.getByRole('link', { name: 'Migration', exact: true })
      ).toBeVisible()
      await expect.poll(() => page.url()).toContain('w=main')
      await expect(
        page.getByRole('button', { name: 'Continue', exact: true })
      ).toBeEnabled()
      await page.screenshot({
        path: testInfo.outputPath('migration-discovery.png'),
        animations: 'disabled',
      })
      await expect(
        page.getByRole('radio', { name: source, exact: true })
      ).toBeChecked()
      await expect(
        page.getByRole('button', { name: 'Show in folder', exact: true })
      ).toBeVisible()
      const sourceViewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      await page.setViewportSize({ width: 800, height: 540 })
      await expect(
        page.getByRole('button', { name: 'Continue', exact: true })
      ).toBeInViewport()
      await expect(
        page.getByRole('radio', { name: source, exact: true })
      ).toBeInViewport()
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight
        )
      ).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath('migration-source-short.png'),
      })
      await page.setViewportSize(sourceViewport)
      await expect
        .poll(() =>
          page
            .locator('[data-slot="migration-import-illustration"]')
            .evaluate(
              (node) =>
                node instanceof HTMLImageElement &&
                node.complete &&
                node.naturalWidth > 0
            )
        )
        .toBe(true)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Choose what to migrate' })
      ).toBeVisible()
      await expect(
        page.locator('[data-slot="migration-import-illustration"]')
      ).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath('migration-selection.png'),
      })
      await expandTaskGroups(page)
      await page
        .getByRole('checkbox', { name: 'partial.bin', exact: true })
        .uncheck()
      await page
        .getByRole('button', { name: 'Back to source', exact: true })
        .click()
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expandTaskGroups(page)
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await page.getByRole('link', { name: 'Migration', exact: true }).click()
      await expect(
        page.getByRole('checkbox', { name: 'partial.bin', exact: true })
      ).not.toBeChecked()
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
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeEnabled()
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
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeEnabled()
      await expect(
        page
          .locator('.migration-task-row')
          .getByTitle(downloads, { exact: true })
      ).toHaveCount(3)
      await expect(
        page.locator('.migration-task-row [data-slot="badge"]')
      ).toHaveCount(3)
      expect(
        await page.evaluate(() => ({
          vertical:
            document.documentElement.scrollHeight <= window.innerHeight + 1,
          horizontal:
            document.documentElement.scrollWidth <= window.innerWidth + 1,
        }))
      ).toEqual({ vertical: true, horizontal: true })
      await page.screenshot({
        path: testInfo.outputPath('authorized-torrent.png'),
      })
      await invoke(page, Commands.UpdateSettings, {
        app: { language: 'zh-CN' },
      })
      await expect(
        page.getByRole('heading', { name: '选择要迁移的内容', exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole('checkbox', { name: 'partial.bin', exact: true })
      ).not.toBeChecked()
      await page.screenshot({
        path: testInfo.outputPath('migration-zh-CN.png'),
      })
      await invoke(page, Commands.UpdateSettings, {
        app: { language: 'en-US' },
      })
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeEnabled()
      const initialViewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      await page.setViewportSize({ width: 800, height: 540 })
      await expect(
        page.getByRole('button', { name: /^Migrate$/ })
      ).toBeInViewport()
      expect(
        await page.evaluate(() => ({
          vertical:
            document.documentElement.scrollHeight <= window.innerHeight + 1,
          horizontal:
            document.documentElement.scrollWidth <= window.innerWidth + 1,
        }))
      ).toEqual({ vertical: true, horizontal: true })
      await page.screenshot({
        path: testInfo.outputPath('migration-short.png'),
      })
      await page.setViewportSize(initialViewport)
      await page.getByRole('button', { name: /^Migrate$/ }).click()
      await expect(
        page
          .getByLabel('Migration summary')
          .getByText('2 tasks', { exact: true })
      ).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('migration-result.png'),
        animations: 'disabled',
      })
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await page.getByRole('link', { name: 'Migration', exact: true }).click()
      await expect(
        page
          .getByLabel('Migration summary')
          .getByText('2 tasks', { exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'View downloads' }).click()
      const main = page
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
      await main.getByRole('link', { name: 'Migration', exact: true }).click()
      await main.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(
        main.getByRole('button', { name: /^Migrate$/, exact: true })
      ).toBeEnabled()
      expect(await invoke(main, Queries.ListTasks)).toHaveLength(2)
      expect(await readFile(torrentPath)).toEqual(original)
      // Direct IPC updates bypass the local settings form refresh. Reload to
      // verify persisted dark appearance, as other appearance fixtures do.
      await invoke(page, Commands.UpdateSettings, {
        app: { theme: 'dark', language: 'zh-CN' },
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await expandTaskGroups(page)
      await expect(
        page.getByRole('heading', { name: '选择要迁移的内容', exact: true })
      ).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('migration-dark.png'),
        animations: 'disabled',
      })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps motion optional and selection immediate across input methods', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const page = await firstPage(app)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      const motion = page.locator('.migration-motion')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(motion).toHaveAttribute('data-motion', 'off')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expandTaskGroups(page)
      const checkbox = page.getByRole('checkbox', {
        name: 'archive.zip',
        exact: true,
      })
      await checkbox.uncheck()
      await expect(
        page.getByRole('button', { name: /^Migrate$/, exact: true })
      ).toBeDisabled()
      const runningAnimations = () =>
        motion.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === 'running').length
        )
      expect(await runningAnimations()).toBe(0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await checkbox.press('Space')
      await expect(checkbox).toBeChecked()
      await expect(
        page.getByRole('button', { name: /^Migrate$/, exact: true })
      ).toBeEnabled()
      expect(await runningAnimations()).toBe(0)
      await checkbox.uncheck()
      await checkbox.check()
      await expect(motion).toHaveAttribute('data-motion', 'on')
      // Wait for route commit before inspecting the retained, hidden page.
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await expect(motion).toBeHidden()
      await expect(motion).toHaveAttribute('data-motion', 'off')
      expect(await runningAnimations()).toBe(0)
      await page.getByRole('link', { name: 'Migration', exact: true }).click()
      await expect(checkbox).toBeChecked()
      await invoke(page, Commands.UpdateSettings, {
        app: { reduceMotion: true },
      })
      await expect(motion).toHaveAttribute('data-motion', 'off')
      await checkbox.uncheck()
      await checkbox.check()
      expect(await runningAnimations()).toBe(0)
      await page.getByRole('button', { name: /^Migrate$/, exact: true }).click()
      await expect(
        page
          .getByLabel('Migration summary')
          .getByText('1 task', { exact: true })
      ).toBeVisible()
      expect(await runningAnimations()).toBe(0)
      const tasks = (await invoke(page, Queries.ListTasks)) as Array<{
        status: string
      }>
      expect(tasks).toHaveLength(1)
      expect(tasks[0].status).toBe('paused')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('opens migration in main only after consent and imports paused records without blocking the engine', async ({
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
      const disclaimer = await firstPage(app)
      await expect(disclaimer.getByTestId('disclaimer-panel')).toBeVisible()
      await expect(
        invoke(disclaimer, Queries.DiscoverLegacyImport)
      ).rejects.toThrow(/consentRequired/)
      const opened = app.waitForEvent('window')
      await disclaimer.getByTestId('disclaimer-agree').click()
      const page = await opened
      await page.waitForLoadState('domcontentloaded')
      await expect.poll(() => page.url()).toContain('w=main')
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      await expect(
        page.getByRole('link', { name: 'Migration', exact: true })
      ).toBeVisible()
      await waitForEngineReady(page)
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).not.toBeVisible()
      await page.getByRole('link', { name: 'Migration', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      expect(
        app.windows().filter((window) => window.url().includes('w=onboarding'))
      ).toHaveLength(0)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expandTaskGroups(page)
      await page.getByRole('button', { name: /^Migrate$/ }).click()
      await expect(
        page
          .getByLabel('Migration summary')
          .getByText('1 task', { exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'View downloads' }).click()
      const main = page
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

  test('hides migration without a detected v1 profile and keeps manual import available', async ({
    userDataDir,
    rpcPort,
  }) => {
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      const main = await firstPage(app)
      await waitForEngineReady(main)
      await expect(
        main.getByRole('link', { name: 'Migration', exact: true })
      ).toHaveCount(0)
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Advanced', { exact: true }).first().click()
      await main
        .getByRole('button', { name: 'Open migration', exact: true })
        .click()
      await expect(
        main.getByRole('button', {
          name: 'Choose another location…',
          exact: true,
        })
      ).toBeVisible()
      expect(
        app.windows().filter((window) => window.url().includes('w=onboarding'))
      ).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('retains a migration entry for a detected empty v1 profile', async ({
    userDataDir,
    rpcPort,
  }) => {
    const source = await legacyProfile(userDataDir)
    await writeFile(path.join(source, 'download.session'), '')
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    try {
      const main = await firstPage(app)
      await waitForEngineReady(main)
      const entry = main.getByRole('link', { name: 'Migration', exact: true })
      await expect(entry).toBeVisible()
      await entry.click()
      await expect(
        main.getByRole('heading', {
          name: sourceTitle,
          exact: true,
        })
      ).toBeVisible()
      expect(await invoke(main, Queries.ListTasks)).toEqual([])
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
      const page = await firstPage(app)
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: sourceTitle })
      ).not.toBeVisible()
      await expect(
        page.getByRole('link', { name: 'Migration', exact: true })
      ).toBeVisible()
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
      await expect(
        main.getByRole('link', { name: 'Migration', exact: true })
      ).toBeVisible()
      await expect(
        main.getByRole('heading', { name: sourceTitle })
      ).not.toBeVisible()
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Advanced', { exact: true }).first().click()
      const port = main.getByRole('spinbutton').first()
      await port.fill('17000')
      await main
        .getByRole('button', { name: 'Open migration', exact: true })
        .click()
      await expect(
        main.getByRole('heading', { name: sourceTitle })
      ).toBeVisible()
      await main.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(port).toHaveValue('17000')
      expect(await invoke(main, Queries.ListTasks)).toEqual([])
    } finally {
      await app.close().catch(() => {})
    }
  })
})
