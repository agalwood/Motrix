import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SETTINGS_VERSION } from './migrations'
import { SettingsManager } from './settings-manager'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'motrix-settings-recovery-'))
  temporary.push(dir)
  return { dir, file: path.join(dir, 'settings.json') }
}

describe('settings file recovery', () => {
  it.each(['{bad json', 'null', '[]', '42', '"text"'])(
    'preserves the original bytes and restarts from persisted defaults for %s',
    async (content) => {
      const { dir, file } = await fixture()
      const original = Buffer.from(content)
      await writeFile(file, original)
      const manager = new SettingsManager(file)
      await manager.load()
      const backups = (await readdir(dir)).filter((name) =>
        name.endsWith('.bak')
      )
      expect(backups).toHaveLength(1)
      expect(await readFile(path.join(dir, backups[0]!))).toEqual(original)
      const recovered = JSON.parse(await readFile(file, 'utf8'))
      expect(recovered.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(recovered.engine.rpcSecret).toBeTruthy()
      expect(recovered.onboarding.disclaimerAccepted).toBe(false)
      const restarted = new SettingsManager(file)
      await restarted.load()
      expect(restarted.get()).toEqual(manager.get())
      expect(
        (await readdir(dir)).filter((name) => name.endsWith('.bak'))
      ).toEqual(backups)
    }
  )

  it('keeps separate backups across repeated recovery attempts', async () => {
    const { dir, file } = await fixture()
    for (const content of ['first broken file', 'second broken file']) {
      await writeFile(file, content)
      await new SettingsManager(file).load()
    }
    const backups = (await readdir(dir)).filter((name) => name.endsWith('.bak'))
    expect(backups).toHaveLength(2)
    expect(
      await Promise.all(
        backups.map((name) => readFile(path.join(dir, name), 'utf8'))
      )
    ).toEqual(
      expect.arrayContaining(['first broken file', 'second broken file'])
    )
  })

  it('does not back up a new profile or discard valid fields for an invalid field value', async () => {
    const { dir, file } = await fixture()
    const manager = new SettingsManager(file)
    await manager.load()
    expect(await readdir(dir)).toEqual(['settings.json'])
    const settings = JSON.parse(await readFile(file, 'utf8'))
    settings.app.theme = 'dark'
    settings.app.mainWindowMinWidth = -1
    await writeFile(file, JSON.stringify(settings))
    await manager.load()
    expect(manager.getApp()).toMatchObject({
      theme: 'dark',
      mainWindowMinWidth: 914,
    })
    expect(manager.getEngine().rpcSecret).toBe(settings.engine.rpcSecret)
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})
