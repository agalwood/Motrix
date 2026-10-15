import { describe, expect, it } from 'vitest'
import { buildConnectionDiagnostics } from '@/popup/connectionDiagnostics'

const environment = {
  capturedAt: '2026-09-08T08:00:00.000Z',
  extensionId: 'test-extension-id',
  extensionVersion: '0.1.7',
  build: 'full',
  userAgent: 'test-browser/1.0',
  language: 'zh-CN',
  nativeMessagingApi: true,
}

describe('connection diagnostics', () => {
  it('preserves an untyped native-host error and marks unavailable app data as unknown', () => {
    const text = buildConnectionDiagnostics(
      {
        connection: 'disconnected',
        lastError:
          'NM host disconnected: Specified native messaging host not found.',
        lastErrorReason: null,
        endpoint: null,
        server: null,
      },
      environment
    )
    const report = JSON.parse(text.slice(text.indexOf('\n') + 1))
    expect(report.connection).toEqual({
      backend: 'unknown',
      state: 'disconnected',
      protocol: 'MBP1',
      app: null,
      error: {
        reason: null,
        message:
          'NM host disconnected: Specified native messaging host not found.',
      },
    })
    expect(report.extension.version).toBe('0.1.7')
    expect(report.environment.nativeMessagingApi).toBe(true)
  })

  it('includes only selected diagnostic fields, excluding backend profiles and URL secrets', () => {
    const text = buildConnectionDiagnostics(
      {
        connection: 'denied',
        lastError:
          'Failed wss://alice:private-password@nas.example/pair?nonce=private-nonce&token=private-token#private-fragment',
        lastErrorReason: 'channelUnavailable',
        endpoint: {
          version: 3,
          activeEndpointId: 'private-endpoint-id',
          servers: [
            {
              id: 'private-endpoint-id',
              name: 'Private backend name',
              url: 'wss://private-backend.example/secret-path',
              revision: 2,
              state: 'ready',
            },
          ],
          cleanupTombstones: [],
        },
        server: {
          name: 'Private server name',
          version: '2.0.0-beta.14',
          runtime: 'server',
        },
      },
      environment
    )
    const report = JSON.parse(text.slice(text.indexOf('\n') + 1))
    expect(report.connection.backend).toBe('remote')
    expect(report.connection.app).toEqual({
      version: '2.0.0-beta.14',
      runtime: 'server',
    })
    expect(report.connection.error).toEqual({
      reason: 'channelUnavailable',
      message: 'Failed wss://nas.example/pair',
    })
    expect(text).not.toMatch(/private|alice/i)
  })
})
