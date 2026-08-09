// NAT Manager domain types. Engine-agnostic; exposed to renderer via IPC.
// Future Rust migration must preserve these shapes exactly.

export enum NatState {
  Idle = 'idle',
  Discovering = 'discovering',
  Ready = 'ready',
  Mapping = 'mapping',
  Active = 'active',
  Failed = 'failed',
  Stopping = 'stopping',
  Stopped = 'stopped',
}

export enum NatProtocol {
  Pcp = 'pcp',
  NatPmp = 'natpmp',
  Upnp = 'upnp',
}

export enum NatType {
  Open = 'open',
  FullCone = 'fullcone',
  RestrictedCone = 'restricted',
  PortRestricted = 'port-restricted',
  Symmetric = 'symmetric',
  Blocked = 'blocked',
  Unknown = 'unknown',
}

export enum NatPortReachability {
  Reachable = 'reachable',
  Unreachable = 'unreachable',
  Unknown = 'unknown',
}

export type NatTransportProtocol = 'TCP' | 'UDP'

export type NatMappingPurpose = 'bt-listen' | 'dht-listen'

export interface NatMapping {
  internalPort: number
  externalPort: number
  protocol: NatTransportProtocol
  purpose: NatMappingPurpose
  method: NatProtocol
  ttl: number
  expiresAt: number
  createdAt: number
  lastRenewedAt: number
  /** PCP mapping nonce (hex). Required by RFC 6887 to delete the mapping. */
  pcpNonce?: string
}

export interface NatGatewayInfo {
  internalIp: string
  gatewayIp: string
  externalIp: string | null
  controlUrl: string | null
  controlHost: string | null
  controlPort: number | null
  manufacturer: string | null
  modelName: string | null
  supportedProtocols: NatProtocol[]
}

export interface NatDiagnosticResult {
  runAt: number
  natType: NatType
  gatewayInfo: NatGatewayInfo | null
  portReachability: {
    btListenPort: NatPortReachability
    dhtListenPort: NatPortReachability
  }
  protocolAvailability: {
    pcp: boolean
    natpmp: boolean
    upnp: boolean
  }
  healthScore: 'good' | 'fair' | 'poor'
  recommendations: string[]
}

export interface NatErrorInfo {
  code: string
  message: string
  occurredAt: number
}

export interface NatStatus {
  state: NatState
  enabled: boolean
  activeMappings: NatMapping[]
  gatewayInfo: NatGatewayInfo | null
  lastError: NatErrorInfo | null
  lastDiagnostic: NatDiagnosticResult | null
  /**
   * Number of retry attempts already scheduled. 0 = no retries queued yet.
   * When state is Failed and retryAttempt < maxRetries, the manager is
   * waiting in an exponential-backoff window before the next discovery.
   */
  retryAttempt: number
  /** Maximum auto-retries before entering dormant state. */
  maxRetries: number
}
