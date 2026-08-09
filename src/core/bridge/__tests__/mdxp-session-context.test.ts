import { describe, expect, it, vi } from 'vitest'
import type { BridgeConnection } from '../bridge-connection'
import { contextFromConnection } from '../mdxp-session-context'
import type { PairRequestArgs } from '../web-socket-bridge-server'

function fakeConn(): BridgeConnection {
  return {
    session: {
      sessionKey: 'chromium:abc',
      extensionId: 'abc',
      browser: 'chromium',
      startedAt: 42,
    },
    isReady: () => false,
    markReady: vi.fn(),
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
  } as unknown as BridgeConnection
}

describe('contextFromConnection', () => {
  it('derives an extension ClientIdentity from the connection session', () => {
    const ctx = contextFromConnection(fakeConn(), null)
    expect(ctx.identity).toEqual({
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'abc',
    })
    expect(ctx.startedAt).toBe(42)
    expect(ctx.pendingPair).toBeNull()
    expect(typeof ctx.sendRequest).toBe('function')
    expect(typeof ctx.sendNotification).toBe('function')
  })

  it('passes pendingPair through and delegates readiness to the connection', () => {
    const conn = fakeConn()
    const pair: PairRequestArgs = {
      extensionId: 'abc',
      browser: 'chromium',
      extensionName: 'x',
      extensionVersion: '1',
    }
    const ctx = contextFromConnection(conn, pair)
    expect(ctx.pendingPair).toBe(pair)
    ctx.markReady()
    expect(conn.markReady).toHaveBeenCalledOnce()
  })
})
