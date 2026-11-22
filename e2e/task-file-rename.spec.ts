import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { launchMotrix, test, waitForEngineReady } from './fixtures/electron-app'
import { getFreePort } from './helpers/free-port'
import { renameFilesFlow } from './helpers/rename-files-flow'

test('renames files in the desktop and preserves them through restart and reseeding', async ({
  userDataDir,
  rpcPort,
}, info) => {
  test.setTimeout(120000)
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: {
        language: 'en-US',
        warnBeforeQuit: false,
        autofillClipboardLinks: false,
      },
      onboarding: { disclaimerAccepted: true },
      tracker: { autoSync: false },
      engine: {
        dhtEnabled: false,
        btEnableLpd: false,
        listenPort: await getFreePort(),
      },
    })
  )
  let app: ElectronApplication | undefined
  let page: Page
  const launch = async () => {
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await waitForEngineReady(page)
  }
  try {
    await launch()
    await renameFilesFlow({
      page: () => page,
      invoke: (channel, value) =>
        page.evaluate(
          ({ channel, value }) => window.motrix.invoke(channel, value),
          { channel, value }
        ),
      restart: async () => {
        await app?.close()
        await launch()
      },
      saveDir: path.join(userDataDir, 'downloads'),
      info,
    })
  } finally {
    await app?.close()
  }
})
