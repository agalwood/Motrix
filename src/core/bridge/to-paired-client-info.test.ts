import { describe, expect, it } from 'vitest'
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

  it('maps an extension identity to id + browser and keeps display fields', () => {
    expect(toPairedClientInfo(pairedExt)).toEqual({
      kind: 'extension',
      id: 'ext-abc',
      browser: 'chromium',
      name: 'Motrix Bridge',
      pairedAt: 1000,
      lastActiveAt: 2000,
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

  it('never includes the token', () => {
    const info = toPairedClientInfo(pairedExt) as unknown as Record<
      string,
      unknown
    >
    expect(info.token).toBeUndefined()
  })
})
