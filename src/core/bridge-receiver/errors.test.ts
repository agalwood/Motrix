import { describe, expect, it } from 'vitest'
import { BridgeReceiverError } from './errors'

describe('BridgeReceiverError', () => {
  it('carries code and message', () => {
    const e = new BridgeReceiverError('invalid-payload', 'bad shape')
    expect(e.code).toBe('invalid-payload')
    expect(e.message).toBe('bad shape')
    expect(e).toBeInstanceOf(Error)
  })

  it('is named BridgeReceiverError', () => {
    const e = new BridgeReceiverError('not-found', 'x')
    expect(e.name).toBe('BridgeReceiverError')
  })
})
