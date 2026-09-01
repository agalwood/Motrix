import { isCanonicalMbp1PairNonce } from '@core/bridge/mbp1/nonce-service'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'

const MAX_RAW_REQUEST_TARGET_LENGTH = 8_192

export type RemoteExtensionRoute = 'discovery' | 'nonce' | 'pair' | 'v1'

export interface RemoteExtensionRouteTargets {
  readonly discovery: string
  readonly nonce: string
  readonly pair: string
  readonly v1: string
}

export type RemoteExtensionRouteRejection =
  | 'feature-closed'
  | 'malformed-target'
  | 'unknown-route'
  | 'method-not-allowed'
  | 'transport-mismatch'
  | 'query-not-allowed'
  | 'malformed-pair-query'

export type RemoteExtensionRouteDecision =
  | {
      readonly ok: true
      readonly route: RemoteExtensionRoute
      readonly pairNonce?: string
    }
  | { readonly ok: false; readonly reason: RemoteExtensionRouteRejection }

function reject(
  reason: RemoteExtensionRouteRejection
): RemoteExtensionRouteDecision {
  return Object.freeze({ ok: false, reason })
}

function canonicalConfiguredBasePath(
  config: RemoteExtensionConfig
): string | null {
  if (!isIssuedRemoteExtensionConfig(config) || config.status !== 'enabled') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(config.publicWebSocketBaseUrl)
  } catch {
    return null
  }
  const basePath =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '')
  if (
    (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.host === '' ||
    parsed.host !== config.publicWebSocketAuthority ||
    `${parsed.origin}${basePath}` !== config.publicWebSocketBaseUrl ||
    basePath !== config.publicWebSocketBasePath
  ) {
    return null
  }
  return basePath
}

/**
 * Derive the only four public request paths from the canonical configured WS/WSS
 * base. The returned strings are raw-path match keys: a proxy must preserve
 * them byte-for-byte and must not decode, normalize, or strip the prefix.
 */
export function deriveRemoteExtensionRouteTargets(
  config: RemoteExtensionConfig
): RemoteExtensionRouteTargets | null {
  const prefix = canonicalConfiguredBasePath(config)
  if (prefix === null) return null
  return Object.freeze({
    discovery: `${prefix}/discovery`,
    nonce: `${prefix}/nonce`,
    pair: `${prefix}/pair`,
    v1: `${prefix}/v1`,
  })
}

function splitRawTarget(
  rawTarget: unknown
): { path: string; query: string | null } | null {
  if (typeof rawTarget !== 'string') return null
  let containsControlOrSpace = false
  for (let index = 0; index < rawTarget.length; index += 1) {
    const codePoint = rawTarget.charCodeAt(index)
    if (codePoint <= 0x20 || codePoint > 0x7e) {
      containsControlOrSpace = true
      break
    }
  }
  if (
    rawTarget.length === 0 ||
    rawTarget.length > MAX_RAW_REQUEST_TARGET_LENGTH ||
    rawTarget.includes('#') ||
    rawTarget.includes('\\') ||
    containsControlOrSpace
  ) {
    return null
  }
  const queryOffset = rawTarget.indexOf('?')
  return queryOffset === -1
    ? { path: rawTarget, query: null }
    : {
        path: rawTarget.slice(0, queryOffset),
        query: rawTarget.slice(queryOffset + 1),
      }
}

/**
 * Fail-closed request-target demultiplexer for the future public listener.
 *
 * This is deliberately pure and remains unwired. It compares the raw path,
 * before a framework or reverse proxy can turn encoded separators/dot segments
 * into an alias. `/pair` accepts one canonical base64url nonce query only;
 * `/v1` accepts no query, so a historical `?token=` can never select an auth
 * mode. Query rejection is not an authentication oracle: it occurs before an
 * MBP1 session or credential lookup exists.
 */
export function evaluateRemoteExtensionRoute(
  config: RemoteExtensionConfig,
  request: {
    readonly rawTarget: string
    readonly method: string
    readonly transport: 'http' | 'websocket'
  }
): RemoteExtensionRouteDecision {
  const routes = deriveRemoteExtensionRouteTargets(config)
  if (routes === null) return reject('feature-closed')
  let rawTarget: unknown
  let method: unknown
  let transport: unknown
  try {
    rawTarget = request?.rawTarget
    method = request?.method
    transport = request?.transport
  } catch {
    return reject('malformed-target')
  }
  const target = splitRawTarget(rawTarget)
  if (target === null) return reject('malformed-target')

  let route: RemoteExtensionRoute
  if (target.path === routes.discovery) route = 'discovery'
  else if (target.path === routes.nonce) route = 'nonce'
  else if (target.path === routes.pair) route = 'pair'
  else if (target.path === routes.v1) route = 'v1'
  else return reject('unknown-route')

  const expectsWebSocket = route === 'pair' || route === 'v1'
  if (transport !== (expectsWebSocket ? 'websocket' : 'http')) {
    return reject('transport-mismatch')
  }
  const expectedMethod = route === 'nonce' ? 'POST' : 'GET'
  if (method !== expectedMethod) return reject('method-not-allowed')

  if (route !== 'pair') {
    if (target.query !== null) return reject('query-not-allowed')
    return Object.freeze({ ok: true, route })
  }
  if (target.query === null || !target.query.startsWith('nonce=')) {
    return reject('malformed-pair-query')
  }
  const nonce = target.query.slice('nonce='.length)
  if (!isCanonicalMbp1PairNonce(nonce)) {
    return reject('malformed-pair-query')
  }
  return Object.freeze({ ok: true, route, pairNonce: nonce })
}
