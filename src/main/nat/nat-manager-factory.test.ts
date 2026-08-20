import { ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  networkInterfaces: vi.fn(),
  getLogger: vi.fn(),
  setNatLogger: vi.fn(),
  appLogger: {},
  snapshot: vi.fn(),
  udpFactory: vi.fn(),
  httpClient: { request: vi.fn() },
  natOptions: undefined as unknown,
  upnpOptions: undefined as unknown,
  pmpOptions: undefined as unknown,
  stunOptions: undefined as unknown,
  settingsManager: undefined as unknown,
  managerInstance: undefined as unknown,
  networkMonitorInstance: undefined as unknown,
  upnpInstance: undefined as unknown,
  pmpInstance: undefined as unknown,
  stunInstance: undefined as unknown,
  portCheckerInstance: undefined as unknown,
  settingsProviderInstance: undefined as unknown,
}))

vi.mock('node:os', () => ({
  default: { networkInterfaces: state.networkInterfaces },
  networkInterfaces: state.networkInterfaces,
}))

vi.mock('@core/logger', () => ({
  getLogger: state.getLogger,
}))

vi.mock('@motrix/nat', () => ({
  NatErrorCode: {
    DiscoveryFailed: 'NAT_DISCOVERY_FAILED',
    MappingFailed: 'NAT_MAPPING_FAILED',
    MappingConflict: 'NAT_MAPPING_CONFLICT',
    ProtocolRejected: 'NAT_PROTOCOL_REJECTED',
    ParseError: 'NAT_PARSE_ERROR',
    SecurityViolation: 'NAT_SECURITY_VIOLATION',
    Timeout: 'NAT_TIMEOUT',
    NetworkChanged: 'NAT_NETWORK_CHANGED',
    GatewayUnreachable: 'NAT_GATEWAY_UNREACHABLE',
    StunDetectionFailed: 'STUN_DETECTION_FAILED',
  },
  nodeHttpClient: state.httpClient,
  nodeUdpSocketFactory: state.udpFactory,
  setNatLogger: state.setNatLogger,
  UpnpClient: class UpnpClient {
    constructor(options: unknown) {
      state.upnpOptions = options
      state.upnpInstance = this
    }
  },
  PmpPcpClient: class PmpPcpClient {
    constructor(options: unknown) {
      state.pmpOptions = options
      state.pmpInstance = this
    }
  },
  StunClient: class StunClient {
    constructor(options: unknown) {
      state.stunOptions = options
      state.stunInstance = this
    }
  },
  NetworkMonitor: class NetworkMonitor {
    snapshot = state.snapshot

    constructor() {
      state.networkMonitorInstance = this
    }
  },
  PortChecker: class PortChecker {
    constructor() {
      state.portCheckerInstance = this
    }
  },
  NatManager: class NatManager {
    constructor(options: unknown) {
      state.natOptions = options
      state.managerInstance = this
    }
  },
}))

vi.mock('@core/nat/settings-nat-provider', () => ({
  SettingsNatProvider: class SettingsNatProvider {
    constructor(settingsManager: unknown) {
      state.settingsManager = settingsManager
      state.settingsProviderInstance = this
    }
  },
}))

import { createNatManager } from './nat-manager-factory'

interface CapturedNatOptions {
  hooks: {
    onReady(listener: () => void): () => void
    onConfigChanged(listener: () => void): () => void
  }
  onEvent(event: { type: string; [key: string]: unknown }): void
  settingsProvider: unknown
  upnpClient: unknown
  pmpPcpClient: unknown
  stunClient: unknown
  portChecker: unknown
  networkMonitor: unknown
}

describe('createNatManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.natOptions = undefined
    state.getLogger.mockReturnValue(state.appLogger)
    state.snapshot.mockReturnValue({ gatewayIp: '192.168.50.1' })
    state.networkInterfaces.mockReturnValue({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      en0: [{ family: 'IPv4', internal: false, address: '10.0.0.8' }],
    })
  })

  it('assembles the NAT stack with the detected gateway and client IP', () => {
    const eventBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
    const settingsManager = { getNat: vi.fn() }

    const result = createNatManager({
      eventBus: eventBus as never,
      settingsManager: settingsManager as never,
      isEngineReady: () => false,
    })
    const options = state.natOptions as CapturedNatOptions
    const pmpOptions = state.pmpOptions as {
      udpFactory: unknown
      gatewayIp: string
      clientIp: Buffer
    }

    expect(result).toEqual({
      manager: state.managerInstance,
      networkMonitor: state.networkMonitorInstance,
    })
    expect(state.getLogger).toHaveBeenCalledWith('nat')
    expect(state.setNatLogger).toHaveBeenCalledWith(state.appLogger)
    expect(state.upnpOptions).toEqual({
      udpFactory: state.udpFactory,
      http: state.httpClient,
    })
    expect(pmpOptions.gatewayIp).toBe('192.168.50.1')
    expect(pmpOptions.udpFactory).toBe(state.udpFactory)
    expect([...pmpOptions.clientIp]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 10, 0, 0, 8,
    ])
    expect(state.stunOptions).toEqual({ udpFactory: state.udpFactory })
    expect(options.settingsProvider).toBe(state.settingsProviderInstance)
    expect(options.upnpClient).toBe(state.upnpInstance)
    expect(options.pmpPcpClient).toBe(state.pmpInstance)
    expect(options.stunClient).toBe(state.stunInstance)
    expect(options.portChecker).toBe(state.portCheckerInstance)
    expect(options.networkMonitor).toBe(state.networkMonitorInstance)
    expect(state.settingsManager).toBe(settingsManager)
  })

  it('bridges lifecycle hooks and NAT events through the app EventBus', () => {
    const eventBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
    createNatManager({
      eventBus: eventBus as never,
      settingsManager: {} as never,
      isEngineReady: () => false,
    })
    const options = state.natOptions as CapturedNatOptions
    const onReady = vi.fn()
    const unsubscribeReady = options.hooks.onReady(onReady)
    const readyHandler = eventBus.on.mock.calls[0]?.[1] as (
      engineState: EngineState
    ) => void

    readyHandler(EngineState.Starting)
    readyHandler(EngineState.Ready)
    expect(onReady).toHaveBeenCalledOnce()
    unsubscribeReady()
    expect(eventBus.off).toHaveBeenCalledWith(
      Events.EngineStateChanged,
      readyHandler
    )

    const onConfigChanged = vi.fn()
    const unsubscribeSettings = options.hooks.onConfigChanged(onConfigChanged)
    expect(eventBus.on).toHaveBeenCalledWith(
      Events.SettingsChanged,
      onConfigChanged
    )
    unsubscribeSettings()
    expect(eventBus.off).toHaveBeenCalledWith(
      Events.SettingsChanged,
      onConfigChanged
    )

    const cases = [
      ['state-changed', 'state', Events.NatStateChanged],
      ['gateway-changed', 'info', Events.NatGatewayChanged],
      ['mapping-updated', 'mappings', Events.NatMappingUpdated],
      ['diagnostic-completed', 'result', Events.NatDiagnosticCompleted],
    ] as const
    for (const [type, key, event] of cases) {
      const payload = { type }
      options.onEvent({ type, [key]: payload })
      expect(eventBus.emit).toHaveBeenCalledWith(event, payload)
    }

    options.onEvent({
      type: 'error',
      error: { code: 'NAT_DISCOVERY_FAILED', message: 'not found' },
    })
    expect(eventBus.emit).toHaveBeenCalledWith(Events.NatError, {
      code: ErrorCode.NatDiscoveryFailed,
      message: 'not found',
    })

    options.onEvent({
      type: 'error',
      error: {
        code: 'NAT_SECURITY_WARNING',
        message: 'unauthenticated protocol',
      },
    })
    expect(eventBus.emit).toHaveBeenCalledWith(Events.NatError, {
      code: 'NAT_SECURITY_WARNING',
      message: 'unauthenticated protocol',
    })
    const callsBeforeUnknown = eventBus.emit.mock.calls.length
    options.onEvent({ type: 'unknown' })
    expect(eventBus.emit).toHaveBeenCalledTimes(callsBeforeUnknown)
  })

  it('falls back to loopback and the default gateway when discovery is empty', () => {
    state.networkInterfaces.mockReturnValue({})
    state.snapshot.mockReturnValue({ gatewayIp: null })

    createNatManager({
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
      settingsManager: {} as never,
      isEngineReady: () => false,
    })
    const pmpOptions = state.pmpOptions as {
      gatewayIp: string
      clientIp: Buffer
    }

    expect(pmpOptions.gatewayIp).toBe('192.168.1.1')
    expect([...pmpOptions.clientIp.slice(12)]).toEqual([127, 0, 0, 1])
  })
})
