import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginManifest } from '@shared/types/plugin'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandsCapabilityHost } from '../capabilities/commands'
import type { PluginHost } from '../host/plugin-host'
import type { IndexedPlugin, PluginRegistry } from '../plugin-registry'
import { wireCommandSystem } from './wire'

function makeManifest(
  over: Omit<Partial<PluginManifest>, 'id'> & { id: string }
): PluginManifest {
  return {
    manifestVersion: 1,
    name: over.id,
    version: '1.0.0',
    description: 'd',
    categories: ['integration'],
    engines: { motrix: '>=2.0.0' },
    main: 'dist/plugin.js',
    permissions: [],
    activationEvents: ['onStartup'],
    contributes: {},
    ...over,
  } as PluginManifest
}

function makeRegistry(
  entries: Array<{
    id: string
    enabled?: boolean
    invokesCommands?: string[]
    commands?: Array<{
      id: string
      title: string
      public?: boolean
      argsSchema?: unknown
      resultSchema?: unknown
    }>
  }>
): PluginRegistry {
  const map = new Map<string, IndexedPlugin>()
  for (const e of entries) {
    const m = makeManifest({
      id: e.id,
      invokesCommands: e.invokesCommands,
      contributes: { commands: e.commands },
    })
    map.set(e.id, {
      manifestRaw: m,
      manifest: m,
      origin: 'community',
      rootDir: `/tmp/${e.id}`,
      state: {
        pluginId: e.id,
        enabled: e.enabled ?? true,
        status: 'inactive',
        errorCount: 0,
        installedAt: 0,
      },
    })
  }
  return {
    get: (id: string) => map.get(id),
    list: () =>
      [...map.values()].map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        status: p.state.status,
        enabled: p.state.enabled,
        permissions: p.manifest.permissions,
        optionalPermissions: [],
        errorCount: 0,
      })),
  } as unknown as PluginRegistry
}

function makeHost(opts: {
  active: Set<string>
  onInvoke: (
    pluginId: string,
    commandId: string,
    args: unknown
  ) => Promise<unknown>
}): PluginHost {
  return {
    isActive: (id: string) => opts.active.has(id),
    activate: async (id: string) => {
      opts.active.add(id)
    },
    invokeCommand: opts.onInvoke,
  } as unknown as PluginHost
}

describe('wireCommandSystem', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'wire-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('binds an invoker that enforces declared invokesCommands', async () => {
    const registry = makeRegistry([
      {
        id: 'pub.a',
        invokesCommands: [],
      },
      {
        id: 'pub.b',
        commands: [
          {
            id: 'pub.b.run',
            title: 'run',
            public: true,
            argsSchema: { type: 'object' },
            resultSchema: { type: 'object' },
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['pub.b']),
      onInvoke: async () => ({}),
    })
    const capabilityHost = { commands: new CommandsCapabilityHost() }
    const sys = wireCommandSystem({
      registry,
      host,
      capabilityHost,
      pluginsDir: tmp,
    })

    await expect(
      capabilityHost.commands.execute('pub.a', 'pub.b.run', {})
    ).rejects.toMatchObject({ message: 'plugin.command.access_denied' })

    await sys.audit.drain()
    const log = await readFile(
      path.join(tmp, '_audit', 'command-invokes.ndjson'),
      'utf8'
    )
    expect(log).toContain('access_denied')
  })

  it('propagates a synthetic chain id so nested calls accumulate depth', async () => {
    const invocations: string[] = []
    let depthSnapshot = 0
    const registry = makeRegistry([
      {
        id: 'pub.a',
        invokesCommands: ['pub.b.run'],
        commands: [
          {
            id: 'pub.a.run',
            title: 'run',
            public: true,
            argsSchema: { type: 'object' },
            resultSchema: { type: 'object' },
          },
        ],
      },
      {
        id: 'pub.b',
        invokesCommands: ['pub.c.run'],
        commands: [
          {
            id: 'pub.b.run',
            title: 'run',
            public: true,
            argsSchema: { type: 'object' },
            resultSchema: { type: 'object' },
          },
        ],
      },
      {
        id: 'pub.c',
        invokesCommands: [],
        commands: [
          {
            id: 'pub.c.run',
            title: 'run',
            public: true,
            argsSchema: { type: 'object' },
            resultSchema: { type: 'object' },
          },
        ],
      },
    ])
    const capabilityHost = { commands: new CommandsCapabilityHost() }
    const host = makeHost({
      active: new Set(['pub.a', 'pub.b', 'pub.c']),
      onInvoke: async (_pluginId, commandId, args) => {
        invocations.push(commandId)
        if (commandId === 'pub.b.run') {
          return capabilityHost.commands.execute('pub.b', 'pub.c.run', args)
        }
        if (commandId === 'pub.c.run') {
          // A→B is hop 1, B→C is hop 2. Without ALS propagation each call
          // would generate its own synthetic taskId, capping every measurement
          // at 1 (the local enter for that call). Confirming 2 here proves
          // the synthetic taskId persisted across the two cross-plugin hops.
          depthSnapshot = sys.depth.current(sys.taskIdStore.getStore() ?? '')
          return { ok: true }
        }
        return null
      },
    })
    const sys = wireCommandSystem({
      registry,
      host,
      capabilityHost,
      pluginsDir: tmp,
    })

    const r = await capabilityHost.commands.execute('pub.a', 'pub.b.run', {})
    expect(r).toEqual({ ok: true })
    expect(invocations).toEqual(['pub.b.run', 'pub.c.run'])
    expect(depthSnapshot).toBe(2)
  })

  it('refreshSchemas re-installs validators after registry change', async () => {
    const registry = makeRegistry([
      {
        id: 'pub.x',
        commands: [
          {
            id: 'pub.x.run',
            title: 'run',
            public: true,
            argsSchema: {
              type: 'object',
              properties: { n: { type: 'number' } },
              required: ['n'],
            },
            resultSchema: { type: 'object' },
          },
        ],
      },
    ])
    const capabilityHost = { commands: new CommandsCapabilityHost() }
    const host = makeHost({
      active: new Set(['pub.x']),
      onInvoke: async () => ({}),
    })
    const sys = wireCommandSystem({
      registry,
      host,
      capabilityHost,
      pluginsDir: tmp,
    })
    // After wire, schema for pub.x.run is compiled.
    expect(() =>
      sys.schemas.validateArgs('pub.x', 'pub.x.run', { n: 1 })
    ).not.toThrow()
    expect(() => sys.schemas.validateArgs('pub.x', 'pub.x.run', {})).toThrow(
      /args_invalid/
    )
  })

  it('onPluginRemoved clears schemas + throttle for that plugin', async () => {
    const registry = makeRegistry([
      {
        id: 'pub.y',
        commands: [
          {
            id: 'pub.y.run',
            title: 'run',
            public: true,
            argsSchema: { type: 'object' },
            resultSchema: { type: 'object' },
          },
        ],
      },
    ])
    const capabilityHost = { commands: new CommandsCapabilityHost() }
    const sys = wireCommandSystem({
      registry,
      host: makeHost({ active: new Set(), onInvoke: async () => null }),
      capabilityHost,
      pluginsDir: tmp,
    })
    // Trip the throttle for pub.y
    for (let i = 0; i < 10; i++) sys.throttle.recordInvalid('pub.y')
    expect(sys.throttle.isBlocked('pub.y')).toBe(true)
    sys.onPluginRemoved('pub.y')
    expect(sys.throttle.isBlocked('pub.y')).toBe(false)
    // Schema cache should also be cleared for pub.y
    expect(() => sys.schemas.validateArgs('pub.y', 'pub.y.run', {})).toThrow(
      /not_public/
    )
  })
})
