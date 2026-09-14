import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSaveGeneralSettingsHandler } from './general-settings'
import { SettingsManager } from './settings-manager'

function createCurrentSave(
  manager: SettingsManager,
  options?: Parameters<typeof createSaveGeneralSettingsHandler>[1]
) {
  const save = createSaveGeneralSettingsHandler(manager, options)
  return (raw: object) =>
    save({
      expectedRevision: manager.getGeneralSettingsSnapshot().revision,
      ...raw,
    })
}

const temporary: string[] = []
const empty = { addFavorites: [], removeFavorites: [], removeRecent: [] }
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-general-'))
  )
  temporary.push(root)
  const file = path.join(root, 'settings.json')
  const change = vi.fn()
  const manager = new SettingsManager(file, { onChange: change })
  await manager.load()
  change.mockClear()
  return { root, file, manager, change }
}

describe('General settings save handler', () => {
  it('validates every addition then atomically persists General fields and exact directory deltas', async () => {
    const { root, file, manager, change } = await fixture()
    const destination = path.join(root, 'destination ')
    await mkdir(destination)
    await manager.mutateDirectoryPreferences({
      action: 'addFavorite',
      path: '/stale ',
    })
    await manager.mutateDirectoryPreferences({
      action: 'recordRecent',
      path: '/old ',
    })
    const apply = vi.fn(async () => {
      const disk = JSON.parse(await readFile(file, 'utf8'))
      expect(disk.app.notifyOnComplete).toBe(false)
      expect(disk.app.directoryPreferences).toEqual({
        favorites: [await realpath(destination)],
        recent: [],
      })
    })
    change.mockClear()
    const save = createCurrentSave(manager, {
      applySavedApp: apply,
    })
    expect(
      await save({
        app: { defaultSaveDir: destination, notifyOnComplete: false },
        directories: {
          addFavorites: [destination],
          removeFavorites: ['/stale '],
          removeRecent: ['/old '],
        },
      })
    ).toMatchObject({
      ok: true,
      value: {
        directoryPreferences: {
          favorites: [await realpath(destination)],
          recent: [],
        },
      },
    })
    expect(change).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    const reloaded = new SettingsManager(file)
    await reloaded.load()
    expect(reloaded.getApp()).toMatchObject({
      defaultSaveDir: await realpath(destination),
      notifyOnComplete: false,
      directoryPreferences: {
        favorites: [await realpath(destination)],
        recent: [],
      },
    })
  })

  it('rejects malformed payload before any resolver, settings read/write or runtime effect', async () => {
    const { manager } = await fixture()
    const resolve = vi.fn(async (value: string) => value)
    const commit = vi.spyOn(manager, 'saveGeneralSettings')
    const apply = vi.fn()
    const save = createCurrentSave(manager, {
      resolveFavorite: resolve,
      resolveDefaultDirectory: resolve,
      applySavedApp: apply,
    })
    expect(
      await save({
        app: { defaultSaveDir: '/bad', directoryPreferences: {} },
        directories: { ...empty, addFavorites: ['/bad'] },
      })
    ).toEqual({ ok: false, error: { code: 'invalidPath' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('does not apply partial General fields or removals when an added or default directory is invalid', async () => {
    const { root, file, manager, change } = await fixture()
    await manager.mutateDirectoryPreferences({
      action: 'addFavorite',
      path: '/keep',
    })
    const before = await readFile(file, 'utf8')
    change.mockClear()
    const apply = vi.fn()
    const save = createCurrentSave(manager, {
      applySavedApp: apply,
    })
    for (const request of [
      {
        app: { notifyOnError: false },
        directories: {
          ...empty,
          addFavorites: [root, path.join(root, 'missing')],
          removeFavorites: ['/keep'],
        },
      },
      {
        app: {
          notifyOnError: false,
          defaultSaveDir: path.join(root, 'missing'),
        },
        directories: { ...empty, removeFavorites: ['/keep'] },
      },
    ]) {
      expect(await save(request)).toEqual({
        ok: false,
        error: { code: 'notFound' },
      })
    }
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(manager.getApp().directoryPreferences.favorites).toEqual(['/keep'])
    expect(change).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('preserves both aggregates and the previous real settings file when atomic persistence fails', async () => {
    const { file, manager, change } = await fixture()
    await manager.mutateDirectoryPreferences({
      action: 'recordRecent',
      path: '/keep',
    })
    const before = await readFile(file, 'utf8')
    const app = structuredClone(manager.getApp())
    change.mockClear()
    vi.spyOn(
      manager as unknown as { saveSettings: () => Promise<void> },
      'saveSettings'
    ).mockRejectedValueOnce(new Error('/private/disk failure'))
    const apply = vi.fn()
    const save = createCurrentSave(manager, {
      applySavedApp: apply,
    })
    expect(
      await save({
        app: { notifyOnError: false },
        directories: { ...empty, removeRecent: ['/keep'] },
      })
    ).toEqual({ ok: false, error: { code: 'unavailable' } })
    expect(manager.getApp()).toEqual(app)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(change).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('reapplies submitted runtime fields when a prior effect failed after durable commit', async () => {
    const { manager, change } = await fixture()
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine unavailable'))
      .mockResolvedValue(undefined)
    const save = createCurrentSave(manager, {
      applySavedApp: apply,
    })
    const request = { app: { warnBeforeQuit: false }, directories: empty }
    expect(await save(request)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      snapshot: { app: { warnBeforeQuit: false } },
    })
    expect(manager.getApp().warnBeforeQuit).toBe(false)
    expect(await save(request)).toMatchObject({ ok: true })
    expect(apply).toHaveBeenCalledTimes(2)
    expect(change).toHaveBeenCalledOnce()
  })
})

it('fences a timed-out save still resolving directories when an empty compensation commits first', async () => {
  const { root, file, manager, change } = await fixture()
  const before = await readFile(file, 'utf8')
  const revision = manager.getGeneralSettingsSnapshot().revision
  let release!: (path: string) => void
  const save = createSaveGeneralSettingsHandler(manager, {
    resolveFavorite: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  const original = save({
    expectedRevision: revision,
    app: { notifyOnError: false },
    directories: { ...empty, addFavorites: [root] },
  })
  const compensation = await save({
    expectedRevision: revision,
    app: {},
    directories: empty,
  })
  expect(compensation.ok).toBe(true)
  expect(manager.getGeneralSettingsSnapshot().revision).not.toBe(revision)
  release(root)
  expect(await original).toMatchObject({
    ok: false,
    error: { code: 'conflict' },
  })
  expect(manager.getApp().notifyOnError).toBe(true)
  expect(manager.getApp().directoryPreferences.favorites).toEqual([])
  expect(await readFile(file, 'utf8')).toBe(before)
  expect(change).not.toHaveBeenCalled()
})

it('rejects favorite normalization that would make uncertain additions impossible to remove by their draft key', async () => {
  const { manager } = await fixture()
  const save = createCurrentSave(manager, {
    resolveFavorite: async () => '/canonical',
  })
  expect(
    await save({
      app: { notifyOnError: false },
      directories: { ...empty, addFavorites: ['/alias'] },
    })
  ).toEqual({ ok: false, error: { code: 'invalidPath' } })
  expect(manager.getApp().directoryPreferences.favorites).toEqual([])
  expect(manager.getApp().notifyOnError).toBe(true)
})
