import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { expect, launchMotrix, test } from './fixtures/electron-app'

test('startup preserves a corrupt configuration before creating durable defaults', async ({
  userDataDir,
  rpcPort,
}) => {
  const settingsPath = path.join(userDataDir, 'settings.json')
  const original = '{"app":{"theme":"dark",\n'
  await writeFile(settingsPath, original)
  const backups = async () =>
    (await readdir(userDataDir)).filter(
      (name) =>
        name.startsWith('settings.json.corrupt-') && name.endsWith('.bak')
    )
  const readSettings = async () =>
    JSON.parse(await readFile(settingsPath, 'utf8'))
  let app = await launchMotrix({ userDataDir, rpcPort })
  try {
    await app.firstWindow()
    const files = await backups()
    expect(files).toHaveLength(1)
    expect(await readFile(path.join(userDataDir, files[0]!), 'utf8')).toBe(
      original
    )
    const restored = await readSettings()
    expect(restored).toMatchObject({
      version: CURRENT_SETTINGS_VERSION,
      app: {
        theme: 'system',
        mainWindowMinWidth: 914,
        mainWindowMinHeight: 672,
      },
      onboarding: { disclaimerAccepted: false },
    })
    expect(restored.engine.rpcSecret).toBeTruthy()
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    await app.firstWindow()
    expect((await readSettings()).engine.rpcSecret).toBe(
      restored.engine.rpcSecret
    )
    expect(await backups()).toEqual(files)
  } finally {
    await app.close().catch(() => {})
  }
})
