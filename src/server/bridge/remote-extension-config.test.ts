import { describe, expect, it } from 'vitest'
import {
  isIssuedRemoteExtensionConfig,
  parseRemoteExtensionConfig,
  RemoteExtensionConfigDiagnosticCode,
  RemoteExtensionEnvironmentVariable,
} from './remote-extension-config'

const enabledEnvironment = {
  MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
  MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://motrix.example/bridge',
  MOTRIX_PUBLIC_URL: 'https://motrix.example/operator',
}

describe('parseRemoteExtensionConfig', () => {
  it('issues ephemeral capabilities and rejects structural copies', () => {
    const parsed = parseRemoteExtensionConfig(enabledEnvironment)

    expect(isIssuedRemoteExtensionConfig(parsed)).toBe(true)
    expect(isIssuedRemoteExtensionConfig({ ...parsed })).toBe(false)
    expect(
      isIssuedRemoteExtensionConfig(JSON.parse(JSON.stringify(parsed)))
    ).toBe(false)
  })

  it.each([
    {},
    { MOTRIX_REMOTE_EXTENSION_ENABLED: '' },
    { MOTRIX_REMOTE_EXTENSION_ENABLED: '  ' },
    { MOTRIX_REMOTE_EXTENSION_ENABLED: 'false' },
    { MOTRIX_REMOTE_EXTENSION_ENABLED: 'FALSE' },
    { MOTRIX_REMOTE_EXTENSION_ENABLED: ' 0 ' },
  ])('keeps the surface disabled for %j', (environment) => {
    expect(parseRemoteExtensionConfig(environment)).toEqual({
      status: 'disabled',
    })
  })

  it.each(['true', ' TRUE ', '1', ' 1 '])(
    'accepts the existing strict server boolean spelling %j',
    (enabled) => {
      expect(
        parseRemoteExtensionConfig({
          ...enabledEnvironment,
          MOTRIX_REMOTE_EXTENSION_ENABLED: enabled,
        }).status
      ).toBe('enabled')
    }
  )

  it('reports an ambiguous enabled flag without throwing', () => {
    expect(
      parseRemoteExtensionConfig({
        ...enabledEnvironment,
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'yes',
      })
    ).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.Enabled,
        code: RemoteExtensionConfigDiagnosticCode.InvalidEnabledFlag,
      },
    })
  })

  it.each([
    [
      'MOTRIX_REMOTE_EXTENSION_PUBLIC_URL',
      RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
    ],
    ['MOTRIX_PUBLIC_URL', RemoteExtensionEnvironmentVariable.PublicOperatorUrl],
  ] as const)('requires %s when enabled', (key, variable) => {
    const environment = { ...enabledEnvironment }
    delete environment[key]

    expect(parseRemoteExtensionConfig(environment)).toEqual({
      status: 'invalid',
      diagnostic: {
        variable,
        code: RemoteExtensionConfigDiagnosticCode.MissingUrl,
      },
    })
  })

  it('canonicalizes default ports, host casing, paths, and IPv6', () => {
    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'WSS://[2001:DB8::1]:443/bridge///',
        MOTRIX_PUBLIC_URL: 'HTTPS://OPERATOR.Example:443/ui///',
      })
    ).toEqual({
      status: 'enabled',
      publicWebSocketBaseUrl: 'wss://[2001:db8::1]/bridge',
      publicWebSocketAuthority: '[2001:db8::1]',
      publicWebSocketBasePath: '/bridge',
      publicOperatorBaseUrl: 'https://operator.example/ui',
      publicOperatorAuthority: 'operator.example',
      publicOperatorBasePath: '/ui',
    })
  })

  it('preserves non-default ports and an empty root prefix', () => {
    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: '1',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://motrix.example:9443/',
        MOTRIX_PUBLIC_URL: 'https://console.example:8443/',
      })
    ).toEqual({
      status: 'enabled',
      publicWebSocketBaseUrl: 'wss://motrix.example:9443',
      publicWebSocketAuthority: 'motrix.example:9443',
      publicWebSocketBasePath: '',
      publicOperatorBaseUrl: 'https://console.example:8443',
      publicOperatorAuthority: 'console.example:8443',
      publicOperatorBasePath: '',
    })
  })

  it('accepts and canonicalizes an explicit WS public endpoint', () => {
    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'WS://NAS.Local:80/bridge///',
        MOTRIX_PUBLIC_URL: 'https://console.example/operator',
      })
    ).toEqual({
      status: 'enabled',
      publicWebSocketBaseUrl: 'ws://nas.local/bridge',
      publicWebSocketAuthority: 'nas.local',
      publicWebSocketBasePath: '/bridge',
      publicOperatorBaseUrl: 'https://console.example/operator',
      publicOperatorAuthority: 'console.example',
      publicOperatorBasePath: '/operator',
    })
  })

  it.each(['true', ' TRUE ', '1', ' 1 '])(
    'accepts an HTTP operator URL only with explicit insecure-LAN consent %j',
    (consent) => {
      expect(
        parseRemoteExtensionConfig({
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
          MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16801',
          MOTRIX_PUBLIC_URL: 'HTTP://NAS.Local:80/admin///',
          MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: consent,
        })
      ).toEqual({
        status: 'enabled',
        publicWebSocketBaseUrl: 'ws://nas.local:16801',
        publicWebSocketAuthority: 'nas.local:16801',
        publicWebSocketBasePath: '',
        publicOperatorBaseUrl: 'http://nas.local/admin',
        publicOperatorAuthority: 'nas.local',
        publicOperatorBasePath: '/admin',
      })
    }
  )

  it.each([undefined, '', 'false', 'FALSE', '0'])(
    'rejects an HTTP operator URL without explicit insecure-LAN consent %j',
    (consent) => {
      expect(
        parseRemoteExtensionConfig({
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
          MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16801',
          MOTRIX_PUBLIC_URL: 'http://nas.local:8080',
          ...(consent === undefined
            ? {}
            : { MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: consent }),
        })
      ).toEqual({
        status: 'invalid',
        diagnostic: {
          variable:
            RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp,
          code: RemoteExtensionConfigDiagnosticCode.InsecureOperatorHttpConsentRequired,
        },
      })
    }
  )

  it('rejects an ambiguous insecure-HTTP consent flag', () => {
    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16801',
        MOTRIX_PUBLIC_URL: 'http://nas.local:8080',
        MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'yes',
      })
    ).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp,
        code: RemoteExtensionConfigDiagnosticCode.InvalidInsecureOperatorHttpFlag,
      },
    })
  })

  it('does not require insecure-LAN consent for HTTPS', () => {
    expect(
      parseRemoteExtensionConfig({
        ...enabledEnvironment,
        MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'false',
      }).status
    ).toBe('enabled')
  })

  it.each([
    ['https://motrix.example/bridge', 'https://motrix.example'],
    ['wss://motrix.example/bridge', 'wss://motrix.example'],
  ])(
    'rejects protocol substitution (%s, %s)',
    (publicWebSocketUrl, publicOperatorUrl) => {
      const result = parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: publicWebSocketUrl,
        MOTRIX_PUBLIC_URL: publicOperatorUrl,
      })
      expect(result.status).toBe('invalid')
      if (result.status === 'invalid') {
        expect(result.diagnostic.code).toBe(
          RemoteExtensionConfigDiagnosticCode.UnsupportedProtocol
        )
      }
    }
  )

  it.each([
    ['wss://user:secret@motrix.example/bridge', 'userinfo'],
    ['wss://@motrix.example/bridge', 'empty userinfo'],
    ['wss://motrix.example/bridge?token=secret', 'query'],
    ['wss://motrix.example/bridge?', 'empty query'],
    ['wss://motrix.example/bridge#fragment', 'fragment'],
    ['wss://motrix.example/bridge#', 'empty fragment'],
    ['wss:\\motrix.example\\bridge', 'backslash'],
    ['wss://motrix.example/bridge\nnext', 'ASCII control'],
    ['wss://motrix.example/bridge%2Fhidden', 'encoded slash'],
    ['wss://motrix.example/bridge%5chidden', 'encoded backslash'],
    ['wss://motrix.example/bridge%252fhidden', 'double-encoded slash'],
    ['wss://motrix.example/bridge%25%32%66hidden', 'split encoded slash'],
    ['wss://motrix.example/bridge%25%35%63hidden', 'split encoded backslash'],
    ['wss://motrix.example/bridge%zz', 'invalid percent encoding'],
    [' wss://motrix.example/bridge', 'leading whitespace'],
    ['wss://motrix.example/bridge ', 'trailing whitespace'],
    ['wss://motrix.example/bridge path', 'embedded whitespace'],
    ['wss://motrix.example/bridge\u00a0path', 'Unicode whitespace'],
    ['wss://motrix.example/bridge\u0085path', 'Unicode White_Space'],
    ['not a URL', 'invalid URL'],
  ])('rejects %s (%s)', (publicWebSocketUrl) => {
    expect(
      parseRemoteExtensionConfig({
        ...enabledEnvironment,
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: publicWebSocketUrl,
      }).status
    ).toBe('invalid')
  })

  it.each([
    'https://user:secret@motrix.example/operator',
    'https://@motrix.example/operator',
    'https://motrix.example/operator?token=secret',
    'https://motrix.example/operator#fragment',
    'https:\\motrix.example\\operator',
    'https://motrix.example/operator\u0000tail',
    'https://motrix.example/operator%2ftail',
    'https://motrix.example/operator%255ctail',
    ' https://motrix.example/operator',
    'https://motrix.example/operator ',
    'https://motrix.example/operator\u2003path',
  ])('applies the same strict policy to the operator URL %j', (publicUrl) => {
    expect(
      parseRemoteExtensionConfig({
        ...enabledEnvironment,
        MOTRIX_PUBLIC_URL: publicUrl,
      }).status
    ).toBe('invalid')
  })

  it('rejects overlong inputs without echoing them in diagnostics', () => {
    const secretPath = `wss://motrix.example/${'secret'.repeat(700)}`
    const result = parseRemoteExtensionConfig({
      ...enabledEnvironment,
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: secretPath,
    })

    expect(result).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
        code: RemoteExtensionConfigDiagnosticCode.UrlTooLong,
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('rejects a canonical URL that expands beyond the length limit', () => {
    const result = parseRemoteExtensionConfig({
      ...enabledEnvironment,
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: `wss://motrix.example/${'界'.repeat(500)}`,
    })

    expect(result).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
        code: RemoteExtensionConfigDiagnosticCode.UrlTooLong,
      },
    })
  })

  it('is byte-stable when canonical output is parsed again', () => {
    const first = parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL:
        'WSS://B\u00dcCHER.example:443/bridge/\u8d44\u6e90///',
      MOTRIX_PUBLIC_URL:
        'HTTPS://B\u00dcCHER.example:443/operator/\u9875\u9762///',
    })
    expect(first.status).toBe('enabled')
    if (first.status !== 'enabled') return

    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: first.publicWebSocketBaseUrl,
        MOTRIX_PUBLIC_URL: first.publicOperatorBaseUrl,
      })
    ).toEqual(first)
  })

  it('never throws for malformed runtime input or hostile property access', () => {
    const wrongType = {
      ...enabledEnvironment,
      MOTRIX_PUBLIC_URL: 42,
    } as unknown as Record<string, string | undefined>
    expect(() => parseRemoteExtensionConfig(wrongType)).not.toThrow()
    expect(parseRemoteExtensionConfig(wrongType)).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: 'configuration',
        code: RemoteExtensionConfigDiagnosticCode.InvalidEnvironment,
      },
    })

    const hostile = Object.defineProperty(
      {},
      'MOTRIX_REMOTE_EXTENSION_ENABLED',
      {
        get() {
          throw new Error('operator-secret')
        },
      }
    ) as Record<string, string | undefined>
    expect(() => parseRemoteExtensionConfig(hostile)).not.toThrow()
    expect(JSON.stringify(parseRemoteExtensionConfig(hostile))).not.toContain(
      'operator-secret'
    )
  })

  it('never consumes or returns a legacy token', () => {
    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_TOKEN: 'legacy-super-secret',
      })
    ).toEqual({ status: 'disabled' })

    expect(
      parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_TOKEN: 'legacy-super-secret',
      })
    ).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
        code: RemoteExtensionConfigDiagnosticCode.MissingUrl,
      },
    })

    const result = parseRemoteExtensionConfig({
      ...enabledEnvironment,
      MOTRIX_REMOTE_EXTENSION_TOKEN: 'legacy-super-secret',
    })

    expect(result.status).toBe('enabled')
    expect(JSON.stringify(result)).not.toContain('legacy-super-secret')
    expect(result).not.toHaveProperty('token')
  })

  it('does not infer public authority from forwarded headers', () => {
    const missingExplicitAuthority = parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_PUBLIC_URL: 'https://operator.example',
      X_FORWARDED_HOST: 'attacker.example',
      X_FORWARDED_PROTO: 'wss',
    })
    expect(missingExplicitAuthority).toEqual({
      status: 'invalid',
      diagnostic: {
        variable: RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
        code: RemoteExtensionConfigDiagnosticCode.MissingUrl,
      },
    })

    const configured = parseRemoteExtensionConfig({
      ...enabledEnvironment,
      X_FORWARDED_HOST: 'attacker.example',
      X_FORWARDED_PROTO: 'ws',
    })
    expect(configured).toMatchObject({
      status: 'enabled',
      publicWebSocketAuthority: 'motrix.example',
    })
  })
})
