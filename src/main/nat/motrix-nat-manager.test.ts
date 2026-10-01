import {
  type HttpRequestInput,
  type NatEvent,
  type NatManagerDeps,
  NatPortReachability,
  NatState,
  NatType,
  type UdpMessageListener,
  UpnpClient,
} from '@motrix/nat'
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
    deps,
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

describe('Published UPnP dependency regression', () => {
  it('maps and removes TCP/UDP ports for a Huawei AX3 with a Chinese friendly name', async () => {
    const { manager, deps, setMappingSucceeds } = makeHarness()
    // This router exposes UPnP only; PCP and NAT-PMP must not mask failures.
    setMappingSucceeds(false)
    const service = 'urn:schemas-upnp-org:service:WANIPConnection:1'
    const description = `<?xml version="1.0" encoding="UTF-8"?>
      <root xmlns="urn:schemas-upnp-org:device-1-0"><device>
        <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
        <friendlyName>华为路由AX3</friendlyName>
        <manufacturer>Huawei Technologies Co., Ltd.</manufacturer>
        <modelName>WS7100-15</modelName>
        <serviceList><service><serviceType>${service}</serviceType>
          <controlURL>/upnp/control/WANIPConn1</controlURL>
        </service></serviceList>
      </device></root>`
    const listeners = new Set<UdpMessageListener>()
    const socket = {
      bind: vi.fn(async () => {}),
      addMembership: vi.fn(),
      setMulticastTTL: vi.fn(),
      setMulticastInterface: vi.fn(),
      send: vi.fn(async () => {
        const response = Buffer.from(
          'HTTP/1.1 200 OK\r\n' +
            'LOCATION: http://192.168.1.1:37215/upnpdev.xml\r\n' +
            'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
            'SERVER: Linux UPnP/1.0 Huawei-ATP-IGD\r\n' +
            'USN: uuid:ax3::urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
            'HILINK_EXT: 0\r\n\r\n'
        )
        for (const listener of listeners) {
          listener(response, {
            address: '192.168.1.1',
            port: 1900,
            size: response.length,
          })
        }
      }),
      onMessage: (listener: UdpMessageListener) => listeners.add(listener),
      offMessage: (listener: UdpMessageListener) => listeners.delete(listener),
      close: vi.fn(async () => {
        listeners.clear()
      }),
      address: () => ({ address: '192.168.1.20', port: 12345 }),
    }
    const request = vi.fn(async (input: HttpRequestInput) => {
      const action = input.headers?.SOAPAction?.split('#')[1]?.replaceAll(
        '"',
        ''
      )
      return {
        ok: true as const,
        value: {
          statusCode: 200,
          headers: {},
          body:
            input.method === 'GET'
              ? description
              : `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
              <s:Body><u:${action}Response xmlns:u="${service}"/></s:Body>
            </s:Envelope>`,
        },
      }
    })
    deps.upnpClient = new UpnpClient({
      udpFactory: () => socket,
      http: { request },
    })
    deps.settingsProvider.getEngine = () => ({
      listenPort: 6881,
      dhtListenPort: 6881,
    })
    try {
      await manager.start()
      expect(manager.getStatus()).toMatchObject({
        state: NatState.Active,
        gatewayInfo: {
          manufacturer: 'Huawei Technologies Co., Ltd.',
          modelName: 'WS7100-15',
        },
      })
      expect(manager.getStatus().activeMappings).toHaveLength(2)
      const additions = request.mock.calls
        .map(([input]) => input)
        .filter((input) =>
          input.headers?.SOAPAction?.includes('#AddPortMapping')
        )
      expect(additions).toHaveLength(2)
      for (const protocol of ['TCP', 'UDP']) {
        expect(
          additions.some((input) =>
            input.body?.includes(`<NewProtocol>${protocol}</NewProtocol>`)
          )
        ).toBe(true)
      }
      expect(
        additions.every((input) =>
          input.body?.includes('<NewInternalPort>6881</NewInternalPort>')
        )
      ).toBe(true)
    } finally {
      await manager.stop()
    }
    const removals = request.mock.calls
      .map(([input]) => input)
      .filter((input) =>
        input.headers?.SOAPAction?.includes('#DeletePortMapping')
      )
    expect(removals).toHaveLength(2)
    for (const protocol of ['TCP', 'UDP']) {
      expect(
        removals.some((input) =>
          input.body?.includes(`<NewProtocol>${protocol}</NewProtocol>`)
        )
      ).toBe(true)
    }
    expect(socket.close).toHaveBeenCalled()
  })
})

describe('Saved network diagnostic preferences', () => {
  it('makes no outbound checks when both switches are disabled', async () => {
    const { manager, deps } = makeHarness()
    await manager.runDiagnostic()
    expect(deps.stunClient.detectNatType).not.toHaveBeenCalled()
    expect(deps.portChecker.checkPortReachable).not.toHaveBeenCalled()
  })
  it('checks the configured incoming port and does not reuse its TCP result for DHT', async () => {
    const { manager, deps } = makeHarness()
    const nat = deps.settingsProvider.getNat()
    deps.settingsProvider.getNat = () => ({
      ...nat,
      natTypeDetectionEnabled: true,
      stunServers: ['stun.example.com:3478'],
      portReachabilityCheckEnabled: true,
      portCheckerEndpoints: ['https://check.example.com'],
    })
    vi.mocked(deps.stunClient.detectNatType).mockResolvedValue({
      ok: true,
      value: { mappedIp: '203.0.113.2', mappedPort: 40000 },
    })
    vi.mocked(deps.portChecker.checkPortReachable).mockResolvedValue({
      ok: true,
      value: { reachable: true },
    })
    await manager.runDiagnostic()
    expect(deps.portChecker.checkPortReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        externalIp: '203.0.113.2',
        port: 6881,
        endpoints: ['https://check.example.com'],
      })
    )
    expect(manager.getStatus().lastDiagnostic).toMatchObject({
      natType: NatType.Unknown,
      portReachability: {
        btListenPort: NatPortReachability.Reachable,
        dhtListenPort: NatPortReachability.Unknown,
      },
    })
  })
  it('does not submit a port check with an unknown external address', async () => {
    const { manager, deps } = makeHarness()
    const nat = deps.settingsProvider.getNat()
    deps.settingsProvider.getNat = () => ({
      ...nat,
      portReachabilityCheckEnabled: true,
      portCheckerEndpoints: ['https://check.example.com'],
    })
    await manager.runDiagnostic()
    expect(deps.portChecker.checkPortReachable).not.toHaveBeenCalled()
    expect(
      manager.getStatus().lastDiagnostic?.portReachability.btListenPort
    ).toBe(NatPortReachability.Unknown)
  })
  it('does not publish a diagnostic aborted during STUN detection', async () => {
    const { manager, deps, events } = makeHarness()
    const nat = deps.settingsProvider.getNat()
    deps.settingsProvider.getNat = () => ({
      ...nat,
      natTypeDetectionEnabled: true,
      stunServers: ['stun.example.com:3478'],
    })
    const controller = new AbortController()
    vi.mocked(deps.stunClient.detectNatType).mockImplementation(async () => {
      controller.abort()
      return { ok: false }
    })
    await manager.runDiagnostic(controller.signal)
    expect(
      events.filter((event) => event.type === 'diagnostic-completed')
    ).toHaveLength(0)
  })
})
