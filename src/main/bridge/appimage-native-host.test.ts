import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AppImageNativeHost,
  type AppImageNativeHostOptions,
} from './appimage-native-host'
import { computeManifestPaths } from './native-messaging-installer'

const ids = { chromium: ['a'.repeat(32)], firefox: ['test@motrix.app'] }
let root: string
let options: AppImageNativeHostOptions
let host: AppImageNativeHost
function elf(marker = 0): Buffer {
  const bytes = Buffer.alloc(256, marker)
  bytes.write('\x7fELF')
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(183, 18)
  return bytes
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'motrix-appimage-')))
  await chmod(root, 0o700)
  const appImagePath = join(root, 'Motrix 中文 image.AppImage')
  const sourceHostPath = join(root, 'motrix-native-host')
  await writeFile(appImagePath, elf(1), { mode: 0o500 })
  await writeFile(sourceHostPath, elf(2), { mode: 0o500 })
  options = {
    home: root,
    env: {},
    appImagePath,
    sourceHostPath,
    arch: 'arm64',
    userDataDir: join(root, 'profile'),
    bridgeDataDir: join(root, 'profile/bridge'),
    systemManifestRoots: [],
  }
  host = new AppImageNativeHost(options)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const configPath = () => join(host.directory, 'appimage.json')
const paths = () => Object.values(computeManifestPaths('linux', root))

describe('AppImage Native Host installation', () => {
  it('requires explicit consent, installs a stable copy, and keeps it across refreshes', async () => {
    await host.sync(ids)
    await expect(readFile(configPath())).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await host.configure('enable', ids, true)).toMatchObject({
      enabled: true,
      healthy: true,
      currentTarget: true,
    })
    const first = JSON.parse(await readFile(configPath(), 'utf8'))
    for (const path of paths())
      expect(JSON.parse(await readFile(path, 'utf8')).path).toBe(host.hostPath)
    await host.sync(ids)
    expect(JSON.parse(await readFile(configPath(), 'utf8')).installId).toBe(
      first.installId
    )
    await rm(options.sourceHostPath)
    expect(await host.inspect()).toMatchObject({ healthy: true })
  })

  it('stops wake on disable and removal, but only removal revokes consent', async () => {
    await host.configure('enable', ids, true)
    await host.suspend()
    expect(await host.inspect()).toMatchObject({
      enabled: false,
      consent: 'accepted',
    })
    for (const path of paths())
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await host.sync(ids)
    expect(await host.inspect()).toMatchObject({ healthy: true })
    await host.configure('remove', ids, true)
    await host.sync(ids)
    expect(await host.inspect()).toMatchObject({
      enabled: false,
      consent: 'declined',
    })
    await expect(readFile(host.hostPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(options.appImagePath)).toEqual(elf(1))
  })

  it('preserves foreign manifests on install and on removal', async () => {
    const path = paths()[0]
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{"path":"/other/host"}')
    expect(await host.configure('enable', ids, true)).toMatchObject({
      issue: 'conflict',
    })
    await expect(readFile(configPath())).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await rm(path)
    await host.configure('enable', ids, true)
    await writeFile(path, 'external owner')
    expect(await host.configure('remove', ids, true)).toMatchObject({
      issue: 'conflict',
      enabled: false,
    })
    expect(await readFile(path, 'utf8')).toBe('external owner')
  })

  it('revokes launch before attempting cleanup of a damaged update receipt', async () => {
    await host.configure('enable', ids, true)
    await writeFile(`${configPath()}.bak`, 'damaged', { mode: 0o600 })
    expect(await host.configure('remove', ids, true)).toMatchObject({
      consent: 'declined',
      enabled: false,
      issue: 'invalid',
    })
    expect(await readFile(`${configPath()}.bak`, 'utf8')).toBe('damaged')
  })

  it('rejects symlinks and unsafe source permissions', async () => {
    await chmod(options.appImagePath, 0o777)
    expect(await host.configure('enable', ids, true)).toMatchObject({
      issue: 'permissions',
    })
    await chmod(options.appImagePath, 0o500)
    const path = paths()[0]
    await mkdir(dirname(path), { recursive: true })
    await symlink(options.appImagePath, path)
    expect(await host.configure('enable', ids, true)).toMatchObject({
      issue: 'permissions',
    })
    expect(await readFile(options.appImagePath)).toEqual(elf(1))
  })

  it('moves only after an explicit repair from the intended image', async () => {
    await host.configure('enable', ids, true)
    const moved = join(root, 'Moved "image".AppImage')
    await rename(options.appImagePath, moved)
    const next = new AppImageNativeHost({ ...options, appImagePath: moved })
    await next.sync(ids)
    expect(await next.inspect()).toMatchObject({
      healthy: false,
      issue: 'missing',
      currentTarget: false,
    })
    expect(await next.configure('repair', ids, true)).toMatchObject({
      healthy: true,
      currentTarget: true,
    })
  })

  it('detects source replacement and refreshes only after running the same path', async () => {
    await host.configure('enable', ids, true)
    await chmod(options.appImagePath, 0o700)
    await writeFile(options.appImagePath, elf(3))
    expect(await host.inspect()).toMatchObject({
      healthy: false,
      issue: 'sourceChanged',
    })
    await host.sync(ids)
    expect(await host.inspect()).toMatchObject({ healthy: true })
  })

  it('repairs a missing host and old manifests using the interrupted-update receipt', async () => {
    await host.configure('enable', ids, true)
    const original = await readFile(configPath(), 'utf8')
    await writeFile(`${configPath()}.bak`, original, { mode: 0o600 })
    const interrupted = JSON.parse(original)
    interrupted.manifests = interrupted.manifests.map(
      (m: { path: string }) => ({ ...m, sha256: '0'.repeat(64) })
    )
    await writeFile(configPath(), JSON.stringify(interrupted))
    await rm(host.hostPath)
    expect(await host.configure('repair', ids, true)).toMatchObject({
      healthy: true,
    })
    await expect(readFile(`${configPath()}.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not take over a different user-data profile', async () => {
    await host.configure('enable', ids, true)
    const other = new AppImageNativeHost({
      ...options,
      userDataDir: join(root, 'other'),
    })
    expect(await other.configure('enable', ids, true)).toMatchObject({
      issue: 'conflict',
    })
    expect(await host.inspect()).toMatchObject({ healthy: true })
    await host.suspend()
    expect(await other.configure('enable', ids, true)).toMatchObject({
      issue: 'conflict',
    })
    expect(await host.inspect()).toMatchObject({ enabled: false })
  })

  it('allows only one profile to claim a new shared installation', async () => {
    const other = new AppImageNativeHost({
      ...options,
      userDataDir: join(root, 'other'),
    })
    const results = await Promise.all([
      host.configure('enable', ids, true),
      other.configure('enable', ids, true),
    ])
    expect(
      results.filter((result) => result.supported && result.healthy)
    ).toHaveLength(1)
    expect(
      results.filter(
        (result) => result.supported && result.issue === 'conflict'
      )
    ).toHaveLength(1)
  })

  it('uses XDG browser paths but keeps Firefox in its native manifest directory', async () => {
    const env = {
      XDG_CONFIG_HOME: join(root, 'config'),
      CHROME_CONFIG_HOME: join(root, 'chrome-config'),
      XDG_DATA_HOME: join(root, 'data'),
    }
    const scoped = new AppImageNativeHost({ ...options, env })
    expect(await scoped.configure('enable', ids, true)).toMatchObject({
      healthy: true,
    })
    const output = computeManifestPaths('linux', root, undefined, env)
    expect(output.chrome).toContain('/chrome-config/')
    expect(output.firefox).toBe(
      join(root, '.mozilla/native-messaging-hosts/app.motrix.bridge.json')
    )
    expect(scoped.hostPath).toContain('/data/motrix/')
  })
})
