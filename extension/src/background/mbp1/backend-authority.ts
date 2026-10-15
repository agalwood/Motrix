/**
 * Backend trust/routing authority for MBP1 client state.
 *
 * This is a client-local namespace only. It is deliberately separate from
 * MBP1's `Principal` and MUST NOT be added to A_id, B_id, RT, or another wire
 * transcript. A browser profile remains the same principal when it connects
 * to two backends; the authority prevents those backends from sharing the
 * principal's credentials, pins, or recovery state locally.
 */
import { b64uEncode, concatBytes, enc } from '@/background/mbp1/canonical'
import { normalizeRemoteEndpoint } from '@/shared/endpoint'

const BACKEND_AUTHORITY_BRAND: unique symbol = Symbol(
  'motrix.mbp1.backend-authority'
)
const issuedAuthorities = new WeakSet<object>()

export interface LocalBackendAuthority {
  readonly [BACKEND_AUTHORITY_BRAND]: true
  readonly kind: 'local'
}

export interface RemoteBackendAuthority {
  readonly [BACKEND_AUTHORITY_BRAND]: true
  readonly kind: 'remote'
  readonly endpointId: string
  readonly canonicalWsBase: string
}

export type BackendAuthority = LocalBackendAuthority | RemoteBackendAuthority

function issueAuthority<T extends BackendAuthority>(authority: T): T {
  const frozen = Object.freeze(authority)
  issuedAuthorities.add(frozen)
  return frozen
}

export const LOCAL_BACKEND_AUTHORITY: LocalBackendAuthority = issueAuthority({
  [BACKEND_AUTHORITY_BRAND]: true,
  kind: 'local',
})

export interface RemoteBackendAuthorityInput {
  endpointId: string
  wsBase: string
}

const AUTHORITY_KEY_DOMAIN = 'MBP1/backend-authority/v1'
const MAX_ENDPOINT_ID_LENGTH = 128
const MAX_REMOTE_URL_LENGTH = 4096
const ENCODED_PATH_SEPARATOR_RE = /%(?:2f|5c)/i

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validateEndpointId(endpointId: string): void {
  if (endpointId.length === 0 || endpointId.trim() !== endpointId) {
    throw new Error('endpointId must be non-empty and already trimmed')
  }
  if (
    endpointId.length > MAX_ENDPOINT_ID_LENGTH ||
    hasAsciiControl(endpointId)
  ) {
    throw new Error('endpointId is outside the accepted ASCII identifier form')
  }

  // `backendAuthorityKey` uses canonical `enc(string)`. Validate at the model
  // boundary so every constructed authority is guaranteed to be keyable.
  enc(endpointId)
}

function normalizeRemoteAuthorityFields(
  input: RemoteBackendAuthorityInput
): Pick<RemoteBackendAuthority, 'endpointId' | 'canonicalWsBase'> {
  validateEndpointId(input.endpointId)

  if (
    input.wsBase.length > MAX_REMOTE_URL_LENGTH ||
    input.wsBase.length === 0 ||
    input.wsBase.includes('\\') ||
    hasAsciiControl(input.wsBase) ||
    /\p{White_Space}/u.test(input.wsBase) ||
    ENCODED_PATH_SEPARATOR_RE.test(input.wsBase)
  ) {
    throw new Error('remote MBP1 authority URL is ambiguous or too long')
  }

  const canonicalWsBase = normalizeRemoteEndpoint(input.wsBase)
  if (
    canonicalWsBase.length > MAX_REMOTE_URL_LENGTH ||
    normalizeRemoteEndpoint(canonicalWsBase) !== canonicalWsBase
  ) {
    throw new Error('remote MBP1 authority URL is not canonical')
  }

  // URL serialization makes host names and paths ASCII, but checking through
  // the same encoder used by the key keeps that invariant explicit.
  enc(canonicalWsBase)
  return { endpointId: input.endpointId, canonicalWsBase }
}

/**
 * Assert that an authority is an ephemeral value issued by this module.
 *
 * Authorities MUST NOT be persisted or reconstructed from messages/JSON.
 * Persist endpoint configuration, then call the appropriate authority factory
 * after reading it. Copies are rejected even if they carry the private symbol.
 */
export function assertBackendAuthority(
  value: unknown
): asserts value is BackendAuthority {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedAuthorities.has(value) ||
    (value as { [BACKEND_AUTHORITY_BRAND]?: unknown })[
      BACKEND_AUTHORITY_BRAND
    ] !== true
  ) {
    throw new Error('BackendAuthority must be created by its module factory')
  }
}

/**
 * Construct the only supported remote authority: an explicitly configured,
 * explicitly configured websocket base. The scheme is part of the authority,
 * so switching between WS and WSS cannot reuse credentials accidentally.
 * Display names are intentionally absent from this type and therefore cannot
 * affect credential scope.
 */
export function createRemoteBackendAuthority(
  input: RemoteBackendAuthorityInput
): RemoteBackendAuthority {
  const normalized = normalizeRemoteAuthorityFields(input)

  return issueAuthority({
    [BACKEND_AUTHORITY_BRAND]: true,
    kind: 'remote',
    ...normalized,
  })
}

/**
 * Stable, injective client-storage key for one backend authority.
 *
 * Every field is independently length-prefixed. A delimiter join would let
 * an endpoint id containing the delimiter move the apparent field boundary
 * and collide with another `{endpointId, canonicalWsBase}` pair.
 */
export function backendAuthorityKey(authority: BackendAuthority): string {
  assertBackendAuthority(authority)
  if (authority.kind === 'local') {
    return b64uEncode(concatBytes(enc(AUTHORITY_KEY_DOMAIN), enc('local')))
  }

  // Re-normalize after issuance validation as defense in depth. A factory
  // value is frozen, but key derivation must remain bound to canonical fields.
  const remote = normalizeRemoteAuthorityFields({
    endpointId: authority.endpointId,
    wsBase: authority.canonicalWsBase,
  })
  return b64uEncode(
    concatBytes(
      enc(AUTHORITY_KEY_DOMAIN),
      enc('remote'),
      enc(remote.endpointId),
      enc(remote.canonicalWsBase)
    )
  )
}
