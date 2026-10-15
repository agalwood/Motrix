/**
 * Pure remote MBP1 route derivation.
 *
 * Routes are transport locations, never authenticated identity. The peer is
 * trusted only after MBP1 succeeds and proves the pinned server identity.
 */
import {
  assertBackendAuthority,
  createRemoteBackendAuthority,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'

const BRIDGE_ROUTE_BRAND: unique symbol = Symbol('motrix.mbp1.bridge-route')
const issuedRoutes = new WeakSet<object>()
const CANONICAL_MBP1_PAIR_NONCE = /^[A-Za-z0-9_-]{21}[AQgw]$/u

/**
 * The formal remote route. Local NM/port routing remains outside this slice.
 *
 * A route is an ephemeral, module-issued runtime value. It MUST NOT be
 * persisted or reconstructed from JSON: serialization drops its private brand
 * and the deserialized object is intentionally rejected. Persist the backend
 * configuration instead, rebuild its authority, then derive a fresh route.
 */
export interface BridgeRoute {
  readonly [BRIDGE_ROUTE_BRAND]: true
  readonly authority: RemoteBackendAuthority
  readonly discoveryUrl: string
  readonly nonceUrl: string
  readonly v1Url: string
}

export type RemoteBridgeRoute = BridgeRoute

/** MBP1 v1 `/nonce` is the unpadded canonical base64url encoding of exactly
 * 16 random bytes. The final alphabet restriction rejects alternate encodings
 * whose unused low four bits are non-zero. */
export function isCanonicalMbp1PairNonce(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_MBP1_PAIR_NONCE.test(value)
}

function normalizeAuthority(
  authority: RemoteBackendAuthority
): RemoteBackendAuthority {
  assertBackendAuthority(authority)
  if (authority.kind !== 'remote') {
    throw new Error('remote BridgeRoute requires a remote BackendAuthority')
  }

  return createRemoteBackendAuthority({
    endpointId: authority.endpointId,
    wsBase: authority.canonicalWsBase,
  })
}

/**
 * Derive HTTP discovery/nonce and websocket reconnect endpoints from one
 * canonical WS/WSS base. A reverse-proxy prefix remains part of every route.
 */
export function deriveRemoteBridgeRoute(
  authority: RemoteBackendAuthority
): BridgeRoute {
  const normalized = normalizeAuthority(authority)
  const wsBase = normalized.canonicalWsBase
  const websocketUrl = new URL(wsBase)
  const httpBase = `${websocketUrl.protocol === 'wss:' ? 'https:' : 'http:'}${wsBase.slice(websocketUrl.protocol.length)}`

  const route: BridgeRoute = Object.freeze({
    [BRIDGE_ROUTE_BRAND]: true as const,
    authority: normalized,
    discoveryUrl: `${httpBase}/discovery`,
    nonceUrl: `${httpBase}/nonce`,
    v1Url: `${wsBase}/v1`,
  })
  issuedRoutes.add(route)
  return route
}

/** Build the first-pair route. The query contains only the encoded nonce. */
export function remotePairUrl(route: BridgeRoute, nonce: string): string {
  if (!issuedRoutes.has(route) || route[BRIDGE_ROUTE_BRAND] !== true) {
    throw new Error('BridgeRoute must be created by deriveRemoteBridgeRoute')
  }

  // Revalidate the authority as defense in depth. The issued route is frozen,
  // but pair URL derivation must remain rooted in the authority, never in a
  // caller-supplied route URL field.
  const authority = normalizeAuthority(route.authority)
  if (!isCanonicalMbp1PairNonce(nonce)) {
    throw new Error('MBP1 pair nonce is not canonical')
  }
  return `${authority.canonicalWsBase}/pair?nonce=${nonce}`
}
