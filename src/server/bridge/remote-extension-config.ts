import { z } from 'zod'
import { parseServerBoolean } from '../environment'

export const REMOTE_EXTENSION_PUBLIC_URL_MAX_LENGTH = 4_096

export const RemoteExtensionEnvironmentVariable = {
  Enabled: 'MOTRIX_REMOTE_EXTENSION_ENABLED',
  PublicWebSocketUrl: 'MOTRIX_REMOTE_EXTENSION_PUBLIC_URL',
  PublicOperatorUrl: 'MOTRIX_PUBLIC_URL',
  AllowInsecureOperatorHttp: 'MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP',
} as const

export type RemoteExtensionEnvironmentVariable =
  (typeof RemoteExtensionEnvironmentVariable)[keyof typeof RemoteExtensionEnvironmentVariable]

export interface RemoteExtensionEnvironment {
  readonly [name: string]: string | undefined
}

export enum RemoteExtensionConfigDiagnosticCode {
  InvalidEnvironment = 'invalid-environment',
  InvalidEnabledFlag = 'invalid-enabled-flag',
  InvalidInsecureOperatorHttpFlag = 'invalid-insecure-operator-http-flag',
  InsecureOperatorHttpConsentRequired = 'insecure-operator-http-consent-required',
  MissingUrl = 'missing-url',
  UrlTooLong = 'url-too-long',
  AsciiControlCharacter = 'ascii-control-character',
  Whitespace = 'whitespace',
  Backslash = 'backslash',
  EncodedPathSeparator = 'encoded-path-separator',
  InvalidPercentEncoding = 'invalid-percent-encoding',
  InvalidUrl = 'invalid-url',
  UnsupportedProtocol = 'unsupported-protocol',
  UserInfo = 'userinfo',
  Query = 'query',
  Fragment = 'fragment',
}

export interface RemoteExtensionConfigDiagnostic {
  /** Fixed values only: this object is safe to write to an operator log. */
  readonly code: RemoteExtensionConfigDiagnosticCode
  readonly variable: RemoteExtensionEnvironmentVariable | 'configuration'
}

export interface DisabledRemoteExtensionConfig {
  readonly status: 'disabled'
}

export interface InvalidRemoteExtensionConfig {
  readonly status: 'invalid'
  readonly diagnostic: RemoteExtensionConfigDiagnostic
}

export interface EnabledRemoteExtensionConfig {
  readonly status: 'enabled'
  /** Canonical WS/WSS base, without a trailing slash. */
  readonly publicWebSocketBaseUrl: string
  /** Canonical Host value, including a non-default port when configured. */
  readonly publicWebSocketAuthority: string
  /** Reverse-proxy prefix, empty at the authority root. */
  readonly publicWebSocketBasePath: string
  /** Canonical HTTP/HTTPS operator UI base, without a trailing slash. */
  readonly publicOperatorBaseUrl: string
  readonly publicOperatorAuthority: string
  readonly publicOperatorBasePath: string
}

export type RemoteExtensionConfig =
  | DisabledRemoteExtensionConfig
  | InvalidRemoteExtensionConfig
  | EnabledRemoteExtensionConfig

const issuedRemoteExtensionConfigs = new WeakSet<object>()

function issueConfig<T extends RemoteExtensionConfig>(config: T): T {
  issuedRemoteExtensionConfigs.add(config)
  return config
}

/**
 * Runtime capability check for consumers at the Host/route boundary. A parsed
 * configuration is process-local and ephemeral; copied, deserialized, or
 * structurally manufactured values are not safe substitutes because they can
 * bypass the parser's URL and all-or-nothing operator configuration checks.
 */
export function isIssuedRemoteExtensionConfig(
  value: unknown
): value is RemoteExtensionConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    issuedRemoteExtensionConfigs.has(value)
  )
}

const remoteExtensionEnvironmentSchema = z.object({
  [RemoteExtensionEnvironmentVariable.Enabled]: z.string().optional(),
  [RemoteExtensionEnvironmentVariable.PublicWebSocketUrl]: z
    .string()
    .optional(),
  [RemoteExtensionEnvironmentVariable.PublicOperatorUrl]: z.string().optional(),
  [RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp]: z
    .string()
    .optional(),
})

const DISABLED_CONFIG: DisabledRemoteExtensionConfig = issueConfig(
  Object.freeze({
    status: 'disabled',
  })
)

const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/iu
const PERCENT_TRIPLET = /%([0-9a-f]{2})/giu
const INVALID_PERCENT_ENCODING = /%(?![0-9a-f]{2})/iu

interface ParsedPublicUrl {
  readonly baseUrl: string
  readonly authority: string
  readonly basePath: string
}

type PublicUrlParseResult =
  | { readonly ok: true; readonly value: ParsedPublicUrl }
  | { readonly ok: false; readonly value: InvalidRemoteExtensionConfig }

function invalid(
  variable: RemoteExtensionConfigDiagnostic['variable'],
  code: RemoteExtensionConfigDiagnosticCode
): InvalidRemoteExtensionConfig {
  return issueConfig(
    Object.freeze({
      status: 'invalid',
      diagnostic: Object.freeze({ variable, code }),
    })
  )
}

function hasUserInfoSyntax(candidate: string): boolean {
  const schemeEnd = candidate.indexOf('://')
  if (schemeEnd === -1) return false

  const authorityStart = schemeEnd + 3
  const suffix = candidate.slice(authorityStart)
  const delimiterOffset = suffix.search(/[/?#]/u)
  const authority =
    delimiterOffset === -1 ? suffix : suffix.slice(0, delimiterOffset)
  return authority.includes('@')
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function hasEncodedPathSeparator(value: string): boolean {
  let candidate = value
  while (true) {
    if (ENCODED_PATH_SEPARATOR.test(candidate)) return true

    const decoded = candidate.replace(
      PERCENT_TRIPLET,
      (_triplet, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
    )
    if (decoded === candidate) return false
    candidate = decoded
  }
}

function canonicalBaseUrl(parsed: URL): ParsedPublicUrl {
  const basePath =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '')
  return {
    baseUrl: `${parsed.origin}${basePath}`,
    authority: parsed.host,
    basePath,
  }
}

function parsePublicUrl(
  rawValue: string | undefined,
  variable: RemoteExtensionEnvironmentVariable,
  allowedProtocols: readonly ('http:' | 'https:' | 'ws:' | 'wss:')[]
): PublicUrlParseResult {
  if (rawValue === undefined || rawValue.trim() === '') {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.MissingUrl),
    }
  }
  if (rawValue.length > REMOTE_EXTENSION_PUBLIC_URL_MAX_LENGTH) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.UrlTooLong),
    }
  }
  if (hasAsciiControlCharacter(rawValue)) {
    return {
      ok: false,
      value: invalid(
        variable,
        RemoteExtensionConfigDiagnosticCode.AsciiControlCharacter
      ),
    }
  }
  if (/\p{White_Space}/u.test(rawValue)) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Whitespace),
    }
  }
  if (rawValue.includes('\\')) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Backslash),
    }
  }
  if (hasEncodedPathSeparator(rawValue)) {
    return {
      ok: false,
      value: invalid(
        variable,
        RemoteExtensionConfigDiagnosticCode.EncodedPathSeparator
      ),
    }
  }
  if (INVALID_PERCENT_ENCODING.test(rawValue)) {
    return {
      ok: false,
      value: invalid(
        variable,
        RemoteExtensionConfigDiagnosticCode.InvalidPercentEncoding
      ),
    }
  }

  const candidate = rawValue
  if (hasUserInfoSyntax(candidate)) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.UserInfo),
    }
  }
  if (candidate.includes('?')) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Query),
    }
  }
  if (candidate.includes('#')) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Fragment),
    }
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.InvalidUrl),
    }
  }

  if (!allowedProtocols.some((protocol) => protocol === parsed.protocol)) {
    return {
      ok: false,
      value: invalid(
        variable,
        RemoteExtensionConfigDiagnosticCode.UnsupportedProtocol
      ),
    }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.UserInfo),
    }
  }
  if (parsed.search !== '') {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Query),
    }
  }
  if (parsed.hash !== '') {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.Fragment),
    }
  }

  const canonical = canonicalBaseUrl(parsed)
  if (canonical.baseUrl.length > REMOTE_EXTENSION_PUBLIC_URL_MAX_LENGTH) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.UrlTooLong),
    }
  }

  let reparsed: URL
  try {
    reparsed = new URL(canonical.baseUrl)
  } catch {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.InvalidUrl),
    }
  }
  if (canonicalBaseUrl(reparsed).baseUrl !== canonical.baseUrl) {
    return {
      ok: false,
      value: invalid(variable, RemoteExtensionConfigDiagnosticCode.InvalidUrl),
    }
  }

  return {
    ok: true,
    value: Object.freeze(canonical),
  }
}

function parseBooleanFlag(
  value: string | undefined,
  variable: RemoteExtensionEnvironmentVariable,
  invalidCode: RemoteExtensionConfigDiagnosticCode
): boolean | InvalidRemoteExtensionConfig {
  try {
    return parseServerBoolean(value, variable)
  } catch {
    return invalid(variable, invalidCode)
  }
}

/**
 * Parse the opt-in remote Extension surface without consulting process state.
 *
 * Invalid input is data, not an exception: callers keep the Extension routes
 * closed while the unrelated server surfaces continue to start. Unknown
 * variables, including legacy token and forwarded-host settings, are ignored.
 */
export function parseRemoteExtensionConfig(
  environment: RemoteExtensionEnvironment = {}
): RemoteExtensionConfig {
  try {
    const parsedEnvironment =
      remoteExtensionEnvironmentSchema.safeParse(environment)
    if (!parsedEnvironment.success) {
      return invalid(
        'configuration',
        RemoteExtensionConfigDiagnosticCode.InvalidEnvironment
      )
    }

    const enabled = parseBooleanFlag(
      parsedEnvironment.data[RemoteExtensionEnvironmentVariable.Enabled],
      RemoteExtensionEnvironmentVariable.Enabled,
      RemoteExtensionConfigDiagnosticCode.InvalidEnabledFlag
    )
    if (typeof enabled !== 'boolean') return enabled
    if (!enabled) return DISABLED_CONFIG

    const webSocket = parsePublicUrl(
      parsedEnvironment.data[
        RemoteExtensionEnvironmentVariable.PublicWebSocketUrl
      ],
      RemoteExtensionEnvironmentVariable.PublicWebSocketUrl,
      ['ws:', 'wss:']
    )
    if (!webSocket.ok) return webSocket.value

    const operator = parsePublicUrl(
      parsedEnvironment.data[
        RemoteExtensionEnvironmentVariable.PublicOperatorUrl
      ],
      RemoteExtensionEnvironmentVariable.PublicOperatorUrl,
      ['http:', 'https:']
    )
    if (!operator.ok) return operator.value

    const allowInsecureOperatorHttp = parseBooleanFlag(
      parsedEnvironment.data[
        RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp
      ],
      RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp,
      RemoteExtensionConfigDiagnosticCode.InvalidInsecureOperatorHttpFlag
    )
    if (typeof allowInsecureOperatorHttp !== 'boolean') {
      return allowInsecureOperatorHttp
    }
    if (
      operator.value.baseUrl.startsWith('http://') &&
      !allowInsecureOperatorHttp
    ) {
      return invalid(
        RemoteExtensionEnvironmentVariable.AllowInsecureOperatorHttp,
        RemoteExtensionConfigDiagnosticCode.InsecureOperatorHttpConsentRequired
      )
    }

    return issueConfig(
      Object.freeze({
        status: 'enabled',
        publicWebSocketBaseUrl: webSocket.value.baseUrl,
        publicWebSocketAuthority: webSocket.value.authority,
        publicWebSocketBasePath: webSocket.value.basePath,
        publicOperatorBaseUrl: operator.value.baseUrl,
        publicOperatorAuthority: operator.value.authority,
        publicOperatorBasePath: operator.value.basePath,
      })
    )
  } catch {
    return invalid(
      'configuration',
      RemoteExtensionConfigDiagnosticCode.InvalidEnvironment
    )
  }
}
