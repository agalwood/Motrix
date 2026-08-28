import { type NatEvent, type NatManagerDeps, NatState } from '@motrix/nat'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MotrixNatManager } from './motrix-nat-manager'

function makeHarness() {
  let engineReady = true
  let mappingSucceeds = true
  const readyListeners: Array<() => void> = []
  const offConfig = vi.fn()
  const offReady = vi.fn()
  const offNetwork = vi.fn()
  const setNetworkRoute = vi.fn()
  const events: NatEvent[] = []
  const pcpMap = vi.fn(async () =>
    mappingSucceeds
      ? { ok: true, value: { externalPort: 6881, ttl: 3600 } }
      : { ok: false }
  )
  const natPmpMap = vi.fn(async () =>
    mappingSucceeds ? { ok: true } : { ok: false }
  )
  const upnpMap = vi.fn(async () =>
    mappingSucceeds ? { ok: true } : { ok: false }
  )
  const networkMonitor = {
    start: vi.fn(),
    stop: vi.fn(),
    onChange: vi.fn(() => offNetwork),
    snapshot: vi.fn(() => ({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.20',
      hash: 'network-1',
    })),
  }
  const deps: NatManagerDeps = {
    hooks: {
      onReady: vi.fn((listener) => {
        readyListeners.push(listener)
        return offReady
      }),
      onConfigChanged: vi.fn(() => offConfig),
    },
    onEvent: (event) => events.push(event),
    settingsProvider: {
      getEngine: () => ({ listenPort: 6881, dhtListenPort: 6882 }),
      getNat: () => ({
        enabled: true,
        preferredProtocol: 'auto',
        mappingTtl: 3600,
        natTypeDetectionEnabled: false,
        stunServers: [],
        portReachabilityCheckEnabled: false,
        portCheckerEndpoints: [],
      }),
    },
    upnpClient: {
      discover: vi.fn(async () => ({
        ok: true,
        value: {
          gatewayIp: '192.168.1.1',
          controlUrl: '/upnp/control',
          controlHost: '192.168.1.1',
          controlPort: 1900,
          serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
          manufacturer: 'Router',
          modelName: 'Test',
        },
      })),
      mapPort: upnpMap,
      unmapPort: vi.fn(async () => ({ ok: true })),
      getExternalIp: vi.fn(async () => ({ ok: true, value: '203.0.113.1' })),
    },
    pmpPcpClient: {
      natPmpGetExternalIp: vi.fn(async () => ({ ok: false })),
      natPmpMap,
      pcpMap,
      setNetworkRoute,
      setGatewayIp: vi.fn(),
      close: vi.fn(async () => {}),
    },
    stunClient: {
      detectNatType: vi.fn(async () => ({ ok: false })),
    },
    portChecker: {
      checkPortReachable: vi.fn(async () => ({ ok: false })),
    },
    networkMonitor,
  }
  const manager = new MotrixNatManager(deps, () => engineReady)

  return {
    events,
    manager,
    networkMonitor,
    offConfig,
    offNetwork,
    offReady,
    pcpMap,
    readyListeners,
    setNetworkRoute,
    setEngineReady(value: boolean) {
      engineReady = value
    },
    setMappingSucceeds(value: boolean) {
      mappingSucceeds = value
    },
  }
}

describe('MotrixNatManager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps immediately after discovery when the engine is already ready', async () => {
    const harness = makeHarness()

    await harness.manager.start()

    expect(harness.manager.getStatus()).toMatchObject({
      state: NatState.Active,
      retryAttempt: 0,
    })
    expect(harness.manager.getStatus().activeMappings).toHaveLength(2)
    expect(harness.setNetworkRoute).toHaveBeenCalledWith({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.20',
    })
    expect(harness.pcpMap).toHaveBeenCalledTimes(2)
    await harness.manager.stop()
  })

  it('finishes an automatic retry by rebuilding mappings, not by staying Ready', async () => {
    vi.useFakeTimers()
    const harness = makeHarness()
    harness.setMappingSucceeds(false)

    await harness.manager.start()
    expect(harness.manager.getStatus()).toMatchObject({
      state: NatState.Failed,
      retryAttempt: 1,
    })

    harness.setMappingSucceeds(true)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(harness.manager.getStatus()).toMatchObject({
      state: NatState.Active,
      retryAttempt: 0,
    })
    expect(harness.manager.getStatus().activeMappings).toHaveLength(2)
    await harness.manager.stop()
  })

  it('cleans up failed-run subscriptions before a manual enable retry', async () => {
    const harness = makeHarness()
    harness.setMappingSucceeds(false)
    await harness.manager.start()
    expect(harness.manager.getStatus().state).toBe(NatState.Failed)

    harness.setMappingSucceeds(true)
    await harness.manager.enable()

    expect(harness.offConfig).toHaveBeenCalledOnce()
    expect(harness.offReady).toHaveBeenCalledOnce()
    expect(harness.offNetwork).toHaveBeenCalledOnce()
    expect(harness.networkMonitor.stop).toHaveBeenCalledOnce()
    expect(harness.manager.getStatus().state).toBe(NatState.Active)
    await harness.manager.stop()
  })
})
