import { describe, expect, it } from 'vitest'
import type { ExtensionPairingProjection } from './extension-pairing-projection'
import type { PairedClient } from './pairing-service'
import { toPairedClientInfo } from './to-paired-client-info'

describe('toPairedClientInfo', () => {
  const pairedExt: PairedClient = {
    identity: {
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'ext-abc',
    },
    token: 'super-secret-token',
    name: 'Motrix Bridge',
    pairedAt: 1000,
    lastActiveAt: 2000,
  }

  const pairedCli: PairedClient = {
    identity: { kind: 'cli', id: 'agent-1' },
    token: 'super-secret-token',
    name: 'Motrix CLI',
    pairedAt: 1000,
    lastActiveAt: null,
  }

  const projectedExt: ExtensionPairingProjection = {
    identity: {
      kind: 'extension',
      browser: 'firefox',
      extensionId: 'moz-extension-uuid',
    },
    identityTrust: 'unverified',
    authorizationEpoch: '11111111-1111-4111-8111-111111111111',
    status: 'ready',
    pairedAt: 3000,
    lastActiveAt: 4000,
  }

  it('maps an extension identity to id + browser and keeps display fields', () => {
    expect(toPairedClientInfo(projectedExt)).toEqual({
      kind: 'extension',
      id: 'moz-extension-uuid',
      browser: 'firefox',
      identityTrust: 'unverified',
      status: 'ready',
      name: '',
      pairedAt: 3000,
      lastActiveAt: 4000,
    })
  })

  it('maps a cli identity to id without a browser', () => {
    expect(toPairedClientInfo(pairedCli)).toEqual({
      kind: 'cli',
      id: 'agent-1',
      name: 'Motrix CLI',
      pairedAt: 1000,
      lastActiveAt: null,
    })
  })

  it('maps an extension projection without inventing a token or display name', () => {
    expect(toPairedClientInfo(projectedExt)).toEqual({
      kind: 'extension',
      id: 'moz-extension-uuid',
      browser: 'firefox',
      identityTrust: 'unverified',
      status: 'ready',
      name: '',
      pairedAt: 3000,
      lastActiveAt: 4000,
    })
  })

  it('never includes the token', () => {
    const info = toPairedClientInfo(projectedExt) as unknown as Record<
      string,
      unknown
    >
    expect(info.token).toBeUndefined()
    expect(info.authorizationEpoch).toBeUndefined()
  })

  it('rejects a token-backed extension instead of projecting it as MBP1 state', () => {
    expect(() => toPairedClientInfo(pairedExt)).toThrow(
      'token-backed extension projection rejected'
    )
  })
})
