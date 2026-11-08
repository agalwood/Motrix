import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginLogEntry } from '@shared/types/plugin'
import {
  expect,
  launchMotrix,
  test,
  waitForQueryHandlers,
} from './fixtures/electron-app'

test('many bridge consumers share IPC delivery and unsubscribe across repeated mounts', async ({
  electronApp,
  mainWindow,
}) => {
  const warnings: string[] = []
  mainWindow.on('console', (message) => {
    if (message.text().includes('MaxListenersExceededWarning'))
      warnings.push(message.text())
  })
  const channel = `${Events.PluginLog}:test.fanout` as const
  await mainWindow.waitForFunction(() => Boolean(window.motrix))
  for (let cycle = 0; cycle < 12; cycle++) {
    await mainWindow.evaluate((eventChannel) => {
      const callbacks = Array.from(
        { length: 32 },
        () =>
          (...args: unknown[]) => {
            const state = (
              window as unknown as {
                fanout: { calls: number; args: unknown[] }
              }
            ).fanout
            state.calls++
            state.args = args
          }
      )
      const removers = callbacks.map((callback) =>
        window.motrix!.on(eventChannel, callback)
      )
      Object.assign(window, { fanout: { removers, calls: 0, args: [] } })
    }, channel)
    await electronApp.evaluate(({ webContents }, eventChannel) => {
      for (const contents of webContents.getAllWebContents())
        contents.send(eventChannel, 'payload')
    }, channel)
    await expect
      .poll(() =>
        mainWindow.evaluate(
          () =>
            (window as unknown as { fanout: { calls: number } }).fanout.calls
        )
      )
      .toBe(32)
    await mainWindow.evaluate(() => {
      const state = (
        window as unknown as {
          fanout: {
            removers: Array<() => void>
            args: unknown[]
          }
        }
      ).fanout
      if (JSON.stringify(state.args) !== JSON.stringify(['payload']))
        throw new Error('Native event leaked across the bridge')
      for (const remove of state.removers) remove()
    })
  }
  // A surviving listener provides a delivery barrier for the final event.
  await mainWindow.evaluate((eventChannel) => {
    window.motrix!.on(eventChannel, () =>
      Object.assign(window, { fanoutDone: true })
    )
  }, channel)
  await electronApp.evaluate(({ webContents }, eventChannel) => {
    for (const contents of webContents.getAllWebContents())
      contents.send(eventChannel, 'after-unsubscribe')
  }, channel)
  await mainWindow.waitForFunction(
    () => (window as unknown as { fanoutDone: boolean }).fanoutDone
  )
  expect(
    await mainWindow.evaluate(
      () => (window as unknown as { fanout: { calls: number } }).fanout.calls
    )
  ).toBe(32)
  expect(warnings).toEqual([])
})

async function openPlugin(
  app: ElectronApplication,
  pluginId: string
): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.motrix))
  await waitForQueryHandlers(page)
  await page.evaluate((id) => {
    location.hash = `/plugins/${id}`
  }, pluginId)
  await expect(
    page.getByRole('button', { name: 'Logs', exact: true })
  ).toBeVisible()
  return page
}

async function logs(page: Page, pluginId: string): Promise<PluginLogEntry[]> {
  return page.evaluate(
    ({ channel, id }) =>
      window.motrix!.invoke(channel, { pluginId: id, limit: 100 }),
    { channel: Queries.GetPluginLogs, id: pluginId }
  ) as Promise<PluginLogEntry[]>
}

test('host failures remain visible in plugin logs after restart and clearing persists', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  const pluginId = 'test.diagnostics'
  const pluginDir = path.join(userDataDir, 'plugins', pluginId)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    path.join(pluginDir, 'motrix-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: pluginId,
      name: 'Diagnostics fixture',
      version: '1.0.0',
      description: 'Runtime error fixture',
      categories: ['integration'],
      engines: { motrix: '>=2.0.0-beta.48 <3.0.0' },
      main: 'plugin.js',
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {},
    })
  )
  await writeFile(
    path.join(pluginDir, 'plugin.js'),
    'throw new Error("diagnostic failure fixture");'
  )
  let app = await launchMotrix({ userDataDir, rpcPort })
  try {
    let page = await openPlugin(app, pluginId)
    await expect
      .poll(async () =>
        (await logs(page, pluginId)).some(
          (entry) =>
            entry.msg.includes('diagnostic failure fixture') &&
            entry.source === 'host'
        )
      )
      .toBe(true)
    const first = (await logs(page, pluginId)).find(
      (entry) => entry.level === 'error'
    )!
    await page.evaluate(
      ({ channel, id }) => window.motrix!.invoke(channel, id),
      { channel: Commands.DisablePlugin, id: pluginId }
    )
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await openPlugin(app, pluginId)
    expect(await logs(page, pluginId)).toContainEqual(first)
    await page.getByRole('button', { name: 'Logs', exact: true }).click()
    await expect(
      page.getByText(/plugin.bundle.parse_error:.*diagnostic failure fixture/)
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('persisted-host-error.png'),
    })
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect.poll(() => logs(page, pluginId)).toEqual([])
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await openPlugin(app, pluginId)
    expect(await logs(page, pluginId)).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
