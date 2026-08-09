import { describe, expect, it } from 'vitest'
import {
  BridgeQueries,
  type ClientIdentity,
  clientKey,
  makeSessionKey,
  PairAppCodes,
  pairRequestKey,
} from './bridge'

describe('clientKey', () => {
  it('is byte-identical to makeSessionKey for the extension kind', () => {
    const identity: ClientIdentity = {
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'abcdefabcdefabcdefabcdefabcdefab',
    }
    expect(clientKey(identity)).toBe(
      makeSessionKey(identity.browser, identity.extensionId)
    )
    expect(clientKey(identity)).toBe(
      'chromium:abcdefabcdefabcdefabcdefabcdefab'
    )
  })

  it('composes browser and extensionId for the firefox kind', () => {
    const identity: ClientIdentity = {
      kind: 'extension',
      browser: 'firefox',
      extensionId: 'addon@example.com',
    }
    expect(clientKey(identity)).toBe('firefox:addon@example.com')
  })

  it('namespaces the cli kind under a cli: prefix', () => {
    const identity: ClientIdentity = { kind: 'cli', id: 'local' }
    expect(clientKey(identity)).toBe('cli:local')
  })

  it('never collides a cli key with an extension key', () => {
    const cli: ClientIdentity = { kind: 'cli', id: 'chromium:abc' }
    const ext: ClientIdentity = {
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'abc',
    }
    // Even an adversarial cli id that mimics the extension key shape is
    // disambiguated by the cli: prefix.
    expect(clientKey(cli)).not.toBe(clientKey(ext))
  })
})

describe('pending-pair-inbox protocol additions', () => {
  it('exposes the ListPendingPairRequests query channel', () => {
    expect(BridgeQueries.ListPendingPairRequests).toBe(
      'bridge:listPendingPairRequests'
    )
  })

  it('exposes the pair appCode constants', () => {
    expect(PairAppCodes.Unavailable).toBe('pair.request.unavailable')
    expect(PairAppCodes.RateLimited).toBe('pair.request.rateLimited')
  })
})

describe('pairRequestKey', () => {
  it('formats a cli key with a cli: prefix followed by the requestId', () => {
    expect(pairRequestKey({ kind: 'cli', requestId: 'abc123' })).toBe(
      'cli:abc123'
    )
  })

  it('formats an extension key as browser:extensionId:pairingNonce, matching PairingDialogController', () => {
    expect(
      pairRequestKey({
        kind: 'extension',
        pairingNonce: 'nonce1',
        extensionId: 'abcdefabcdefabcdefabcdefabcdefab',
        browser: 'chromium',
      })
    ).toBe('chromium:abcdefabcdefabcdefabcdefabcdefab:nonce1')
  })

  it('never collides a cli key with an extension key, even an adversarial one', () => {
    const cli = pairRequestKey({
      kind: 'cli',
      requestId: 'chromium:abc:nonce1',
    })
    const ext = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce1',
      extensionId: 'abc',
      browser: 'chromium',
    })
    expect(cli).not.toBe(ext)
  })
})
