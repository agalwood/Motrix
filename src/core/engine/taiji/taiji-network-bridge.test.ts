import { EventBus } from '@core/events/event-bus'
import type { NetworkFingerprint } from '@core/network/network-fingerprint'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaijiNetworkBridge } from './taiji-network-bridge'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const bridges: TaijiNetworkBridge[] = []
function fixture(initiallyReady = true) {
  let ready = initiallyReady
  let key = 'network-a'
  let now = 1000
  const eventBus = new EventBus()
  const rpc = { notifyNetworkChange: vi.fn(async () => 'OK' as const) }
  const read = vi.fn(
    async (_signal: AbortSignal): Promise<NetworkFingerprint> => ({
      key,
      unavailable: [],
    })
  )
  const bridge = new TaijiNetworkBridge({
    rpc,
    eventBus,
    isEngineReady: () => ready,
    read,
    now: () => now,
  })
  bridges.push(bridge)
  return {
    bridge,
    rpc,
    read,
    eventBus,
    setKey: (next: string) => {
      key = next
    },
    setNow: (next: number) => {
      now = next
    },
    setReady: (next: boolean) => {
      ready = next
      eventBus.emit(
        Events.EngineStateChanged,
        next ? EngineState.Ready : EngineState.Stopped
      )
    },
  }
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  vi.useRealTimers()
})

describe('taiji network context bridge', () => {
  it('notifies once on readiness and only again when configuration changes', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.bridge.start()
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(1)
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(1)
    h.setKey('same-interface-new-dns')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
  })

  it('refreshes on wake even if the configuration fingerprint is identical', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.bridge.start()
    await h.bridge.refresh()
    h.bridge.notifyWake()
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
    h.setNow(100_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(3)
  })

  it('retries a failed notification without spinning or acknowledging it', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.rpc.notifyNetworkChange.mockRejectedValueOnce(new Error('disconnected'))
    h.bridge.start()
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(1)
    expect(h.read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
  })

  it('does not use a late snapshot from before wake', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.bridge.start()
    await h.bridge.refresh()
    const old = deferred<NetworkFingerprint>()
    h.read.mockImplementationOnce(() => old.promise)
    const pending = h.bridge.refresh()
    h.setKey('network-after-wake')
    h.bridge.notifyWake()
    old.resolve({ key: 'obsolete-network', unavailable: [] })
    await pending
    await h.bridge.refresh()
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
  })

  it('does not let the previous engine acknowledge the new engine context', async () => {
    vi.useFakeTimers()
    const h = fixture(false)
    const old = deferred<'OK'>()
    const started = deferred<void>()
    h.rpc.notifyNetworkChange.mockImplementationOnce(() => {
      started.resolve()
      return old.promise
    })
    h.bridge.start()
    h.setReady(true)
    const pending = h.bridge.refresh()
    await started.promise
    h.setReady(false)
    h.setReady(true)
    old.resolve('OK')
    await pending
    expect(h.rpc.notifyNetworkChange).toHaveBeenCalledTimes(2)
    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it('aborts observation and unsubscribes before shutdown completes', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const started = deferred<AbortSignal>()
    h.read.mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
          started.resolve(signal)
        })
    )
    h.bridge.start()
    const signal = await started.promise
    await h.bridge.stop()
    expect(signal.aborted).toBe(true)
    h.setReady(false)
    h.setReady(true)
    h.bridge.notifyWake()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.rpc.notifyNetworkChange).not.toHaveBeenCalled()
  })
})
