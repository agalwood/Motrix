import { networkInterfaces } from 'node:os'
import type { EventBus } from '@core/events/event-bus'
import { PmpPcpClient } from '@core/nat/clients/pmp-pcp-client'
import { StunClient } from '@core/nat/clients/stun-client'
import { UpnpClient } from '@core/nat/clients/upnp-client'
import { NatManager, type NatManagerHooks } from '@core/nat/nat-manager'
import { nodeHttpClient } from '@core/nat/net/http-client'
import { nodeUdpSocketFactory } from '@core/nat/net/udp-socket'
import { NetworkMonitor } from '@core/nat/network-monitor'
import { PortChecker } from '@core/nat/port-checker'
import { SettingsNatProvider } from '@core/nat/settings-nat-provider'
import type { SettingsManager } from '@core/settings/settings-manager'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'

export interface NatStack {
  manager: NatManager
  networkMonitor: NetworkMonitor
}

export function createNatManager(args: {
  eventBus: EventBus
  settingsManager: SettingsManager
}): NatStack {
  const { eventBus, settingsManager } = args

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

  const onEvent = (event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case 'state-changed':
        eventBus.emit(Events.NatStateChanged, event.state)
        break
      case 'error':
        eventBus.emit(Events.NatError, event.error)
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

  const manager = new NatManager({
    hooks,
    onEvent,
    settingsProvider: new SettingsNatProvider(settingsManager),
    upnpClient,
    pmpPcpClient,
    stunClient,
    portChecker,
    networkMonitor,
  })

  return { manager, networkMonitor }
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
