import { describe, expect, it } from 'vitest'
import { connectionErrorKey, REASON_KEYS } from '@/shared/errorCopy'
import { i18n } from '@/shared/i18n'

describe('connectionErrorKey', () => {
  it('maps a pairing failure reason to its locale key', () => {
    expect(connectionErrorKey('peerRejected')).toBe(
      'errors.connection.peerRejected'
    )
  })

  it('maps a reconnect failure reason to its locale key', () => {
    expect(connectionErrorKey('authFailed')).toBe(
      'errors.connection.authFailed'
    )
  })

  it.each([
    ['backendUpgradeRequired', 'errors.connection.backendUpgradeRequired'],
    ['extensionUpgradeRequired', 'errors.connection.extensionUpgradeRequired'],
    ['unsupportedRemote', 'errors.connection.unsupportedRemote'],
    [
      'remoteDiscoveryUnavailable',
      'errors.connection.remoteDiscoveryUnavailable',
    ],
    ['remotePairingUnavailable', 'errors.connection.remotePairingUnavailable'],
    [
      'remoteTransportUnavailable',
      'errors.connection.remoteTransportUnavailable',
    ],
  ])('maps compatibility reason %s', (reason, key) => {
    expect(connectionErrorKey(reason)).toBe(key)
  })

  it('falls back to the generic key for unknown or missing reasons', () => {
    // Reasons are an open set at this seam: a background version can ship a
    // code this popup build has never heard of, and `null` covers untyped
    // errors that carry only a developer-facing message.
    expect(connectionErrorKey('someFutureReason')).toBe(
      'errors.connection.generic'
    )
    expect(connectionErrorKey(null)).toBe('errors.connection.generic')
  })

  it('describes a remote transport failure without inventing a certificate diagnosis', () => {
    const key = connectionErrorKey('remoteTransportUnavailable')
    const english = i18n.t(key, { lng: 'en-US' })
    const chinese = i18n.t(key, { lng: 'zh-CN' })

    expect(english).toContain('connection failed')
    expect(english).toContain('for WSS')
    expect(english).toContain('browser cannot identify which one failed')
    expect(english).not.toMatch(/expired|hostname mismatch|unknown CA/iu)
    expect(chinese).toContain('无法连接')
    expect(chinese).toContain('若使用 WSS')
    expect(chinese).toContain('浏览器无法判断')
  })

  it('has copy for every mapped reason', () => {
    // One locale suffices: locale-parity.test.ts already guarantees en-US
    // and zh-CN carry identical key sets.
    const keys = [...Object.values(REASON_KEYS), 'errors.connection.generic']
    for (const key of keys) {
      expect(i18n.exists(key, { lng: 'en-US' }), key).toBe(true)
    }
  })
})
