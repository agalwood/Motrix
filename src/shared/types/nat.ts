// Stable app-facing façade. NAT domain types are owned by @motrix/nat; keep
// this module so renderer and IPC imports do not churn during extraction.
export {
  type NatDiagnosticResult,
  type NatErrorInfo,
  type NatGatewayInfo,
  type NatMapping,
  type NatMappingPurpose,
  NatPortReachability,
  NatProtocol,
  NatState,
  type NatStatus,
  type NatTransportProtocol,
  NatType,
} from '@motrix/nat/types'
