import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'

describe('bridge rpc contract', () => {
  it('serves listPendingPairRequests as a query (200 + DTO array)', async () => {
    const dto = {
      requestId: 'r1',
      userCode: 'WXYZ-2345',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
      createdAt: 1,
      expiresAt: 2,
    }
    const app = await createApp({
      bridgeQueryHandlers: {
        [BridgeQueries.ListPendingPairRequests]: async () => [dto],
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(BridgeQueries.ListPendingPairRequests)}`,
      payload: { args: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([dto])
    await app.close()
  })

  it('returns a ResolvePair "unavailable" RESULT as 200 (not a 500 throw)', async () => {
    const app = await createApp({
      bridgeCommandHandlers: {
        [BridgeCommands.ResolvePair]: async () => ({
          ok: false,
          reason: 'unavailable',
        }),
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/command/${encodeURIComponent(BridgeCommands.ResolvePair)}`,
      payload: {
        args: [{ kind: 'cli', requestId: 'gone', decision: 'allow' }],
      },
    })
    // The point of the discriminated result (review finding B): a recoverable
    // outcome is a 200 return value the web renderer reads — NOT a 500 whose
    // structure HttpWsTransport collapses to a generic Error.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'unavailable' })
    await app.close()
  })
})
