import { describe, expect, it } from 'vitest'
import { parseRemoteExtensionConfig } from './remote-extension-config'
import { RemoteExtensionSurfacePolicy } from './remote-extension-surface-policy'

const config = parseRemoteExtensionConfig({
  MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
  MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://motrix.example/bridge',
  MOTRIX_PUBLIC_URL: 'https://motrix.example',
})
const nonce = (prefix: string) => `${prefix.repeat(21)}Q`

function request(
  rawTarget: string,
  method: string,
  transport: 'http' | 'websocket'
) {
  return {
    rawTarget,
    method,
    transport,
    rawHeaders: ['Host', 'motrix.example'],
    directPeerAddress: '127.0.0.1',
  } as const
}

describe('RemoteExtensionSurfacePolicy', () => {
  it('maps only the canonical public prefix and preserves the pair nonce', () => {
    const policy = new RemoteExtensionSurfacePolicy(config)
    expect(
      policy.evaluate(request('/bridge/discovery', 'GET', 'http'))
    ).toEqual({
      kind: 'route',
      route: 'discovery',
    })
    expect(
      policy.evaluate(
        request(`/bridge/pair?nonce=${nonce('A')}`, 'GET', 'websocket')
      )
    ).toMatchObject({
      kind: 'route',
      route: 'pair',
      pairNonce: nonce('A'),
    })
    expect(policy.evaluate(request('/pair', 'GET', 'websocket'))).toEqual({
      kind: 'not-extension',
    })
    policy.dispose()
  })

  it('rejects Host substitution before opening a route', () => {
    const policy = new RemoteExtensionSurfacePolicy(config)
    expect(
      policy.evaluate({
        ...request('/bridge/discovery', 'GET', 'http'),
        rawHeaders: ['Host', 'attacker.example'],
      })
    ).toEqual({ kind: 'reject', status: 403 })
    policy.dispose()
  })

  it('bounds public pre-auth pair capacity and releases leases', () => {
    const policy = new RemoteExtensionSurfacePolicy(config)
    const leases = Array.from({ length: 32 }, () =>
      policy.evaluate(
        request(`/bridge/pair?nonce=${nonce('B')}`, 'GET', 'websocket')
      )
    )
    expect(leases.every((decision) => decision.kind === 'route')).toBe(true)
    expect(
      policy.evaluate(
        request(`/bridge/pair?nonce=${nonce('C')}`, 'GET', 'websocket')
      )
    ).toEqual({ kind: 'reject', status: 429 })

    const first = leases[0]
    if (first?.kind === 'route') first.releaseAdmission?.()
    expect(
      policy.evaluate(
        request(`/bridge/pair?nonce=${nonce('D')}`, 'GET', 'websocket')
      )
    ).toMatchObject({ kind: 'route', route: 'pair' })
    policy.dispose()
  })
})
