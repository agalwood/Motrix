import { describe, expect, it, vi } from 'vitest'
import {
  parseRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'
import { logRemoteExtensionPairingReady } from './remote-extension-startup-log'

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

describe('logRemoteExtensionPairingReady', () => {
  it.each([
    ['WS', 'WS://NAS.Local:80/bridge/', 'ws://nas.local/bridge'],
    ['WSS', 'WSS://Motrix.Example:443/', 'wss://motrix.example'],
  ])(
    'prints the canonical %s address a user can paste into the Extension',
    (_transport, configuredAddress, expectedAddress) => {
      const log = logger()
      const config = parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: configuredAddress,
        MOTRIX_PUBLIC_URL: 'https://operator.example',
      })

      logRemoteExtensionPairingReady(log, config)

      expect(log.info).toHaveBeenCalledWith(
        { extensionServerAddress: expectedAddress },
        `Motrix Extension pairing ready. Enter this Server address in the Extension: ${expectedAddress}`
      )
      expect(log.warn).not.toHaveBeenCalled()
    }
  )

  it('warns when the operator explicitly accepts HTTP on a trusted network', () => {
    const log = logger()
    const config = parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16801',
      MOTRIX_PUBLIC_URL: 'http://nas.local:8080',
      MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'true',
    })

    logRemoteExtensionPairingReady(log, config)

    expect(log.warn).toHaveBeenCalledWith(
      { operatorTransport: 'http' },
      'Motrix operator UI uses HTTP. The operator token, pairing codes, session cookies, and administrator traffic are not protected by TLS. Use only on a trusted network; HTTPS is recommended.'
    )
    expect(log.info).toHaveBeenCalledWith(
      { extensionServerAddress: 'ws://nas.local:16801' },
      'Motrix Extension pairing ready. Enter this Server address in the Extension: ws://nas.local:16801'
    )
  })

  it.each([
    parseRemoteExtensionConfig({}),
    parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
    }),
  ])('does not advertise a disabled or invalid surface', (config) => {
    const log = logger()

    logRemoteExtensionPairingReady(log, config)

    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('does not advertise a structurally manufactured address', () => {
    const log = logger()
    const forged = {
      status: 'enabled',
      publicWebSocketBaseUrl: 'ws://example.test\nforged-log-entry',
    } as unknown as RemoteExtensionConfig

    logRemoteExtensionPairingReady(log, forged)

    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })
})
