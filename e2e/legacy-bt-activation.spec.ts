import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import type { DownloadTask } from '../src/shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

async function invoke(page: Page, channel: string, input?: unknown) {
  return page.evaluate(
    async ({ channel, input }) => {
      const api = (
        window as unknown as {
          motrix: {
            invoke: (channel: string, input?: unknown) => Promise<unknown>
          }
        }
      ).motrix
      return api.invoke(channel, input)
    },
    { channel, input }
  )
}

async function mainPage(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      app
        .windows()
        .find((page) => page.url().includes('w=main'))
        ?.url()
    )
    .toContain('w=main')
  const page = app
    .windows()
    .find((candidate) => candidate.url().includes('w=main'))
  if (!page) throw new Error('Main window was not created')
  await page.waitForLoadState('domcontentloaded')
  return page
}

test('verifies imported BT files through the desktop UI and preserves them after removal', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  // Opt in only when the staged development engine has both migration contracts.
  test.skip(
    process.env.MOTRIX_E2E_LEGACY_BT !== '1',
    'Requires a staged legacy BT activation engine'
  )
  const root = path.join(userDataDir, 'generated-v1')
  await cp('tests/fixtures/legacy-v1/generated', root, { recursive: true })
  const source = path.join(root, 'profile')
  const downloads = path.join(root, 'downloads')
  for (const name of ['download.session', 'system.json']) {
    const filename = path.join(source, name)
    await writeFile(
      filename,
      (await readFile(filename, 'utf8'))
        .replaceAll('__FIXTURE_ROOT__', source)
        .replaceAll('__FIXTURE_DOWNLOADS__', downloads)
        .replaceAll('__FIXTURE_HTTP_PORT__', String(rpcPort))
    )
  }
  await mkdir(path.join(downloads, 'fixture-bundle'))
  const originalFiles = [
    ['first.bin', Buffer.alloc(16384, 1)],
    ['second.bin', Buffer.alloc(16384, 2)],
  ] as const
  for (const [name, bytes] of originalFiles)
    await writeFile(path.join(downloads, 'fixture-bundle', name), bytes, {
      mode: 0o600,
    })
  const torrentPath = path.join(
    downloads,
    'a16dc78c94ce589ed4666ab32285f2d188edf26f.torrent'
  )
  const torrentBefore = await readFile(torrentPath)
  const controlPath = path.join(downloads, 'fixture-bundle.aria2')
  const controlBefore = await readFile(controlPath)
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
      engine: { dhtEnabled: false, btEnableLpd: false },
    }),
    { flag: 'wx' }
  )
  let app = await launchMotrix({
    userDataDir,
    rpcPort,
    extraEnv: { MOTRIX_LEGACY_PROFILE: source },
  })
  try {
    const invitation = await mainPage(app)
    await expect(
      invitation.getByRole('heading', {
        name: 'Where would you like to migrate from?',
      })
    ).toBeVisible()
    await invitation
      .getByRole('button', { name: 'Continue', exact: true })
      .click()
    await expect(invitation.locator('[data-import-group="http"]')).toBeVisible()
    for (const type of ['http', 'bt', 'magnet', 'unknown']) {
      const disclosure = invitation.locator(
        `[data-import-group="${type}"] button[aria-expanded="false"]`
      )
      if (await disclosure.count()) await disclosure.click()
    }
    // Select only the old torrent; group controls can reselect child rows.
    for (const name of ['partial.bin', 'fixture-magnet']) {
      const checkbox = invitation.getByRole('checkbox', { name, exact: true })
      await checkbox.uncheck()
      await expect(checkbox).not.toBeChecked()
    }
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [filename],
      })
    }, torrentPath)
    await invitation.getByRole('button', { name: 'Choose torrent…' }).click()
    await expect(
      invitation.getByRole('checkbox', { name: 'fixture-bundle', exact: true })
    ).toBeChecked()
    await invitation
      .getByRole('button', { name: 'Migrate', exact: true })
      .click()
    await expect(
      invitation
        .getByLabel('Migration summary')
        .getByText('1 task', { exact: true })
    ).toBeVisible()
    await invitation.getByRole('button', { name: 'View downloads' }).click()
    let main = invitation
    await main.waitForLoadState('domcontentloaded')
    await waitForEngineReady(main)
    const tasks = (await invoke(main, Queries.ListTasks)) as DownloadTask[]
    expect(tasks).toHaveLength(1)
    const taskId = tasks[0].id
    expect(tasks[0]).toMatchObject({ status: 'paused', engineTaskId: '' })
    await main.locator(`[data-task-id="${taskId}"]`).dblclick()
    const activate = main.getByRole('button', {
      name: 'Verify and continue',
      exact: true,
    })
    await expect(activate).toBeEnabled()
    await expect(activate).toBeVisible()
    await activate.scrollIntoViewIfNeeded()
    await main.screenshot({
      path: testInfo.outputPath('verify-and-continue.png'),
    })
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await activate.click()
    await expect(activate).toBeEnabled()
    expect(
      ((await invoke(main, Queries.ListTasks)) as DownloadTask[])[0]
        .engineTaskId
    ).toBe('')
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      })
    }, downloads)
    await activate.click()
    await expect
      .poll(
        async () =>
          ((await invoke(main, Queries.ListTasks)) as DownloadTask[])[0]
            ?.status,
        { timeout: 20000 }
      )
      .toBe('completed')
    const completed = (
      (await invoke(main, Queries.ListTasks)) as DownloadTask[]
    )[0]
    expect(completed.engineTaskId).toMatch(/^[a-f0-9]{16}$/)
    await main.screenshot({
      path: testInfo.outputPath('verified-completed.png'),
    })
    await app.close()
    app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    main = await mainPage(app)
    await waitForEngineReady(main)
    await expect
      .poll(() => invoke(main, Queries.ListTasks))
      .toMatchObject([
        {
          id: taskId,
          status: 'completed',
          engineTaskId: completed.engineTaskId,
        },
      ])
    await invoke(main, Commands.RemoveTask, { taskId, deleteWithFiles: true })
    expect(await invoke(main, Queries.ListTasks)).toEqual([])
    for (const [name, bytes] of originalFiles)
      expect(
        await readFile(path.join(downloads, 'fixture-bundle', name))
      ).toEqual(bytes)
    expect(await readFile(torrentPath)).toEqual(torrentBefore)
    expect(await readFile(controlPath)).toEqual(controlBefore)
  } finally {
    await app.close().catch(() => {})
  }
})
