import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { PluginManifest } from '@shared/types/plugin'
import type {
  InstallRecord,
  InstallRecordSource,
} from '@shared/types/plugin-install'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPlugin, PluginRegistry } from '../plugin-registry'
import { GrantsManager } from './grants-manager'

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'test.demo',
    name: 'Demo',
    version: '1.0.0',
    description: 'Demo plugin',
    categories: ['integration'],
    engines: { motrix: '>=2.0.0' },
    main: 'dist/plugin.js',
    permissions: ['storage'],
    optionalPermissions: ['notify', 'ffmpeg'],
    activationEvents: [],
    hostPermissions: [],
    contributes: { commands: [] },
    ...overrides,
  } as PluginManifest
}

function makeRecord(grants: InstallRecord['grants']): InstallRecord {
  const source: InstallRecordSource = {
    type: 'local',
    url: 'local:abc',
    bundleSha256: 'a'.repeat(64),
    recordedAt: 0,
  }
  return {
    version: 1,
    pluginId: 'test.demo',
    source,
    grants,
    consentSnapshot: {
      permissions: ['storage'],
      optionalPermissions: ['notify', 'ffmpeg'],
      invokesCommands: [],
      publicCommands: {},
      requestedHeapMB: 32,
      enginesMotrix: '>=2.0.0',
      hostPermissions: [],
    },
  } as InstallRecord
}

function makeRegistry(
  rootDir: string,
  overrides: Partial<IndexedPlugin> = {}
): PluginRegistry {
  const indexed: IndexedPlugin = {
    manifestRaw: makeManifest(),
    manifest: makeManifest(),
    origin: 'community',
    rootDir,
    state: {} as IndexedPlugin['state'],
    ...overrides,
  }
  return {
    get: vi.fn((id: string) =>
      id === 'test.demo' ? indexed : undefined
    ) as unknown as PluginRegistry['get'],
    entries: vi.fn(() => [indexed]) as unknown as PluginRegistry['entries'],
  } as unknown as PluginRegistry
}

describe('GrantsManager', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'grants-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('getGrants reads persisted grants', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({ notify: 'denied' }))
    )
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    expect(await gm.getGrants('test.demo')).toEqual({ notify: 'denied' })
  })

  it('getGrants returns empty when no install record', async () => {
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    expect(await gm.getGrants('test.demo')).toEqual({})
  })

  it('getGrants drops keys removed from manifest.optionalPermissions', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({ notify: 'granted', stale: 'granted' }))
    )
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    expect(await gm.getGrants('test.demo')).toEqual({ notify: 'granted' })
  })

  it('updateGrants merges patch, persists, and emits event', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({ notify: 'denied' }))
    )
    const emit = vi.fn()
    const gm = new GrantsManager({
      registry: makeRegistry(dir),
      eventBus: { emit },
    })

    const result = await gm.updateGrants('test.demo', { notify: 'granted' })
    expect(result).toEqual({ notify: 'granted' })

    const written = JSON.parse(
      await readFile(path.join(dir, '_install.json'), 'utf8')
    )
    expect(written.grants).toEqual({ notify: 'granted' })

    expect(emit).toHaveBeenCalledWith('event:pluginGrantsChanged', {
      pluginId: 'test.demo',
    })
  })

  it('updateGrants rejects unknown permission key', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({}))
    )
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    await expect(
      gm.updateGrants('test.demo', { storage: 'granted' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginPermissionUnsupported,
    })
  })

  it('updateGrants rejects builtin plugins', async () => {
    const gm = new GrantsManager({
      registry: makeRegistry(dir, { origin: 'builtin' }),
    })
    await expect(
      gm.updateGrants('test.demo', { notify: 'granted' })
    ).rejects.toBeInstanceOf(AppError)
  })

  it('updateGrants rejects dev plugins', async () => {
    const gm = new GrantsManager({
      registry: makeRegistry(dir, { dev: true }),
    })
    await expect(
      gm.updateGrants('test.demo', { notify: 'granted' })
    ).rejects.toBeInstanceOf(AppError)
  })

  it('effectivePermissionsFor unions required + granted optional', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({ notify: 'granted', ffmpeg: 'denied' }))
    )
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    const eff = await gm.effectivePermissionsFor('test.demo')
    expect(eff).toEqual(new Set(['storage', 'notify']))
  })

  it('listAllGrants returns map keyed by pluginId', async () => {
    await writeFile(
      path.join(dir, '_install.json'),
      JSON.stringify(makeRecord({ notify: 'granted' }))
    )
    const gm = new GrantsManager({ registry: makeRegistry(dir) })
    expect(await gm.listAllGrants()).toEqual({
      'test.demo': { notify: 'granted' },
    })
  })

  it('effectivePermissionsFor returns all declared for builtins', async () => {
    const gm = new GrantsManager({
      registry: makeRegistry(dir, { origin: 'builtin' }),
    })
    const eff = await gm.effectivePermissionsFor('test.demo')
    expect(eff).toEqual(new Set(['storage', 'notify', 'ffmpeg']))
  })
})
