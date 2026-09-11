import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import {
  BridgeQueries,
  type BridgeStatusInfo,
} from '../../src/shared/protocol/bridge'
import { expect, test } from '../fixtures/electron-app'

test('a denied Edge directory preserves discovery and recovers on restart', async ({
  userDataDir,
  rpcPort,
}) => {
  test.skip(process.platform !== 'darwin', 'macOS browser registration paths')
  const repo = resolve(import.meta.dirname, '../..')
  const isolatedHome = join(userDataDir, 'home')
  const support = join(isolatedHome, 'Library/Application Support')
  const denied = join(support, 'Microsoft Edge')
  const marker = join(userDataDir, 'deny-edge')
  const fixtureApp = join(userDataDir, 'app')
  await mkdir(fixtureApp, { recursive: true })
  await writeFile(marker, '')
  const metadata = JSON.parse(
    await readFile(join(repo, 'package.json'), 'utf8')
  )
  await writeFile(
    join(fixtureApp, 'package.json'),
    JSON.stringify({ ...metadata, main: 'main.cjs' })
  )
  // Override only this test process's home lookup and Edge mkdir. The real
  // packaged JS, IPC, endpoint writer and HTTP listener run unchanged, while
  // every native-messaging file stays inside the fixture's temporary root.
  await writeFile(
    join(fixtureApp, 'main.cjs'),
    `require('electron').app.getAppPath = () => ${JSON.stringify(repo)};
const os = require('node:os');
os.homedir = () => ${JSON.stringify(isolatedHome)};
const fs = require('node:fs/promises');
const mkdir = fs.mkdir;
fs.mkdir = async (path, ...args) => {
  if (String(path).startsWith(${JSON.stringify(denied)}) && require('node:fs').existsSync(${JSON.stringify(marker)})) {
    throw Object.assign(new Error('Edge directory denied by test'), { code: 'EPERM', syscall: 'mkdir', path });
  }
  return mkdir(path, ...args);
};
require(${JSON.stringify(join(repo, 'dist/main/index.cjs'))});
`
  )
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      onboarding: { disclaimerAccepted: true },
      app: { browserBridgeEnabled: true },
    })
  )
  const launch = () =>
    electron.launch({
      args: [fixtureApp],
      cwd: userDataDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MOTRIX_USER_DATA: userDataDir,
        MOTRIX_RPC_PORT: String(rpcPort),
        MOTRIX_DEFAULT_SAVE_DIR: join(userDataDir, 'downloads'),
        MOTRIX_BRIDGE_DATA_DIR: join(userDataDir, 'bridge'),
        MOTRIX_BRIDGE_HOST_BIN: join(userDataDir, 'native-host'),
      },
    })

  for (const health of ['degraded', 'ready'] as const) {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const getStatus = (): Promise<BridgeStatusInfo | null> =>
        page.evaluate(async (channel) => {
          try {
            const api = (
              window as unknown as {
                motrix: { invoke(query: string): Promise<BridgeStatusInfo> }
              }
            ).motrix
            return await api.invoke(channel)
          } catch {
            return null
          }
        }, BridgeQueries.GetStatus)
      await expect
        .poll(getStatus)
        .toMatchObject({ nativeMessagingHealth: health })
      const status = await getStatus()
      if (!status) throw new Error('bridge status missing')
      if (health === 'degraded') {
        const log = await readFile(join(userDataDir, 'logs/motrix.log'), 'utf8')
        expect(log.includes('Native Messaging registration failed')).toBe(true)
        expect(log.includes('EPERM')).toBe(true)
      }
      const endpoint = JSON.parse(
        await readFile(join(userDataDir, 'bridge/endpoint.json'), 'utf8')
      )
      expect(endpoint.port).toBe(status.port)
      const discovery = await fetch(`http://127.0.0.1:${status.port}/discovery`)
      expect(discovery.ok).toBe(true)
      expect(await discovery.json()).toMatchObject({ app: 'motrix-bridge' })
      for (const channel of [
        BridgeQueries.ListTrusted,
        BridgeQueries.ListPaired,
      ]) {
        expect(
          await page.evaluate((query) => {
            const api = (
              window as unknown as {
                motrix: { invoke(channel: string): Promise<unknown> }
              }
            ).motrix
            return api.invoke(query)
          }, channel)
        ).toBeInstanceOf(Array)
      }
      for (const browser of [
        'Google/Chrome',
        'Mozilla',
        ...(health === 'ready' ? ['Microsoft Edge'] : []),
      ]) {
        const file = join(
          support,
          browser,
          'NativeMessagingHosts/app.motrix.bridge.json'
        )
        expect(JSON.parse(await readFile(file, 'utf8')).name).toBe(
          'app.motrix.bridge'
        )
      }
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByText('Integration', { exact: true }).first().click()
      const warning = page.getByText('Some browser connections need attention')
      if (health === 'degraded') await expect(warning).toBeVisible()
      else await expect(warning).toHaveCount(0)
      await expect(
        page.getByRole('heading', { name: 'Browser extensions', exact: true })
      ).toBeVisible()
    } finally {
      await app.close()
    }
    await rm(marker, { force: true })
  }
})
