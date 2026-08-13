// End-to-end exercise of PluginInstaller across fresh install, upgrade
// (silent + consent), source-URL drift, rollback, uninstall cascade, and
// the zip-slip + id-immutability boundary checks.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityHost } from '../capabilities/interface'
import { PluginHost } from '../host/plugin-host'
import { PluginRegistry } from '../plugin-registry'
import { downloadRegistryMoext } from '../registry/registry-fetcher'
import { PluginStateStore } from '../state/plugin-state-store'
import {
  PluginInstaller,
  type PluginInstallerOptions,
  type PluginRuntimeHostLike,
} from './plugin-installer'
import { buildRegistryExpectation } from './registry-expectation'

// ---------------------------------------------------------------------------
// Tiny zip writer (same as moext-reader.test) — keeps fixtures local + diffable.
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string
  data: Buffer
  externalAttrUpper16?: number
}

function crc32(buf: Buffer): number {
  let c = 0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries: FakeEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18)
    lfh.writeUInt32LE(size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    local.push(lfh, nameBuf, e.data)
    const ls = offset
    offset += lfh.length + nameBuf.length + e.data.length
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(size, 20)
    cdh.writeUInt32LE(size, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(((e.externalAttrUpper16 ?? 0) << 16) >>> 0, 38)
    cdh.writeUInt32LE(ls, 42)
    central.push(cdh, nameBuf)
  }
  const localB = Buffer.concat(local)
  const centralB = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralB.length, 12)
  eocd.writeUInt32LE(localB.length, 16)
  return Buffer.concat([localB, centralB, eocd])
}

function manifestJSON(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifestVersion: 1,
    id: 'example.test',
    name: 'Test',
    version: '1.0.0',
    description: 'test',
    categories: ['integration'],
    engines: { motrix: '^2.0.0' },
    main: 'dist/plugin.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  })
}

async function writeMoext(
  filePath: string,
  manifest: string,
  bundle: Buffer = Buffer.from('console.log(1);', 'utf8'),
  extraEntries: FakeEntry[] = []
): Promise<string> {
  const buf = makeZip([
    { name: 'motrix-plugin.json', data: Buffer.from(manifest, 'utf8') },
    { name: 'dist/plugin.js', data: bundle },
    ...extraEntries,
  ])
  await writeFile(filePath, buf)
  return filePath
}

// ---------------------------------------------------------------------------
// CapabilityHost stub — tracks cascade calls, no-ops everything else.
// ---------------------------------------------------------------------------

interface CascadeCalls {
  deactivated: string[]
  storageDeleteAll: string[]
  metadataDeleteAllForPlugin: string[]
  cookieJarsCleared: string[]
}

function makeHost(calls: CascadeCalls): CapabilityHost {
  const noop = () => {}
  const noopAsync = async () => {}
  return {
    createLog: () => ({
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    }),
    getTail: () => [],
    clearLog: () => {},
    setLogVerbose: () => {},
    isLogVerbose: () => false,
    subscribeLog: () => noop,
    appSnapshot: () => ({
      version: '2.5.0',
      platform: 'darwin',
      runtime: 'server',
      locale: 'en-US',
      arch: 'arm64',
    }),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr',
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: noop,
    onLocaleChange: () => noop,
    flush: noopAsync,
    http: null as unknown as CapabilityHost['http'],
    fsTaskFor: () => null as unknown as ReturnType<CapabilityHost['fsTaskFor']>,
    fsStorageFor: () =>
      null as unknown as ReturnType<CapabilityHost['fsStorageFor']>,
    storage: {
      deleteAll: async (pluginId: string) => {
        calls.storageDeleteAll.push(pluginId)
        return { deleted: 0 }
      },
    } as unknown as CapabilityHost['storage'],
    metadata: {
      deleteAllForPlugin: async (pluginId: string) => {
        calls.metadataDeleteAllForPlugin.push(pluginId)
        return { deleted: 0 }
      },
    } as unknown as CapabilityHost['metadata'],
    crypto: null as unknown as CapabilityHost['crypto'],
    configFor: () => null as unknown as ReturnType<CapabilityHost['configFor']>,
    lifecycle: {
      runDeactivate: async (pluginId: string) => {
        calls.deactivated.push(pluginId)
      },
    } as unknown as CapabilityHost['lifecycle'],
    commands: null as unknown as CapabilityHost['commands'],
    notify: null as unknown as CapabilityHost['notify'],
    ffmpeg: null as unknown as CapabilityHost['ffmpeg'],
    secrets: null as unknown as CapabilityHost['secrets'],
    cookieJarFor: (pluginId: string) =>
      ({
        clear: () => calls.cookieJarsCleared.push(pluginId),
      }) as unknown as ReturnType<CapabilityHost['cookieJarFor']>,
  }
}

// ---------------------------------------------------------------------------
// Test fixture wiring
// ---------------------------------------------------------------------------

let tmp: string
let pluginsDir: string
let stateStore: PluginStateStore
let registry: PluginRegistry
let installer: PluginInstaller
let calls: CascadeCalls
let inputDir: string

async function makeInstaller(
  extra: Partial<PluginInstallerOptions> = {}
): Promise<PluginInstaller> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE plugin_state (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      error_count INTEGER NOT NULL,
      installed_at INTEGER NOT NULL,
      last_activated_at INTEGER
    )
  `)
  stateStore = new PluginStateStore(db)
  registry = new PluginRegistry({
    pluginsDir,
    builtinDir: path.join(tmp, 'builtin-empty'),
    stateStore,
    hostVersion: '2.5.0',
  })
  calls = {
    deactivated: [],
    storageDeleteAll: [],
    metadataDeleteAllForPlugin: [],
    cookieJarsCleared: [],
  }
  return new PluginInstaller({
    pluginsDir,
    registry,
    stateStore,
    capabilityHost: makeHost(calls),
    hostVersion: '2.5.0',
    ...extra,
  })
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-installer-e2e-'))
  pluginsDir = path.join(tmp, 'plugins')
  inputDir = path.join(tmp, 'inputs')
  await mkdir(pluginsDir, { recursive: true })
  await mkdir(inputDir, { recursive: true })
  installer = await makeInstaller()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('PluginInstaller e2e', () => {
  it('fresh install: produces consent payload, commit writes _install.json + indexes plugin', async () => {
    const moext = await writeMoext(
      path.join(inputDir, 'v1.moext'),
      manifestJSON()
    )

    const { stagingId, consent, committed } = await installer.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    expect(committed).toBe(false)
    expect(consent.manifest.id).toBe('example.test')
    expect(consent.diff).toBeNull()

    await installer.commit(stagingId, {})

    const finalDir = path.join(pluginsDir, 'example.test')
    expect(existsSync(path.join(finalDir, '_install.json'))).toBe(true)
    const recordRaw = JSON.parse(
      await readFile(path.join(finalDir, '_install.json'), 'utf8')
    )
    expect(recordRaw.pluginId).toBe('example.test')
    expect(recordRaw.source.url).toBe('https://github.com/example/test')
    expect(recordRaw.consentSnapshot.permissions).toEqual([])

    expect(registry.get('example.test')).toBeDefined()
  })

  it('upgrade with no trust-surface change: silent commit', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const { stagingId: id1 } = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(id1, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ version: '1.0.1' }),
      Buffer.from('console.log(2);', 'utf8')
    )
    const staged = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })
    expect(staged).toMatchObject({
      committed: true,
      pluginId: 'example.test',
    })

    const onDisk = await readFile(
      path.join(pluginsDir, 'example.test', 'dist/plugin.js'),
      'utf8'
    )
    expect(onDisk).toBe('console.log(2);')
  })

  it('upgrade with new permission: consent payload contains permissionsAdded', async () => {
    const v1 = await writeMoext(
      path.join(inputDir, 'v1.moext'),
      manifestJSON({ permissions: ['http'] })
    )
    const { stagingId: id1 } = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(id1, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ permissions: ['http', 'storage'], version: '1.1.0' })
    )
    const { consent } = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })
    expect(consent.diff?.permissionsAdded).toEqual(['storage'])
  })

  it('upgrade with source URL changed: diff.sourceUrlChanged populated', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const { stagingId: id1 } = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(id1, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ version: '1.0.1' })
    )
    const { consent } = await installer.stage(v2, {
      type: 'url',
      url: 'https://untrusted.example/test.moext',
    })
    expect(consent.diff?.sourceUrlChanged).toEqual({
      from: 'https://github.com/example/test',
      to: 'https://untrusted.example',
    })
  })

  it('keeps only the protected archive pending and re-reads it at commit', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const { stagingId: id1 } = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(id1, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ permissions: ['http'], version: '1.1.0' }),
      Buffer.from('console.log(2);', 'utf8')
    )
    const { stagingId: id2 } = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })

    const stagingPath = path.join(pluginsDir, '_staging', id2)
    const archivePath = path.join(stagingPath, 'archive.moext')
    expect((await readFile(archivePath)).equals(await readFile(v2))).toBe(true)
    expect(existsSync(path.join(stagingPath, 'tree'))).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(archivePath)).mode & 0o777).toBe(0o600)
    }

    await installer.commit(id2, {})
    const committed = await readFile(
      path.join(pluginsDir, 'example.test', 'dist/plugin.js'),
      'utf8'
    )
    expect(committed).toBe('console.log(2);')
    expect(existsSync(stagingPath)).toBe(false)
  })

  it('rejects a staged archive changed after consent and lets cancel clean it', async () => {
    const moext = await writeMoext(
      path.join(inputDir, 'tampered-archive.moext'),
      manifestJSON()
    )
    const staged = await installer.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    const stagingPath = path.join(pluginsDir, '_staging', staged.stagingId)
    const archivePath = path.join(stagingPath, 'archive.moext')
    await writeFile(
      archivePath,
      Buffer.concat([await readFile(archivePath), Buffer.from([0])])
    )

    await expect(installer.commit(staged.stagingId, {})).rejects.toMatchObject({
      message: 'plugin.install.sha256_mismatch',
    })
    expect(existsSync(path.join(pluginsDir, 'example.test'))).toBe(false)

    await installer.cancel(staged.stagingId)
    expect(existsSync(stagingPath)).toBe(false)
  })

  it('rejects a stale consent when the install changes before commit', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const first = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(first.stagingId, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ permissions: ['http'], version: '1.1.0' }),
      Buffer.from('console.log(2);', 'utf8')
    )
    const staged = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })
    const recordPath = path.join(pluginsDir, 'example.test', '_install.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    record.grants = { storage: 'granted' }
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)

    await expect(installer.commit(staged.stagingId, {})).rejects.toMatchObject({
      message: 'plugin.install.changed_since_staging',
    })
    expect(
      await readFile(
        path.join(pluginsDir, 'example.test', 'dist/plugin.js'),
        'utf8'
      )
    ).toBe('console.log(1);')
  })

  it('serializes concurrent commits and rejects the stale transaction', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const first = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(first.stagingId, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ permissions: ['http'], version: '1.1.0' }),
      Buffer.from('console.log(2);', 'utf8')
    )
    const v3 = await writeMoext(
      path.join(inputDir, 'v3.moext'),
      manifestJSON({ permissions: ['storage'], version: '1.2.0' }),
      Buffer.from('console.log(3);', 'utf8')
    )
    const staged2 = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })
    const staged3 = await installer.stage(v3, {
      type: 'github',
      spec: 'example/test',
    })

    const results = await Promise.allSettled([
      installer.commit(staged2.stagingId, {}),
      installer.commit(staged3.stagingId, {}),
    ])

    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { message: 'plugin.install.changed_since_staging' },
    })
    expect(
      await readFile(
        path.join(pluginsDir, 'example.test', 'dist/plugin.js'),
        'utf8'
      )
    ).toBe('console.log(2);')
  })

  it('aborts an upgrade until the runtime is quiescent', async () => {
    const v1 = await writeMoext(path.join(inputDir, 'v1.moext'), manifestJSON())
    const first = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(first.stagingId, {})

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ permissions: ['http'], version: '1.1.0' }),
      Buffer.from('console.log(2);', 'utf8')
    )
    const update = await installer.stage(v2, {
      type: 'github',
      spec: 'example/test',
    })
    const incompleteRuntime: PluginRuntimeHostLike = {
      isQuiescent: () => false,
      deactivate: vi.fn(async () => undefined),
    }

    await expect(
      installer.commit(update.stagingId, {}, incompleteRuntime)
    ).rejects.toMatchObject({
      message: 'plugin.install.runtime_still_active',
    })
    expect(incompleteRuntime.deactivate).toHaveBeenCalledWith('example.test')
    expect(
      await readFile(
        path.join(pluginsDir, 'example.test', 'dist/plugin.js'),
        'utf8'
      )
    ).toBe('console.log(1);')
  })

  it('uninstall purges state + storage + metadata + cookie jar + dir', async () => {
    const moext = await writeMoext(
      path.join(inputDir, 'v1.moext'),
      manifestJSON()
    )
    const { stagingId } = await installer.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(stagingId, {})
    expect(stateStore.get('example.test')).toBeDefined()

    await installer.uninstall('example.test')

    expect(calls.deactivated).toContain('example.test')
    expect(calls.storageDeleteAll).toEqual(['example.test'])
    expect(calls.metadataDeleteAllForPlugin).toEqual(['example.test'])
    expect(calls.cookieJarsCleared).toEqual(['example.test'])
    expect(stateStore.get('example.test')).toBeUndefined()
    expect(existsSync(path.join(pluginsDir, 'example.test'))).toBe(false)
  })

  it('uninstall rejects traversal before touching state or files', async () => {
    const sentinel = path.join(tmp, 'keep.txt')
    await writeFile(sentinel, 'keep')

    await expect(installer.uninstall('..')).rejects.toMatchObject({
      message: 'plugin.install.invalid_plugin_id',
    })

    expect(existsSync(sentinel)).toBe(true)
    expect(calls.deactivated).toEqual([])
    expect(calls.storageDeleteAll).toEqual([])
  })

  it('keeps uninstall compatible with a valid unmanaged plugin directory', async () => {
    const unmanagedDir = path.join(pluginsDir, 'example.unmanaged')
    await mkdir(unmanagedDir, { recursive: true })
    await writeFile(path.join(unmanagedDir, 'marker'), 'present')

    await installer.uninstall('example.unmanaged')

    expect(existsSync(unmanagedDir)).toBe(false)
    expect(calls.deactivated).toContain('example.unmanaged')
  })

  it('zip-slip moext rejected at stage', async () => {
    const bad = makeZip([
      {
        name: 'motrix-plugin.json',
        data: Buffer.from(manifestJSON(), 'utf8'),
      },
      { name: '../escape.txt', data: Buffer.from('pwn', 'utf8') },
    ])
    const moext = path.join(inputDir, 'evil.moext')
    await writeFile(moext, bad)
    await expect(
      installer.stage(moext, {
        type: 'local',
        absPath: moext,
        fileHash: createHash('sha256').update(bad).digest('hex'),
      })
    ).rejects.toMatchObject({ message: 'plugin.install.zip_slip' })
    expect(existsSync(path.join(pluginsDir, 'example.test'))).toBe(false)
    void readdir
  })

  it('rejects a local package when the claimed file hash differs', async () => {
    const moext = await writeMoext(
      path.join(inputDir, 'hash-mismatch.moext'),
      manifestJSON()
    )

    await expect(
      installer.stage(moext, {
        type: 'local',
        absPath: moext,
        fileHash: '0'.repeat(64),
      })
    ).rejects.toMatchObject({
      message: 'plugin.install.local_file_hash_mismatch',
    })
  })

  it('id immutable: stage with a different prior pluginId rejected', async () => {
    const v1 = await writeMoext(
      path.join(inputDir, 'v1.moext'),
      manifestJSON({ id: 'example.test' })
    )
    const { stagingId } = await installer.stage(v1, {
      type: 'github',
      spec: 'example/test',
    })
    await installer.commit(stagingId, {})

    const dir = path.join(pluginsDir, 'example.test')
    const existing = JSON.parse(
      await readFile(path.join(dir, '_install.json'), 'utf8')
    )
    existing.pluginId = 'example.other'
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(existing, null, 2)
    )

    const v2 = await writeMoext(
      path.join(inputDir, 'v2.moext'),
      manifestJSON({ id: 'example.test', version: '1.0.1' })
    )
    await expect(
      installer.stage(v2, { type: 'github', spec: 'example/test' })
    ).rejects.toMatchObject({
      message: 'plugin.manifest.id_collision_with_builtin',
    })
  })
})

describe('PluginInstaller.stage — ffmpeg gate', () => {
  it('required + missing ffmpeg → ABORT unsupported_on_runtime; staging cleaned', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({ available: false }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'req.moext'),
      manifestJSON({ permissions: ['ffmpeg'] })
    )
    await expect(
      inst.stage(moext, { type: 'github', spec: 'example/test' })
    ).rejects.toMatchObject({
      message: 'plugin.manifest.permissions.unsupported_on_runtime',
    })
    const stagingRoot = path.join(pluginsDir, '_staging')
    const leftover = existsSync(stagingRoot) ? await readdir(stagingRoot) : []
    expect(leftover).toEqual([])
  })

  it('required + old version → ABORT engines.ffmpeg_too_old (mentions detected version)', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({
        available: true,
        version: '3.4.2',
        binaryPath: '/u/b',
      }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'reqver.moext'),
      manifestJSON({
        permissions: ['ffmpeg'],
        engines: { motrix: '^2.0.0', ffmpeg: '>=4.4' },
      })
    )
    await expect(
      inst.stage(moext, { type: 'github', spec: 'example/test' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('3.4.2'),
    })
    const stagingRoot = path.join(pluginsDir, '_staging')
    const leftover = existsSync(stagingRoot) ? await readdir(stagingRoot) : []
    expect(leftover).toEqual([])
  })

  it('optional + missing → succeed; consent reflects degraded', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({ available: false }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'opt.moext'),
      manifestJSON({ optionalPermissions: ['ffmpeg'] })
    )
    const { consent } = await inst.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    expect(consent.ffmpegRuntime.available).toBe(false)
    expect(consent.ffmpegRuntime.requiredByPlugin).toBe('optional')
  })

  it('optional + old version → succeed; consent.satisfiesRange === false', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({
        available: true,
        version: '3.4.2',
        binaryPath: '/x',
      }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'optver.moext'),
      manifestJSON({
        optionalPermissions: ['ffmpeg'],
        engines: { motrix: '^2.0.0', ffmpeg: '>=4.4' },
      })
    )
    const { consent } = await inst.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    expect(consent.ffmpegRuntime.satisfiesRange).toBe(false)
  })

  it('required + satisfies → succeed; consent.ffmpegRuntime all green', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({
        available: true,
        version: '6.0.1',
        binaryPath: '/x',
      }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'reqok.moext'),
      manifestJSON({
        permissions: ['ffmpeg'],
        engines: { motrix: '^2.0.0', ffmpeg: '>=4.4' },
      })
    )
    const { consent } = await inst.stage(moext, {
      type: 'github',
      spec: 'example/test',
    })
    expect(consent.ffmpegRuntime.available).toBe(true)
    expect(consent.ffmpegRuntime.satisfiesRange).toBe(true)
  })

  it('optional + missing → stage+commit complete; host advertises false at activate', async () => {
    const inst = await makeInstaller({
      ffmpegDetect: async () => ({ available: false }),
    })
    const moext = await writeMoext(
      path.join(inputDir, 'optffmpeg.moext'),
      manifestJSON({
        id: 'example.optffmpeg',
        optionalPermissions: ['ffmpeg'],
      })
    )
    const { stagingId, consent } = await inst.stage(moext, {
      type: 'github',
      spec: 'example/optffmpeg',
    })
    expect(consent.ffmpegRuntime.requiredByPlugin).toBe('optional')
    expect(consent.ffmpegRuntime.available).toBe(false)

    await inst.commit(stagingId, {})

    // Plugin must be on disk + indexed after commit.
    expect(existsSync(path.join(pluginsDir, 'example.optffmpeg'))).toBe(true)
    expect(registry.get('example.optffmpeg')).toBeDefined()

    // Write a minimal stub worker that responds to init → ready and
    // deactivate → deactivateComplete.
    const workerPath = path.join(tmp, 'StubWorker.cjs')
    writeFileSync(
      workerPath,
      [
        "const { parentPort } = require('worker_threads')",
        "parentPort.on('message', (msg) => {",
        "  if (msg.type === 'init') {",
        "    parentPort.postMessage({ type: 'ready' })",
        "  } else if (msg.type === 'event' && msg.event === 'deactivate') {",
        "    parentPort.postMessage({ type: 'event', event: 'deactivateComplete', ok: true })",
        '  }',
        '})',
      ].join('\n')
    )

    // makeInstaller() stored stateStore, registry, and calls into module-level
    // vars — reuse them so the PluginHost sees the same DB row and manifest
    // that the installer wrote.
    const host = new PluginHost({
      registry,
      stateStore,
      capabilityHost: makeHost(calls),
      workerScriptPath: workerPath,
      appVersion: '2.5.0',
      runtime: 'server',
      hostLanguage: 'en-US',
      ffmpegDetect: async () => ({ available: false }),
    })

    await host.activate('example.optffmpeg')
    expect(host.isActive('example.optffmpeg')).toBe(true)
    expect(host.getFfmpegAdvertised('example.optffmpeg')).toBe(false)

    await host.shutdown()
  })
})

describe('registry source install', () => {
  let downloadsDir: string

  beforeEach(async () => {
    downloadsDir = path.join(tmp, 'downloads')
    await mkdir(downloadsDir, { recursive: true })
  })

  function registryEntry(bytes: Buffer, version: string): RegistryPluginDTO {
    return {
      id: 'example.test',
      listing: {
        defaultLocale: 'en-US',
        localizations: { 'en-US': { name: 'Test', description: 'test' } },
      },
      version,
      author: { name: 'Example' },
      origin: 'community',
      categories: ['integration'],
      engines: { motrix: '^2.0.0' },
      permissions: [],
      optionalPermissions: [],
      hostPermissions: [],
      screenshots: [],
      updatedAt: '2026-07-01',
      featured: false,
      compatible: true,
      package: {
        url: 'https://dl.motrix.app/p/example.test.moext',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
      },
    }
  }

  const fakeFetchOf = (bytes: Buffer): typeof fetch =>
    (async () =>
      new Response(Uint8Array.from(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })) as unknown as typeof fetch

  it('installs, records registry source, and silently upgrades', async () => {
    // v1 — download through the verified fetcher, stage with expectation
    const v1 = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON()) },
      { name: 'dist/plugin.js', data: Buffer.from('exports.x=1') },
    ])
    const entry1 = registryEntry(v1, '1.0.0')
    const dl1 = path.join(downloadsDir, 'v1.moext')
    await downloadRegistryMoext(entry1, dl1, fakeFetchOf(v1))

    const staged = await installer.stage(
      dl1,
      { type: 'registry', pluginId: 'example.test' },
      { expect: buildRegistryExpectation(entry1) }
    )
    await installer.commit(staged.stagingId, {})

    const record = JSON.parse(
      await readFile(
        path.join(pluginsDir, 'example.test', '_install.json'),
        'utf8'
      )
    )
    expect(record.source.type).toBe('registry')
    expect(record.source.url).toBe('registry:example.test')

    // v1.1 — same trust surface: stage() auto-commits (silent upgrade)
    const v2 = makeZip([
      {
        name: 'motrix-plugin.json',
        data: Buffer.from(manifestJSON({ version: '1.1.0' })),
      },
      { name: 'dist/plugin.js', data: Buffer.from('exports.x=2') },
    ])
    const entry2 = registryEntry(v2, '1.1.0')
    const dl2 = path.join(downloadsDir, 'v2.moext')
    await downloadRegistryMoext(entry2, dl2, fakeFetchOf(v2))
    await installer.stage(
      dl2,
      { type: 'registry', pluginId: 'example.test' },
      { expect: buildRegistryExpectation(entry2) }
    )
    const upgraded = JSON.parse(
      await readFile(
        path.join(pluginsDir, 'example.test', '_install.json'),
        'utf8'
      )
    )
    expect(upgraded.consentSnapshot.enginesMotrix).toBe('^2.0.0')

    const installedBundle = await readFile(
      path.join(pluginsDir, 'example.test', 'dist', 'plugin.js'),
      'utf8'
    )
    expect(installedBundle).toBe('exports.x=2')
  })

  it('rejects a registry package replaced after verified download', async () => {
    const verified = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON()) },
      { name: 'dist/plugin.js', data: Buffer.from('exports.x=1') },
    ])
    const replaced = makeZip([
      { name: 'motrix-plugin.json', data: Buffer.from(manifestJSON()) },
      { name: 'dist/plugin.js', data: Buffer.from('exports.x=2') },
    ])
    const entry = registryEntry(verified, '1.0.0')
    const downloaded = path.join(downloadsDir, 'replaced.moext')
    await downloadRegistryMoext(entry, downloaded, fakeFetchOf(verified))
    await writeFile(downloaded, replaced)

    await expect(
      installer.stage(
        downloaded,
        { type: 'registry', pluginId: 'example.test' },
        { expect: buildRegistryExpectation(entry) }
      )
    ).rejects.toMatchObject({ message: 'plugin.install.sha256_mismatch' })
    expect(registry.get('example.test')).toBeUndefined()
  })

  it('rejects a package whose manifest disagrees with the registry entry', async () => {
    const v3 = makeZip([
      {
        name: 'motrix-plugin.json',
        data: Buffer.from(manifestJSON({ version: '1.1.0' })),
      },
      { name: 'dist/plugin.js', data: Buffer.from('exports.x=3') },
    ])
    // registry claims 1.2.0 but the package manifest says 1.1.0
    const lying = registryEntry(v3, '1.2.0')
    const dl = path.join(downloadsDir, 'lying.moext')
    await downloadRegistryMoext(lying, dl, fakeFetchOf(v3))
    await expect(
      installer.stage(
        dl,
        { type: 'registry', pluginId: 'example.test' },
        { expect: buildRegistryExpectation(lying) }
      )
    ).rejects.toThrowError(/registry_manifest_mismatch/)
  })
})
