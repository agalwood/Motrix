import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { PluginInstaller } from '@core/plugin/install/plugin-installer'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { migrate } from '@core/session/migrations'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerCommunityPluginPolicy } from './community-policy'
import { ServerPluginInstallService } from './install-service'

const fixture = path.resolve(
  'tests/fixtures/moext/test.demo-config-1.0.0.moext'
)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function capabilityHost(): CapabilityHost {
  return {
    lifecycle: { runDeactivate: async () => undefined },
    storage: { deleteAll: async () => undefined },
    metadata: { deleteAllForPlugin: async () => undefined },
    cookieJarFor: () => ({ clear: () => undefined }),
  } as unknown as CapabilityHost
}

const runtimeHost = {
  deactivate: async () => undefined,
  isQuiescent: () => true,
}

describe('Server plugin install lifecycle integration', () => {
  it('installs, persists enablement across rediscovery, and uninstalls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-server-plugin-e2e-'))
    cleanup.push(root)
    const pluginsDir = path.join(root, 'plugins')
    const builtinDir = path.join(root, 'builtins')
    await Promise.all([mkdir(pluginsDir), mkdir(builtinDir)])
    const database = new Database(path.join(root, 'motrix.db'))
    migrate(database)
    const stateStore = new PluginStateStore(database)
    const policy = createServerCommunityPluginPolicy({
      allowUnmanagedPlugins: false,
    })
    const registry = new PluginRegistry({
      pluginsDir,
      builtinDir,
      stateStore,
      hostVersion: '2.0.0',
      communityDirectoryPolicy: policy,
    })
    await registry.discover()
    const installer = new PluginInstaller({
      pluginsDir,
      registry,
      stateStore,
      capabilityHost: capabilityHost(),
      hostVersion: '2.0.0',
    })
    const service = new ServerPluginInstallService({
      installer,
      registryClient: {} as never,
      hostVersion: '2.0.0',
      pluginsDir,
      allowedLocalRoots: [path.dirname(fixture)],
    })
    const fileHash = createHash('sha256')
      .update(await readFile(fixture))
      .digest('hex')

    const staged = await service.stage(
      {
        sourceType: 'local',
        absPath: fixture,
        fileHash,
      },
      runtimeHost
    )
    expect(staged.committed).toBe(false)
    await installer.commit(staged.stagingId, { notify: 'denied' }, runtimeHost)
    expect(
      existsSync(path.join(pluginsDir, 'test.demo-config', '_install.json'))
    ).toBe(true)
    expect(registry.get('test.demo-config')?.state.enabled).toBe(true)

    stateStore.setEnabled('test.demo-config', false)
    const restartedRegistry = new PluginRegistry({
      pluginsDir,
      builtinDir,
      stateStore: new PluginStateStore(database),
      hostVersion: '2.0.0',
      communityDirectoryPolicy: policy,
    })
    await restartedRegistry.discover()
    expect(restartedRegistry.get('test.demo-config')?.state.enabled).toBe(false)

    const restartedInstaller = new PluginInstaller({
      pluginsDir,
      registry: restartedRegistry,
      stateStore: new PluginStateStore(database),
      capabilityHost: capabilityHost(),
      hostVersion: '2.0.0',
    })
    await restartedInstaller.uninstall('test.demo-config', runtimeHost)
    expect(restartedRegistry.get('test.demo-config')).toBeUndefined()
    expect(existsSync(path.join(pluginsDir, 'test.demo-config'))).toBe(false)
    database.close()
  })
})
