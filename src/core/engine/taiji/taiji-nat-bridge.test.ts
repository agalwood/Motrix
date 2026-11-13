import { EventBus } from '@core/events/event-bus'
import type { SettingsManager } from '@core/settings/settings-manager'
import { type NatManager, NatProtocol } from '@motrix/nat'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaijiNatBridge } from './taiji-nat-bridge'

function harness() {
  let enabled = true
  let ready = true
  let listeners = [
    {
      id: '0000000000000001-0000000000000001',
      gid: '0000000000000001',
      port: 40000,
      hostManaged: true,
    },
  ]
  const eventBus = new EventBus()
  const managers = new Map<number, ReturnType<typeof manager>>()
  function manager(port: number) {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({
        activeMappings: [
          {
            internalPort: port,
            externalPort: port + 100,
            protocol: 'TCP' as const,
            purpose: 'bt-listen' as const,
            method: NatProtocol.NatPmp,
            ttl: 120,
            expiresAt: Date.now() + 10000,
            createdAt: Date.now(),
            lastRenewedAt: Date.now(),
          },
          {
            internalPort: port,
            externalPort: port + 101,
            protocol: 'UDP' as const,
            purpose: 'dht-listen' as const,
            method: NatProtocol.NatPmp,
            ttl: 120,
            expiresAt: Date.now() + 10000,
            createdAt: Date.now(),
            lastRenewedAt: Date.now(),
          },
        ],
      })),
    }
  }
  const rpc = {
    getGlobalOption: vi.fn(
      async (): Promise<Record<string, string>> => ({
        'motrix-peer-listeners': JSON.stringify(listeners),
      })
    ),
    changeGlobalOption: vi.fn(
      async (_options: Record<string, string>) => 'OK' as const
    ),
  }
  const settingsManager = {
    get: () => ({ nat: { enabled } }),
    getEngine: () => ({ listenPort: 40000 }),
  } as unknown as SettingsManager
  const primary = manager(40000)
  const bridge = new TaijiNatBridge({
    rpc,
    settingsManager,
    eventBus,
    primary: primary as unknown as NatManager,
    isEngineReady: () => ready,
    createManager: (port) => {
      const m = manager(port)
      managers.set(port, m)
      return m as unknown as NatManager
    },
  })
  return {
    bridge,
    rpc,
    managers,
    primary,
    eventBus,
    setEnabled: (v: boolean) => {
      enabled = v
    },
    setReady: (v: boolean) => {
      ready = v
    },
    setListeners: (v: typeof listeners) => {
      listeners = v
    },
    listeners,
    sent: () =>
      JSON.parse(
        rpc.changeGlobalOption.mock.lastCall?.[0]?.['motrix-peer-mappings'] ??
          '[]'
      ),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('taiji peer socket NAT bridge', () => {
  it('reuses the primary lease and maps concurrent actual listener ports, then expires unused leases', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setListeners([
      ...h.listeners,
      {
        ...h.listeners[0],
        id: '0000000000000002-0000000000000001',
        port: 40001,
      },
    ])
    h.bridge.start()
    await h.bridge.refresh()
    expect(h.primary.start).not.toHaveBeenCalled()
    expect(h.managers.size).toBe(1)
    expect(
      h.sent().map((m: { tcp: number; udp: number }) => [m.tcp, m.udp])
    ).toEqual([
      [40100, 40101],
      [40101, 40102],
    ])
    h.setListeners(h.listeners)
    await h.bridge.refresh()
    expect(h.managers.get(40001)?.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.managers.get(40001)?.stop).toHaveBeenCalledOnce()
    await h.bridge.stop()
    expect(h.primary.stop).not.toHaveBeenCalled()
  })

  it('reissues the same mapping for a new socket generation and clears it when disabled', async () => {
    const h = harness()
    h.bridge.start()
    await h.bridge.refresh()
    h.setListeners([
      { ...h.listeners[0], id: '0000000000000001-0000000000000002' },
    ])
    await h.bridge.refresh()
    expect(h.sent()[0].id).toBe('0000000000000001-0000000000000002')
    h.setEnabled(false)
    await h.bridge.refresh()
    expect(h.sent()[0]).toMatchObject({ tcp: null, udp: null })
    await h.bridge.stop()
  })

  it('does not send expired mappings or overwrite a restarted engine with an old RPC result', async () => {
    const h = harness()
    const status = h.primary.getStatus()
    status.activeMappings.forEach((m) => {
      m.expiresAt = Date.now() - 1000
    })
    h.primary.getStatus.mockReturnValue(status)
    h.bridge.start()
    await h.bridge.refresh()
    expect(h.sent()[0]).toMatchObject({ tcp: null, udp: null })
    let resolve!: (value: Record<string, string>) => void
    h.rpc.getGlobalOption.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = h.bridge.refresh()
    h.setReady(false)
    h.eventBus.emit(Events.EngineStateChanged, EngineState.Stopped)
    const count = h.rpc.changeGlobalOption.mock.calls.length
    resolve({
      'motrix-peer-listeners': JSON.stringify([
        { ...h.listeners[0], port: 41000 },
      ]),
    })
    await pending
    expect(h.rpc.changeGlobalOption).toHaveBeenCalledTimes(count)
    expect(h.managers.size).toBe(0)
    await h.bridge.stop()
  })

  it('waits for an owned mapping start before unmapping on shutdown', async () => {
    const h = harness()
    h.setListeners([{ ...h.listeners[0], port: 40001 }])
    h.bridge.start()
    await h.bridge.refresh()
    const own = h.managers.get(40001)
    await h.bridge.stop()
    expect(own?.stop).toHaveBeenCalledOnce()
    expect(h.primary.stop).not.toHaveBeenCalled()
  })
})
