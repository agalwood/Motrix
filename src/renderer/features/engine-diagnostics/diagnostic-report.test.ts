import {
  type EngineDiagnosticReport,
  EngineFailureReason,
  EngineRecoveryRecommendation,
  EngineState,
} from '@shared/types/engine'
import { describe, expect, it } from 'vitest'
import { formatEngineDiagnostics } from './diagnostic-report'

const report: EngineDiagnosticReport = {
  state: EngineState.Failed,
  managedPid: null,
  generatedAt: 1,
  binary: { name: 'aria2c', available: true, version: '1.37.0-motrix.14' },
  featureReport: null,
  rpc: {
    port: 16800,
    available: true,
    expectedListener: false,
    connection: { transport: 'websocket', connected: false },
  },
  process: null,
  defaultRpc: {
    port: 16800,
    available: true,
    isCurrent: true,
    process: null,
    canRestore: false,
    requiresTermination: false,
  },
  failure: {
    reason: EngineFailureReason.RpcUnavailable,
    occurredAt: 1,
    technicalMessage: null,
  },
  recommendation: EngineRecoveryRecommendation.Retry,
  canRetry: true,
  canForceTerminate: false,
  canSwitchPort: false,
  suggestedRpcPort: null,
}

describe('formatEngineDiagnostics', () => {
  it('exports the full detected version, timestamps and unavailable values without inventing results', () => {
    const text = formatEngineDiagnostics(report)
    const parsed = JSON.parse(text)
    expect(parsed.binary.version).toBe('1.37.0-motrix.14')
    expect(parsed.generatedAt).toBe('1970-01-01T00:00:00.001Z')
    expect(parsed.featureReport).toBeNull()
    expect(parsed.failure.technicalMessage).toBeNull()
    expect(parsed.managedPid).toBeNull()
    expect(parsed.canRetry).toBe(true)
    expect(parsed.rpc.connection).toEqual({
      transport: 'websocket',
      connected: false,
    })
    expect(parsed.application.version).toBe(__MOTRIX_APP_METADATA__.version)
  })

  it('omits unknown future transport fields from shared reports', () => {
    const text = formatEngineDiagnostics({
      ...report,
      privateData: 'future-secret',
      binary: { ...report.binary, privateData: 'binary-secret' },
    } as EngineDiagnosticReport)
    expect(text).not.toContain('future-secret')
    expect(text).not.toContain('binary-secret')
  })

  it('redacts credential-shaped errors and home paths while retaining diagnostic evidence', () => {
    const text = formatEngineDiagnostics({
      ...report,
      failure: {
        ...report.failure!,
        technicalMessage:
          'Failed on port 16800: --rpc-secret="secret with spaces" --all-proxy-passwd=proxy-secret Authorization: Bearer bearer-secret https://user:pass@example.com/rpc?token=query-secret&port=16800 {"token":"json-secret"} /Users/alice/Downloads C:\\Users\\bob\\Downloads',
      },
    })
    for (const secret of [
      'secret with spaces',
      'proxy-secret',
      'bearer-secret',
      'user:pass',
      'query-secret',
      'json-secret',
      'alice',
      'bob',
    ])
      expect(text).not.toContain(secret)
    expect(text).toContain('16800')
    expect(text).toContain('[redacted]')
    expect(text).toContain('[home]')
    expect(JSON.parse(text).failure.reason).toBe(
      EngineFailureReason.RpcUnavailable
    )
  })
})
