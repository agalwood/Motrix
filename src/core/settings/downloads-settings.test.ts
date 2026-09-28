import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSaveDownloadsSettingsHandler } from './downloads-settings'
import { SettingsManager } from './settings-manager'

const roots: string[] = []
const empty = { addFavorites: [], removeFavorites: [], removeRecent: [] }
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-downloads-'))
  )
  roots.push(root)
  const file = path.join(root, 'settings.json')
  const change = vi.fn()
  const manager = new SettingsManager(file, { onChange: change })
  await manager.load()
  change.mockClear()
  const request = () => ({
    expectedRevision: manager.getDownloadsSettingsSnapshot().revision,
    settings: {},
    directories: empty,
  })
  return { root, file, change, manager, request }
}
describe('Downloads atomic settings save', () => {
  it('durably commits folders, clipboard, performance and nested speed edits together', async () => {
    const { root, file, change, manager, request } = await fixture()
    const folder = path.join(root, 'downloads ')
    await mkdir(folder)
    await manager.update({ speedLimit: { base: { upload: 777 } } })
    change.mockClear()
    const apply = vi.fn(async () => {
      const disk = JSON.parse(await readFile(file, 'utf8'))
      expect(disk.app).toMatchObject({
        defaultSaveDir: folder,
        autofillClipboardLinks: false,
        directoryPreferences: { favorites: [folder] },
      })
      expect(disk.engine.maxConcurrentDownloads).toBe(8)
      expect(disk.speedLimit.base).toEqual({ upload: 777, download: 5000 })
    })
    const result = await createSaveDownloadsSettingsHandler(manager, { apply })(
      {
        ...request(),
        settings: {
          app: { defaultSaveDir: folder, autofillClipboardLinks: false },
          engine: { maxConcurrentDownloads: 8 },
          speedLimit: { base: { download: 5000 } },
        },
        directories: { ...empty, addFavorites: [folder] },
      }
    )
    expect(result).toMatchObject({ ok: true, update: { saved: true } })
    expect(change).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    const restored = new SettingsManager(file)
    await restored.load()
    expect(restored.getApp().directoryPreferences.favorites).toEqual([folder])
    expect(restored.get().speedLimit.base).toEqual({
      upload: 777,
      download: 5000,
    })
  })
  it('does not commit any field when a destination is invalid', async () => {
    const { root, manager, request, change } = await fixture()
    const before = structuredClone(manager.get())
    const result = await createSaveDownloadsSettingsHandler(manager)({
      ...request(),
      settings: {
        app: { autofillClipboardLinks: false },
        engine: { maxConcurrentDownloads: 8 },
      },
      directories: { ...empty, addFavorites: [path.join(root, 'missing')] },
    })
    expect(result.ok).toBe(false)
    expect(manager.get()).toEqual(before)
    expect(change).not.toHaveBeenCalled()
  })
  it('rejects stale revisions without losing newer folders or untouched speed leaves', async () => {
    const { manager, request } = await fixture()
    const stale = request()
    await manager.mutateDirectoryPreferences({
      action: 'recordRecent',
      path: '/newer',
    })
    await manager.update({ speedLimit: { base: { upload: 444 } } })
    const save = createSaveDownloadsSettingsHandler(manager)
    const conflict = await save({
      ...stale,
      settings: { speedLimit: { base: { download: 222 } } },
    })
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
      snapshot: {
        settings: { speedLimit: { base: { upload: 444 } } },
        directoryPreferences: { recent: ['/newer'] },
      },
    })
    expect(
      await save({
        ...request(),
        settings: { speedLimit: { base: { download: 222 } } },
      })
    ).toMatchObject({ ok: true })
    expect(manager.get().speedLimit.base).toEqual({
      upload: 444,
      download: 222,
    })
  })
  it('fences an older request still resolving a directory with a pristine save', async () => {
    const { manager, request } = await fixture()
    let resolve!: (path: string) => void
    const save = createSaveDownloadsSettingsHandler(manager, {
      resolveDefaultDirectory: () =>
        new Promise((r) => {
          resolve = r
        }),
    })
    const old = save({
      ...request(),
      settings: { app: { defaultSaveDir: '/old' } },
    })
    expect(await save(request())).toMatchObject({ ok: true })
    resolve('/old')
    expect(await old).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(manager.getApp().defaultSaveDir).not.toBe('/old')
  })
  it('reports committed success plus an apply warning when runtime application fails', async () => {
    const { manager, request } = await fixture()
    const result = await createSaveDownloadsSettingsHandler(manager, {
      apply: async () => {
        throw Error('unavailable')
      },
    })({ ...request(), settings: { engine: { maxConcurrentDownloads: 8 } } })
    expect(result).toMatchObject({
      ok: true,
      update: { applicationFailed: true },
      value: { settings: { engine: { maxConcurrentDownloads: 8 } } },
    })
  })
  it.each([
    { engine: { split: undefined } },
    { speedLimit: { base: { download: undefined } } },
    { app: { runMode: 2 } },
    { engine: { split: 129 } },
  ])(
    'rejects invalid or out-of-scope patches without changing state: %j',
    async (settings) => {
      const { manager, request, change } = await fixture()
      expect(
        await createSaveDownloadsSettingsHandler(manager)({
          ...request(),
          settings,
        })
      ).toMatchObject({ ok: false })
      expect(change).not.toHaveBeenCalled()
    }
  )
})
