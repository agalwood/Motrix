import { describe, expect, it } from 'vitest'
import { parseRemoteExtensionConfig } from './remote-extension-config'
import {
  evaluateRemoteExtensionHost,
  type RemoteExtensionHostRejection,
} from './remote-extension-host-policy'

function enabled(
  websocketUrl = 'wss://motrix.example/bridge'
): ReturnType<typeof parseRemoteExtensionConfig> {
  return parseRemoteExtensionConfig({
    MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
    MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: websocketUrl,
    MOTRIX_PUBLIC_URL: 'https://motrix.example',
  })
}

function decision(
  headers: readonly string[],
  websocketUrl?: string
): boolean | RemoteExtensionHostRejection {
  const result = evaluateRemoteExtensionHost(enabled(websocketUrl), headers)
  return result.ok ? true : result.reason
}

describe('evaluateRemoteExtensionHost', () => {
  it('accepts the configured authority without exposing request data', () => {
    expect(decision(['Host', 'motrix.example'])).toBe(true)
    expect(
      evaluateRemoteExtensionHost(enabled(), ['Host', 'motrix.example'])
    ).toEqual({ ok: true })
  })

  it.each([
    ['case folding', 'MOTRIX.EXAMPLE'],
    ['explicit default port', 'motrix.example:443'],
    ['case plus default port', 'MoTrIx.ExAmPlE:443'],
  ])('accepts canonical equivalent %s', (_label, host) => {
    expect(decision(['hOsT', host])).toBe(true)
  })

  it('requires an exact non-default effective port', () => {
    expect(
      decision(
        ['Host', 'motrix.example:8443'],
        'wss://motrix.example:8443/bridge'
      )
    ).toBe(true)
    expect(
      decision(['Host', 'motrix.example'], 'wss://motrix.example:8443/bridge')
    ).toBe('authority-mismatch')
    expect(
      decision(
        ['Host', 'motrix.example:8444'],
        'wss://motrix.example:8443/bridge'
      )
    ).toBe('authority-mismatch')
  })

  it('uses HTTP default-port semantics for an explicit WS authority', () => {
    expect(decision(['Host', 'nas.local'], 'ws://nas.local:80/bridge')).toBe(
      true
    )
    expect(
      decision(['Host', 'nas.local:8888'], 'ws://nas.local:8888/bridge')
    ).toBe(true)
    expect(decision(['Host', 'nas.local'], 'ws://nas.local:8888/bridge')).toBe(
      'authority-mismatch'
    )
    expect(
      decision(['Host', 'nas.local:443'], 'ws://nas.local:443/bridge')
    ).toBe(true)
  })

  it('canonicalizes IPv6 and IDNA hostnames before comparison', () => {
    expect(
      decision(
        ['Host', '[2001:0db8:0:0:0:0:0:1]:443'],
        'wss://[2001:db8::1]/bridge'
      )
    ).toBe(true)
    expect(
      decision(
        ['Host', 'b\u00fccher.example'],
        'wss://xn--bcher-kva.example/bridge'
      )
    ).toBe(true)
  })

  it('requires exactly one Host field even when duplicate values agree', () => {
    expect(decision([])).toBe('missing-host')
    expect(decision(['Host', 'motrix.example', 'host', 'motrix.example'])).toBe(
      'duplicate-host'
    )
  })

  it('never lets X-Forwarded-Host define or repair the authority', () => {
    expect(
      decision([
        'Host',
        'attacker.example',
        'X-Forwarded-Host',
        'motrix.example',
      ])
    ).toBe('authority-mismatch')
    expect(decision(['X-Forwarded-Host', 'motrix.example'])).toBe(
      'missing-host'
    )
  })

  it.each([
    ['empty', ''],
    ['leading space', ' motrix.example'],
    ['trailing space', 'motrix.example '],
    ['embedded tab', 'motrix\t.example'],
    ['control', 'motrix.example\u007f'],
    ['backslash', 'motrix.example\\alias'],
    ['percent', 'motrix%2eexample'],
    ['userinfo', 'user@motrix.example'],
    ['path', 'motrix.example/path'],
    ['query', 'motrix.example?x=1'],
    ['fragment', 'motrix.example#x'],
    ['comma join', 'motrix.example, attacker.example'],
    ['empty port', 'motrix.example:'],
    ['zero port', 'motrix.example:0'],
    ['leading-zero port', 'motrix.example:0443'],
    ['empty IPv6 port', '[2001:db8::1]:'],
    ['invalid port', 'motrix.example:99999'],
  ])('rejects malformed Host syntax: %s', (_label, host) => {
    expect(decision(['Host', host])).toBe('malformed-host')
  })

  it('bounds and validates the raw header vector', () => {
    expect(decision(['Host', 'motrix.example', 'Dangling-Header-Name'])).toBe(
      'malformed-headers'
    )
    expect(decision(Array.from({ length: 258 }, () => 'x'))).toBe(
      'malformed-headers'
    )
    expect(decision(['Host', 'a'.repeat(1_025)])).toBe('malformed-host')
  })

  it('keeps disabled, invalid, and structurally inconsistent configuration closed', () => {
    expect(
      evaluateRemoteExtensionHost(parseRemoteExtensionConfig({}), [
        'Host',
        'motrix.example',
      ])
    ).toEqual({ ok: false, reason: 'feature-closed' })
    expect(
      evaluateRemoteExtensionHost(
        parseRemoteExtensionConfig({
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        }),
        ['Host', 'motrix.example']
      )
    ).toEqual({ ok: false, reason: 'feature-closed' })

    const forged = {
      status: 'enabled',
      publicWebSocketBaseUrl: 'wss://attacker.example/bridge',
      publicWebSocketAuthority: 'motrix.example',
      publicWebSocketBasePath: '/bridge',
      publicOperatorBaseUrl: 'https://motrix.example',
      publicOperatorAuthority: 'motrix.example',
      publicOperatorBasePath: '',
    } as const
    expect(
      evaluateRemoteExtensionHost(forged, ['Host', 'motrix.example'])
    ).toEqual({ ok: false, reason: 'feature-closed' })

    const valid = enabled()
    expect(
      evaluateRemoteExtensionHost({ ...valid }, ['Host', 'motrix.example'])
    ).toEqual({ ok: false, reason: 'feature-closed' })
  })
})
