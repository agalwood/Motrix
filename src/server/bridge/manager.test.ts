import { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceUnavailableError } from '../http/service-unavailable-error'
import type { ServerBridgeRuntime } from './bootstrap'
import { ServerBridgeManager } from './manager'

function makeRegistry() {
  let content: string | null = null
  return new TrustedExtensionRegistry(
    {
      read: vi.fn(async () => content),
      write: vi.fn(async (next: string) => {
        content = next
      }),
    },
    []
  )
}

function makeRuntime(): ServerBridgeRuntime {
  return {
    cancelMedia: vi.fn(async () => {}),
    getMediaSegmentGids: vi.fn(() => []),
    server: {} as ServerBridgeRuntime['server'],
    port: 16801,
    localToken: 'token',
    bridgeCommandHandlers: {
      [BridgeCommands.ResolvePair]: vi.fn(async () => ({ ok: true })),
      [BridgeCommands.RevokePair]: vi.fn(async () => undefined),
    },
    bridgeQueryHandlers: {
      [BridgeQueries.ListPaired]: vi.fn(async () => ['paired']),
      [BridgeQueries.GetStatus]: vi.fn(async () => ({ port: 16801 })),
    },
    shutdown: vi.fn(async () => undefined),
  }
}

describe('ServerBridgeManager', () => {
  let registry: TrustedExtensionRegistry

  beforeEach(async () => {
    registry = makeRegistry()
    await registry.load()
  })

  it('keeps media cancellation reachable while a disabled bridge is draining', async () => {
    const runtime = makeRuntime()
    let release!: () => void
    const drain = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(runtime.shutdown).mockReturnValue(drain)
    const manager = new ServerBridgeManager(registry, async () => runtime)
    await manager.start()
    await manager.cancelMedia('active')
    expect(runtime.cancelMedia).toHaveBeenCalledWith('active')
    const stopping = manager.stop()
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledOnce())
    expect(manager.current).toBeNull()
    await manager.cancelMedia('removing')
    expect(runtime.cancelMedia).toHaveBeenCalledWith('removing')
    release()
    await stopping
    await manager.cancelMedia('already-stopped')
    expect(runtime.cancelMedia).toHaveBeenCalledTimes(2)
  })

  it('keeps trusted-extension management available while disabled', async () => {
    const manager = new ServerBridgeManager(registry, vi.fn())

    await manager.bridgeCommandHandlers[BridgeCommands.AddTrusted]?.({
      id: 'abcdefghijklmnopabcdefghijklmnop',
      browser: 'chromium',
      label: 'Local test',
    })

    await expect(
      manager.bridgeQueryHandlers[BridgeQueries.ListTrusted]?.()
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'abcdefghijklmnopabcdefghijklmnop',
        browser: 'chromium',
        source: 'user-added',
      }),
    ])
  })

  it('keeps registry RPC unavailable until process ownership is established', async () => {
    let ready = false
    const manager = new ServerBridgeManager(registry, vi.fn(), () => ready)

    await expect(
      manager.bridgeQueryHandlers[BridgeQueries.ListTrusted]?.()
    ).rejects.toBeInstanceOf(ServiceUnavailableError)

    ready = true
    await expect(
      manager.bridgeQueryHandlers[BridgeQueries.ListTrusted]?.()
    ).resolves.toEqual([])
  })

  it('returns a typed unavailable failure instead of dropping channels', async () => {
    const manager = new ServerBridgeManager(registry, vi.fn())

    await expect(
      manager.bridgeQueryHandlers[BridgeQueries.ListPaired]?.()
    ).rejects.toBeInstanceOf(ServiceUnavailableError)
    expect(Object.keys(manager.bridgeCommandHandlers).sort()).toEqual(
      Object.values(BridgeCommands).sort()
    )
    expect(Object.keys(manager.bridgeQueryHandlers).sort()).toEqual(
      Object.values(BridgeQueries).sort()
    )
  })

  it('waits for an enabled bridge that is still starting', async () => {
    const runtime = makeRuntime()
    let release!: (runtime: ServerBridgeRuntime) => void
    const starting = new Promise<ServerBridgeRuntime>((resolve) => {
      release = resolve
    })
    const manager = new ServerBridgeManager(registry, () => starting)

    const start = manager.start()
    const query = manager.bridgeQueryHandlers[BridgeQueries.ListPaired]?.()
    release(runtime)

    await expect(query).resolves.toEqual(['paired'])
    await start
  })

  it('retries a failed enabled start on restart', async () => {
    const runtime = makeRuntime()
    const factory = vi
      .fn<() => Promise<ServerBridgeRuntime>>()
      .mockRejectedValueOnce(new Error('port occupied'))
      .mockResolvedValueOnce(runtime)
    const manager = new ServerBridgeManager(registry, factory)

    await expect(manager.start()).rejects.toThrow('port occupied')
    await manager.restart()

    expect(manager.current).toBe(runtime)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('serializes disable behind an in-flight start', async () => {
    const runtime = makeRuntime()
    let release!: (runtime: ServerBridgeRuntime) => void
    const manager = new ServerBridgeManager(
      registry,
      () =>
        new Promise<ServerBridgeRuntime>((resolve) => {
          release = resolve
        })
    )

    const start = manager.start()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const stop = manager.stop()
    release(runtime)
    await Promise.all([start, stop])

    expect(runtime.shutdown).toHaveBeenCalledOnce()
    expect(manager.current).toBeNull()
  })
})
