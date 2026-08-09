import { describe, expect, it } from 'vitest'
import { ErrorCode } from './errors'

describe('ErrorCode NAT entries', () => {
  it('contains all NAT error codes', () => {
    expect(ErrorCode.NatDiscoveryFailed).toBe('NAT_DISCOVERY_FAILED')
    expect(ErrorCode.NatMappingFailed).toBe('NAT_MAPPING_FAILED')
    expect(ErrorCode.NatMappingConflict).toBe('NAT_MAPPING_CONFLICT')
    expect(ErrorCode.NatProtocolRejected).toBe('NAT_PROTOCOL_REJECTED')
    expect(ErrorCode.NatParseError).toBe('NAT_PARSE_ERROR')
    expect(ErrorCode.NatSecurityViolation).toBe('NAT_SECURITY_VIOLATION')
    expect(ErrorCode.NatTimeout).toBe('NAT_TIMEOUT')
    expect(ErrorCode.NatNetworkChanged).toBe('NAT_NETWORK_CHANGED')
    expect(ErrorCode.NatGatewayUnreachable).toBe('NAT_GATEWAY_UNREACHABLE')
    expect(ErrorCode.StunDetectionFailed).toBe('STUN_DETECTION_FAILED')
    expect(ErrorCode.IpcInvalidPayload).toBe('IPC_INVALID_PAYLOAD')
    expect(ErrorCode.IpcRateLimited).toBe('IPC_RATE_LIMITED')
  })
})
