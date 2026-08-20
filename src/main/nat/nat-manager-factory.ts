import { networkInterfaces } from 'node:os'
import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import { SettingsNatProvider } from '@core/nat/settings-nat-provider'
import type { SettingsManager } from '@core/settings/settings-manager'
import {
  NatErrorCode,
  type NatEvent,
  type NatManager,
  type NatManagerHooks,
  NetworkMonitor,
  nodeHttpClient,
  nodeUdpSocketFactory,
  PmpPcpClient,
  PortChecker,
  StunClient,
  setNatLogger,
  UpnpClient,
} from '@motrix/nat'
import { ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { MotrixNatManager } from './motrix-nat-manager'

const NAT_ERROR_CODE_MAP = {
  [NatErrorCode.DiscoveryFailed]: ErrorCode.NatDiscoveryFailed,
  [NatErrorCode.MappingFailed]: ErrorCode.NatMappingFailed,
  [NatErrorCode.MappingConflict]: ErrorCode.NatMappingConflict,
  [NatErrorCode.ProtocolRejected]: ErrorCode.NatProtocolRejected,
  [NatErrorCode.ParseError]: ErrorCode.NatParseError,
  [NatErrorCode.SecurityViolation]: ErrorCode.NatSecurityViolation,
  [NatErrorCode.Timeout]: ErrorCode.NatTimeout,
  [NatErrorCode.NetworkChanged]: ErrorCode.NatNetworkChanged,
  [NatErrorCode.GatewayUnreachable]: ErrorCode.NatGatewayUnreachable,
  [NatErrorCode.StunDetectionFailed]: ErrorCode.StunDetectionFailed,
} satisfies Record<NatErrorCode, ErrorCode>

export interface NatStack {
  manager: NatManager
  networkMonitor: NetworkMonitor
}

export function createNatManager(args: {
  eventBus: EventBus
  settingsManager: SettingsManager
  isEngineReady: () => boolean
}): NatStack {
  const { eventBus, isEngineReady, settingsManager } = args
  setNatLogger(getLogger('nat'))

  // Derive client internal IP (16-byte v4-mapped IPv6) for PCP requests.
  // Best-effort: first non-internal IPv4 address. If none, fall back to loopback.
  const internalIp = detectInternalIp()
  const clientIp = ipv4StringToV4MappedIPv6(internalIp)

  // Gateway IP will be determined dynamically by discovery. PmpPcpClient
  // requires one at construction; we use a placeholder and let NatManager
  // re-instantiate when a real gateway is discovered. For Phase 1 we
  // pass the network-monitor snapshot as initial best-effort.
  const networkMonitor = new NetworkMonitor()
  const initialSnap = networkMonitor.snapshot()
  const gatewayIp = initialSnap.gatewayIp || '192.168.1.1'

  const upnpClient = new UpnpClient({
    udpFactory: nodeUdpSocketFactory,
    http: nodeHttpClient,
  })
  const pmpPcpClient = new PmpPcpClient({
    udpFactory: nodeUdpSocketFactory,
    gatewayIp,
    clientIp,
  })
  const stunClient = new StunClient({
    udpFactory: nodeUdpSocketFactory,
  })
  const portChecker = new PortChecker()

  // Bridge between host-app EventBus and NatManager's generic hooks/onEvent
  const hooks: NatManagerHooks = {
    onReady(listener) {
      const handler = (state: unknown) => {
        if (state === EngineState.Ready) listener()
      }
      eventBus.on(Events.EngineStateChanged, handler)
      return () => eventBus.off(Events.EngineStateChanged, handler)
    },
    onConfigChanged(listener) {
      eventBus.on(Events.SettingsChanged, listener)
      return () => eventBus.off(Events.SettingsChanged, listener)
    },
  }

  const onEvent = (event: NatEvent) => {
    switch (event.type) {
      case 'state-changed':
        eventBus.emit(Events.NatStateChanged, event.state)
        break
      case 'error':
        eventBus.emit(Events.NatError, {
          ...event.error,
          code: mapNatErrorCode(event.error.code),
        })
        break
      case 'gateway-changed':
        eventBus.emit(Events.NatGatewayChanged, event.info)
        break
      case 'mapping-updated':
        eventBus.emit(Events.NatMappingUpdated, event.mappings)
        break
      case 'diagnostic-completed':
        eventBus.emit(Events.NatDiagnosticCompleted, event.result)
        break
    }
  }

  const manager = new MotrixNatManager(
    {
      hooks,
      onEvent,
      settingsProvider: new SettingsNatProvider(settingsManager),
      upnpClient,
      pmpPcpClient,
      stunClient,
      portChecker,
      networkMonitor,
    },
    isEngineReady
  )

  return { manager, networkMonitor }
}

function mapNatErrorCode(code: string): ErrorCode | string {
  return NAT_ERROR_CODE_MAP[code as NatErrorCode] ?? code
}

function detectInternalIp(): string {
  const ifaces = networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

function ipv4StringToV4MappedIPv6(ipv4: string): Buffer {
  const parts = ipv4.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return Buffer.concat([
      Buffer.alloc(10),
      Buffer.from([0xff, 0xff]),
      Buffer.from([127, 0, 0, 1]),
    ])
  }
  return Buffer.concat([
    Buffer.alloc(10),
    Buffer.from([0xff, 0xff]),
    Buffer.from(parts),
  ])
}
