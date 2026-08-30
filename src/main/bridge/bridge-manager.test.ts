import { describe, expect, it, vi } from 'vitest'
import { BridgeManager } from './bridge-manager'
import type { BridgeRuntime } from './index'

function makeRuntime(): BridgeRuntime {
  return {
    server: {} as unknown as BridgeRuntime['server'],
    pairing: {} as unknown as BridgeRuntime['pairing'],
    extensionPairings: {} as unknown as BridgeRuntime['extensionPairings'],
    registry: {} as unknown as BridgeRuntime['registry'],
    bus: {} as unknown as BridgeRuntime['bus'],
    installer: {
      unregister: vi.fn().mockResolvedValue(undefined),
    } as unknown as BridgeRuntime['installer'],
    endpointWriter: {} as unknown as BridgeRuntime['endpointWriter'],
    port: 16802,
    degraded: false,
    shutdown: vi.fn().mockResolvedValue(undefined),
    muxPipeline: undefined,
    getMediaSegmentGids: vi.fn().mockReturnValue([]),
    cancelMedia: vi.fn().mockResolvedValue(undefined),
    resolveToMux: vi.fn().mockResolvedValue(null),
  }
}

describe('BridgeManager', () => {
  it('start() calls factory and stores runtime', async () => {
    const runtime = makeRuntime()
    const factory = vi.fn().mockResolvedValue(runtime)
    const mgr = new BridgeManager(factory)
    await mgr.start()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(mgr.current).toBe(runtime)
  })

  it('start() is idempotent — second call is a no-op when already running', async () => {
    const factory = vi.fn().mockResolvedValue(makeRuntime())
    const mgr = new BridgeManager(factory)
    await mgr.start()
    await mgr.start()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('stop() calls runtime.shutdown() and clears current', async () => {
    const runtime = makeRuntime()
    const factory = vi.fn().mockResolvedValue(runtime)
    const mgr = new BridgeManager(factory)
    await mgr.start()
    await mgr.stop()
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.installer.unregister).not.toHaveBeenCalled()
    expect(mgr.current).toBeNull()
  })

  it('stop() is a no-op when nothing is running', async () => {
    const factory = vi.fn()
    const mgr = new BridgeManager(factory)
    await mgr.stop()
    expect(factory).not.toHaveBeenCalled()
  })

  it('setEnabled(true) starts when stopped, no-op when already running', async () => {
    const factory = vi.fn().mockResolvedValue(makeRuntime())
    const mgr = new BridgeManager(factory)
    await mgr.setEnabled(true)
    await mgr.setEnabled(true)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('setEnabled(false) stops when running, no-op when already stopped', async () => {
    const runtime = makeRuntime()
    const factory = vi.fn().mockResolvedValue(runtime)
    const mgr = new BridgeManager(factory)
    await mgr.setEnabled(true)
    await mgr.setEnabled(false)
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.installer.unregister).toHaveBeenCalledTimes(1)
    await mgr.setEnabled(false)
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.installer.unregister).toHaveBeenCalledTimes(1)
  })

  it('serializes disable behind an in-flight start', async () => {
    const runtime = makeRuntime()
    let resolveFactory: (runtime: BridgeRuntime) => void = () => {}
    const factoryResult = new Promise<BridgeRuntime>((resolve) => {
      resolveFactory = resolve
    })
    const factory = vi.fn(() => factoryResult)
    const mgr = new BridgeManager(factory)

    const starting = mgr.setEnabled(true)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    const stopping = mgr.setEnabled(false)
    resolveFactory(runtime)

    await Promise.all([starting, stopping])

    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.installer.unregister).toHaveBeenCalledTimes(1)
    expect(mgr.current).toBeNull()
  })

  it('retries unregister after a cleanup failure', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.installer.unregister).mockRejectedValueOnce(
      new Error('access denied')
    )
    const factory = vi.fn().mockResolvedValue(runtime)
    const mgr = new BridgeManager(factory)

    await mgr.start()
    await expect(mgr.setEnabled(false)).rejects.toThrow('access denied')
    await mgr.setEnabled(false)

    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.installer.unregister).toHaveBeenCalledTimes(2)
    expect(mgr.current).toBeNull()
  })

  it('can clean stale registration without a live runtime', async () => {
    const unregister = vi.fn().mockResolvedValue(undefined)
    const mgr = new BridgeManager(vi.fn(), unregister)

    await mgr.setEnabled(false)

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(mgr.current).toBeNull()
  })

  it('retries independent cleanup without a live runtime', async () => {
    const unregister = vi
      .fn()
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValue(undefined)
    const mgr = new BridgeManager(vi.fn(), unregister)

    await expect(mgr.setEnabled(false)).rejects.toThrow('access denied')
    await mgr.stop()

    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('cleans partial registration when start fails', async () => {
    const unregister = vi.fn().mockResolvedValue(undefined)
    const mgr = new BridgeManager(
      vi.fn().mockRejectedValue(new Error('start failed')),
      unregister
    )

    await expect(mgr.start()).rejects.toThrow('start failed')

    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('unregisters native messaging even when shutdown fails', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.shutdown).mockRejectedValueOnce(new Error('stop failed'))
    const factory = vi.fn().mockResolvedValue(runtime)
    const mgr = new BridgeManager(factory)

    await mgr.start()

    await expect(mgr.setEnabled(false)).rejects.toThrow('stop failed')
    expect(runtime.installer.unregister).toHaveBeenCalledTimes(1)
    expect(mgr.current).toBeNull()
  })

  it('start() returning null does not throw and leaves current null', async () => {
    const factory = vi.fn().mockResolvedValue(null)
    const mgr = new BridgeManager(factory)
    await mgr.start()
    expect(mgr.current).toBeNull()
  })

  describe('restart()', () => {
    it('is a no-op when the bridge is not running', async () => {
      const factory = vi.fn()
      const mgr = new BridgeManager(factory)

      await mgr.restart()

      expect(factory).not.toHaveBeenCalled()
      expect(mgr.current).toBeNull()
    })

    it('stops the current runtime and starts a fresh one', async () => {
      const first = makeRuntime()
      const second = makeRuntime()
      const factory = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
      const mgr = new BridgeManager(factory)
      await mgr.start()

      await mgr.restart()

      expect(first.shutdown).toHaveBeenCalledTimes(1)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(mgr.current).toBe(second)
    })

    it('keeps Native Messaging registered — does not unregister on restart', async () => {
      const first = makeRuntime()
      const second = makeRuntime()
      const factory = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
      const mgr = new BridgeManager(factory)
      await mgr.start()

      await mgr.restart()

      expect(first.installer.unregister).not.toHaveBeenCalled()
      expect(second.installer.unregister).not.toHaveBeenCalled()
    })

    it('serializes as one transition behind a concurrent setEnabled(false)', async () => {
      const first = makeRuntime()
      const second = makeRuntime()
      let resolveSecondFactory: (runtime: BridgeRuntime) => void = () => {}
      const secondFactoryResult = new Promise<BridgeRuntime>((resolve) => {
        resolveSecondFactory = resolve
      })
      const factory = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(() => secondFactoryResult)
      const mgr = new BridgeManager(factory)
      await mgr.start()

      const restarting = mgr.restart()
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      const disabling = mgr.setEnabled(false)
      resolveSecondFactory(second)

      await Promise.all([restarting, disabling])

      // The disable that arrived after restart() was enqueued must win —
      // never leave the bridge running after the user disabled it.
      expect(second.shutdown).toHaveBeenCalledTimes(1)
      expect(mgr.current).toBeNull()
    })

    it('no-ops when the bridge was stopped by a concurrent disable', async () => {
      const first = makeRuntime()
      let resolveStop: () => void = () => {}
      const stopGate = new Promise<void>((resolve) => {
        resolveStop = resolve
      })
      vi.mocked(first.shutdown).mockImplementationOnce(() => stopGate)
      const factory = vi.fn().mockResolvedValueOnce(first)
      const mgr = new BridgeManager(factory)
      await mgr.start()

      const disabling = mgr.setEnabled(false)
      const restarting = mgr.restart()
      resolveStop()

      await Promise.all([disabling, restarting])

      expect(factory).toHaveBeenCalledTimes(1)
      expect(mgr.current).toBeNull()
    })
  })
})
