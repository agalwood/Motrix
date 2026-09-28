import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectoryPreferencesHandlers } from './directory-preferences'
import { SettingsManager } from './settings-manager'

const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-preferences-'))
  temporary.push(root)
  const settingsPath = path.join(root, 'settings.json')
  const manager = new SettingsManager(settingsPath)
  await manager.load()
  return {
    root,
    settingsPath,
    manager,
    handlers: createDirectoryPreferencesHandlers(manager),
  }
}

describe('host-neutral directory preference handlers', () => {
  it('validates Desktop directories, normalizes aliases, keeps literal spaces, and permits stale record removal', async () => {
    const { root, manager, handlers } = await fixture()
    const target = path.join(
      root,
      process.platform === 'win32' ? 'folder' : 'folder '
    )
    await mkdir(target)
    const alias = path.join(root, 'alias')
    await symlink(target, alias)
    const canonical = await realpath(target)
    expect(
      await handlers.mutate({ action: 'addFavorite', path: alias })
    ).toEqual({ ok: true, value: { favorites: [canonical], recent: [] } })
    await handlers.mutate({ action: 'addFavorite', path: target })
    expect(manager.getApp().directoryPreferences.favorites).toEqual([canonical])
    await rm(alias)
    await rm(target, { recursive: true })
    expect(await handlers.get({})).toEqual({
      ok: true,
      value: { favorites: [canonical], recent: [] },
    })
    expect(
      await handlers.mutate({ action: 'removeFavorite', paths: [canonical] })
    ).toEqual({ ok: true, value: { favorites: [], recent: [] } })
  })

  it('rejects invalid requests before filesystem or settings work and sanitizes missing/files', async () => {
    const { root, manager, handlers } = await fixture()
    const resolve = vi.fn(async (value: string) => value)
    const guarded = createDirectoryPreferencesHandlers(manager, resolve)
    const mutate = vi.spyOn(manager, 'mutateDirectoryPreferences')
    expect(
      await guarded.mutate({ action: 'addFavorite', path: root, extra: true })
    ).toEqual({ ok: false, error: { code: 'invalidPath' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    expect(await guarded.get({ extra: true })).toEqual({
      ok: false,
      error: { code: 'invalidPath' },
    })
    expect(
      await handlers.mutate({ action: 'addFavorite', path: 'relative' })
    ).toEqual({ ok: false, error: { code: 'invalidPath' } })
    expect(
      await handlers.mutate({
        action: 'recordRecent',
        path: path.join(root, 'missing'),
      })
    ).toEqual({ ok: false, error: { code: 'notFound' } })
    const file = path.join(root, 'file')
    await writeFile(file, '')
    expect(
      await handlers.mutate({ action: 'addFavorite', path: file })
    ).toEqual({ ok: false, error: { code: 'notDirectory' } })
  })

  it('leaves the durable snapshot unchanged when persistence fails', async () => {
    const { root, manager, handlers, settingsPath } = await fixture()
    await handlers.mutate({ action: 'addFavorite', path: root })
    const before = await readFile(settingsPath, 'utf8')
    // Fail the atomic save before publication; the earlier real file remains readable.
    vi.spyOn(
      manager as unknown as { saveSettings: () => Promise<void> },
      'saveSettings'
    ).mockRejectedValueOnce(new Error('/private/disk failure'))
    expect(await handlers.mutate({ action: 'clearRecent' })).toMatchObject({
      ok: true,
    })
    expect(
      await handlers.mutate({
        action: 'removeFavorite',
        paths: [await realpath(root)],
      })
    ).toEqual({ ok: false, error: { code: 'unavailable' } })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(manager.getApp().directoryPreferences.favorites).toEqual([
      await realpath(root),
    ])
  })
})
