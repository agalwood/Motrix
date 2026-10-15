import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Durable, authority-scoped consent for a remote Motrix Server.
 *
 * Pairing authenticates a Server; it does not authorize browser data to leave
 * this device. This store keeps that second decision separately and binds it
 * to both the opaque remote `BackendAuthority` and the instance identity that
 * MBP1 authenticated. A changed URL produces a different authority key, and a
 * changed instance id does not match the retained row, so both changes read as
 * the all-disabled policy.
 *
 * Production reads/writes are consumed through `withMutationBoundary()`, whose
 * ConnectionManager/endpoint-lifecycle caller revalidates the captured
 * `{endpointId, canonicalUrl, revision}` immediately before storage I/O.
 * Authority retirement also calls the global cleanup helper. This store cannot
 * observe endpoint revisions by itself, so direct mutation remains a test/core
 * primitive rather than a production authorization path.
 *
 * Persisted rows contain only an opaque authority key, an authenticated
 * instance id, a consent timestamp, and fixed boolean grants. In particular,
 * this store never writes a URL, token, cookie, header, or page payload.
 */

import {
  assertBackendAttemptMutationCapability,
  type BackendAttemptMutationCapability,
} from '@/background/EndpointCatalogService'
import {
  assertBackendAuthority,
  backendAuthorityKey,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

const STORAGE_KEY = 'motrix.remoteBackendPolicies'
export const REMOTE_BACKEND_POLICY_VERSION = 1 as const

const MAX_AUTHENTICATED_INSTANCE_ID_LENGTH = 128
const MAX_AUTHORITY_KEY_LENGTH = 8_192

export interface RemoteBackendPolicyV1 {
  readonly version: typeof REMOTE_BACKEND_POLICY_VERSION
  readonly authorityKey: string
  readonly authenticatedInstanceId: string
  readonly remoteDataBoundaryAcceptedAt: number | null
  readonly allowRequestCredentials: boolean
  readonly allowCustomHeaders: boolean
  readonly allowPageContent: boolean
  readonly allowServerUrlProbe: boolean
  readonly allowServerUrlResolve: boolean
  readonly allowAutomaticTakeover: boolean
}

/**
 * A complete replacement, never a patch. Authority and authenticated identity
 * come from the store's constructor so a caller cannot redirect a grant by
 * putting routing fields in the mutation payload.
 */
export type RemoteBackendPolicyReplacement = Pick<
  RemoteBackendPolicyV1,
  | 'remoteDataBoundaryAcceptedAt'
  | 'allowRequestCredentials'
  | 'allowCustomHeaders'
  | 'allowPageContent'
  | 'allowServerUrlProbe'
  | 'allowServerUrlResolve'
  | 'allowAutomaticTakeover'
>

export type RemoteBackendPolicyMutationBoundary =
  BackendAttemptMutationCapability

const leaseBoundRemoteBackendPolicyStoreBrand: unique symbol = Symbol(
  'LeaseBoundRemoteBackendPolicyStore'
)

export interface LeaseBoundRemoteBackendPolicyStore {
  readonly [leaseBoundRemoteBackendPolicyStoreBrand]: true
  get(): Promise<RemoteBackendPolicyV1>
  replace(value: RemoteBackendPolicyReplacement): Promise<void>
  clear(): Promise<void>
}

export interface RemoteBackendPolicyTestStore {
  get(): Promise<RemoteBackendPolicyV1>
  replace(value: RemoteBackendPolicyReplacement): Promise<void>
  clear(): Promise<void>
}

interface StoredRemoteBackendPolicySetV1 {
  version: typeof REMOTE_BACKEND_POLICY_VERSION
  policies: unknown[]
}

type StoredSetRead =
  | { kind: 'known'; set: StoredRemoteBackendPolicySetV1 }
  | { kind: 'future' }
  | { kind: 'corrupt' }

const POLICY_KEYS = new Set<keyof RemoteBackendPolicyV1>([
  'version',
  'authorityKey',
  'authenticatedInstanceId',
  'remoteDataBoundaryAcceptedAt',
  'allowRequestCredentials',
  'allowCustomHeaders',
  'allowPageContent',
  'allowServerUrlProbe',
  'allowServerUrlResolve',
  'allowAutomaticTakeover',
])

const REPLACEMENT_KEYS = new Set<keyof RemoteBackendPolicyReplacement>([
  'remoteDataBoundaryAcceptedAt',
  'allowRequestCredentials',
  'allowCustomHeaders',
  'allowPageContent',
  'allowServerUrlProbe',
  'allowServerUrlResolve',
  'allowAutomaticTakeover',
])

const CONTAINER_KEYS = new Set(['version', 'policies'])

// Every instance addresses one extension-wide storage key. Keeping the queue
// at module scope prevents two accidental store instances from losing each
// other's read-modify-write update, and the queue remains usable after failure.
const enqueueRemoteBackendPolicyOperation = createOperationQueue()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function isPrintableAscii(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function isAuthenticatedInstanceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isPrintableAscii(value, MAX_AUTHENTICATED_INSTANCE_ID_LENGTH)
  )
}

function isAttributableAuthorityKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUTHORITY_KEY_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

function authorityKeyOf(value: unknown): string | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'authorityKey')) return null
  return isAttributableAuthorityKey(value.authorityKey)
    ? value.authorityKey
    : null
}

function isConsentTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
}

function hasSensitiveGrant(policy: RemoteBackendPolicyReplacement): boolean {
  return (
    policy.allowRequestCredentials ||
    policy.allowCustomHeaders ||
    policy.allowPageContent ||
    policy.allowServerUrlProbe ||
    policy.allowServerUrlResolve ||
    policy.allowAutomaticTakeover
  )
}

function readPolicy(value: unknown): RemoteBackendPolicyV1 | null {
  if (!isRecord(value) || !hasExactOwnKeys(value, POLICY_KEYS)) return null
  if (
    value.version !== REMOTE_BACKEND_POLICY_VERSION ||
    !isAttributableAuthorityKey(value.authorityKey) ||
    !isAuthenticatedInstanceId(value.authenticatedInstanceId) ||
    !isConsentTimestamp(value.remoteDataBoundaryAcceptedAt) ||
    typeof value.allowRequestCredentials !== 'boolean' ||
    typeof value.allowCustomHeaders !== 'boolean' ||
    typeof value.allowPageContent !== 'boolean' ||
    typeof value.allowServerUrlProbe !== 'boolean' ||
    typeof value.allowServerUrlResolve !== 'boolean' ||
    typeof value.allowAutomaticTakeover !== 'boolean'
  ) {
    return null
  }

  const policy: RemoteBackendPolicyV1 = {
    version: REMOTE_BACKEND_POLICY_VERSION,
    authorityKey: value.authorityKey,
    authenticatedInstanceId: value.authenticatedInstanceId,
    remoteDataBoundaryAcceptedAt: value.remoteDataBoundaryAcceptedAt,
    allowRequestCredentials: value.allowRequestCredentials,
    allowCustomHeaders: value.allowCustomHeaders,
    allowPageContent: value.allowPageContent,
    allowServerUrlProbe: value.allowServerUrlProbe,
    allowServerUrlResolve: value.allowServerUrlResolve,
    allowAutomaticTakeover: value.allowAutomaticTakeover,
  }
  if (
    policy.remoteDataBoundaryAcceptedAt === null &&
    hasSensitiveGrant(policy)
  ) {
    return null
  }
  return policy
}

function readStoredSet(value: unknown, present: boolean): StoredSetRead {
  if (!present) {
    return {
      kind: 'known',
      set: { version: REMOTE_BACKEND_POLICY_VERSION, policies: [] },
    }
  }
  if (!isRecord(value)) return { kind: 'corrupt' }

  // An unknown version is opaque regardless of its remaining shape. Never try
  // to normalize or partially understand data owned by a future implementation.
  if (
    !Object.hasOwn(value, 'version') ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    return { kind: 'corrupt' }
  }
  if (value.version !== REMOTE_BACKEND_POLICY_VERSION) {
    return { kind: 'future' }
  }
  if (
    !hasExactOwnKeys(value, CONTAINER_KEYS) ||
    !Array.isArray(value.policies)
  ) {
    return { kind: 'corrupt' }
  }

  // A malformed policy is safely isolated only if its authority is still
  // unambiguous. Without that key, no mutation can prove which scope it would
  // delete, so the entire container remains opaque and preserved.
  if (value.policies.some((policy) => authorityKeyOf(policy) === null)) {
    return { kind: 'corrupt' }
  }
  return {
    kind: 'known',
    set: {
      version: REMOTE_BACKEND_POLICY_VERSION,
      policies: value.policies,
    },
  }
}

function validateReplacement(
  value: RemoteBackendPolicyReplacement
): RemoteBackendPolicyReplacement {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, REPLACEMENT_KEYS) ||
    !isConsentTimestamp(value.remoteDataBoundaryAcceptedAt) ||
    typeof value.allowRequestCredentials !== 'boolean' ||
    typeof value.allowCustomHeaders !== 'boolean' ||
    typeof value.allowPageContent !== 'boolean' ||
    typeof value.allowServerUrlProbe !== 'boolean' ||
    typeof value.allowServerUrlResolve !== 'boolean' ||
    typeof value.allowAutomaticTakeover !== 'boolean'
  ) {
    throw new InvalidRemoteBackendPolicyError()
  }

  const replacement: RemoteBackendPolicyReplacement = {
    remoteDataBoundaryAcceptedAt: value.remoteDataBoundaryAcceptedAt,
    allowRequestCredentials: value.allowRequestCredentials,
    allowCustomHeaders: value.allowCustomHeaders,
    allowPageContent: value.allowPageContent,
    allowServerUrlProbe: value.allowServerUrlProbe,
    allowServerUrlResolve: value.allowServerUrlResolve,
    allowAutomaticTakeover: value.allowAutomaticTakeover,
  }
  if (
    replacement.remoteDataBoundaryAcceptedAt === null &&
    hasSensitiveGrant(replacement)
  ) {
    throw new RemoteDataBoundaryRequiredError()
  }
  return replacement
}

async function loadStoredSet(forMutation: boolean): Promise<StoredSetRead> {
  const object = (await browser.storage.local.get(STORAGE_KEY)) as Record<
    string,
    unknown
  >
  const result = readStoredSet(
    object[STORAGE_KEY],
    Object.hasOwn(object, STORAGE_KEY)
  )
  if (forMutation && result.kind === 'future') {
    throw new UnsupportedRemoteBackendPolicyVersionError()
  }
  if (forMutation && result.kind === 'corrupt') {
    throw new CorruptRemoteBackendPolicyStoreError()
  }
  return result
}

async function persistPolicies(policies: unknown[]): Promise<void> {
  if (policies.length === 0) {
    await browser.storage.local.remove(STORAGE_KEY)
    return
  }
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      version: REMOTE_BACKEND_POLICY_VERSION,
      policies,
    } satisfies StoredRemoteBackendPolicySetV1,
  })
}

/** Fixed errors never include persisted data or caller-controlled identity. */
export class RemoteBackendPolicyRequiresRemoteAuthorityError extends Error {
  constructor() {
    super('remote backend policy requires a module-issued remote authority')
  }
}

export class InvalidAuthenticatedInstanceIdError extends Error {
  constructor() {
    super('authenticated instance id is outside the accepted printable form')
  }
}

export class InvalidRemoteBackendPolicyError extends Error {
  constructor() {
    super('remote backend policy replacement is invalid')
  }
}

export class RemoteDataBoundaryRequiredError extends Error {
  constructor() {
    super('remote data boundary consent is required before granting access')
  }
}

export class UnsupportedRemoteBackendPolicyVersionError extends Error {
  constructor() {
    super('remote backend policy store version is unsupported')
  }
}

export class CorruptRemoteBackendPolicyStoreError extends Error {
  constructor() {
    super('remote backend policy store is corrupt')
  }
}

function authorityKeyFromRemoteAuthority(
  authority: RemoteBackendAuthority
): string {
  assertBackendAuthority(authority)
  if (authority.kind !== 'remote') {
    throw new RemoteBackendPolicyRequiresRemoteAuthorityError()
  }
  return backendAuthorityKey(authority)
}

async function clearPoliciesForAuthorityKey(
  authorityKey: string
): Promise<void> {
  return enqueueRemoteBackendPolicyOperation(async () => {
    const result = await loadStoredSet(true)
    if (result.kind !== 'known') {
      throw new CorruptRemoteBackendPolicyStoreError()
    }
    const policies = result.set.policies.filter(
      (policy) => authorityKeyOf(policy) !== authorityKey
    )
    if (policies.length === result.set.policies.length) return
    await persistPolicies(policies)
  })
}

export async function clearRemoteBackendPoliciesForAuthority(
  authority: RemoteBackendAuthority
): Promise<void> {
  await clearPoliciesForAuthorityKey(authorityKeyFromRemoteAuthority(authority))
}

class RemoteBackendPolicyStoreCore implements RemoteBackendPolicyTestStore {
  private readonly authorityKey: string
  private readonly authenticatedInstanceId: string

  constructor(
    authority: RemoteBackendAuthority,
    authenticatedInstanceId: string
  ) {
    const authorityKey = authorityKeyFromRemoteAuthority(authority)
    if (!isAuthenticatedInstanceId(authenticatedInstanceId)) {
      throw new InvalidAuthenticatedInstanceIdError()
    }
    this.authorityKey = authorityKey
    this.authenticatedInstanceId = authenticatedInstanceId
  }

  /**
   * Return this exact authority/identity policy. Missing, mismatched,
   * malformed, duplicate, future-version, and corrupt state all read as a
   * fresh policy with every permission disabled.
   */
  async get(): Promise<RemoteBackendPolicyV1> {
    return enqueueRemoteBackendPolicyOperation(async () => {
      const result = await loadStoredSet(false)
      const fallback = this.defaultPolicy()
      if (result.kind !== 'known') return fallback

      let matched: RemoteBackendPolicyV1 | null = null
      let matches = 0
      for (const rawPolicy of result.set.policies) {
        if (authorityKeyOf(rawPolicy) !== this.authorityKey) continue
        matches += 1
        if (matches > 1) return fallback
        matched = readPolicy(rawPolicy)
      }
      if (
        matches !== 1 ||
        matched === null ||
        matched.authenticatedInstanceId !== this.authenticatedInstanceId
      ) {
        return fallback
      }
      return { ...matched }
    })
  }

  /**
   * Replace every grant for this authority with one complete policy bound to
   * this authenticated instance.
   *
   * Coordinator-only in production: the future lifecycle coordinator must
   * first revalidate its captured `{endpointId, canonicalUrl, revision}`.
   * Calling this primitive directly cannot prevent an old async attempt from
   * writing after endpoint replacement.
   */
  async replace(value: RemoteBackendPolicyReplacement): Promise<void> {
    const replacement = validateReplacement(value)
    return enqueueRemoteBackendPolicyOperation(async () => {
      const result = await loadStoredSet(true)
      if (result.kind !== 'known') {
        // `loadStoredSet(true)` throws for both non-known states. Keep this
        // branch for exhaustive narrowing if that implementation changes.
        throw new CorruptRemoteBackendPolicyStoreError()
      }
      const policies = result.set.policies.filter(
        (policy) => authorityKeyOf(policy) !== this.authorityKey
      )
      policies.push({
        version: REMOTE_BACKEND_POLICY_VERSION,
        authorityKey: this.authorityKey,
        authenticatedInstanceId: this.authenticatedInstanceId,
        ...replacement,
      } satisfies RemoteBackendPolicyV1)
      await persistPolicies(policies)
    })
  }

  /**
   * Remove every retained identity/policy for this authority, leaving all
   * other authorities byte-for-byte untouched.
   *
   * Coordinator-only in production, under the same captured endpoint revision
   * rule as `replace`; this primitive does not make endpoint deletion durable.
   */
  async clear(): Promise<void> {
    await clearPoliciesForAuthorityKey(this.authorityKey)
  }

  /** Remote production consumers use this facade so every read/grant/clear is
   * revalidated against the same endpoint revision immediately before I/O. */
  withMutationBoundary(
    boundary: RemoteBackendPolicyMutationBoundary
  ): LeaseBoundRemoteBackendPolicyStore {
    return Object.freeze({
      [leaseBoundRemoteBackendPolicyStoreBrand]: true as const,
      get: () => boundary.run(() => this.get()),
      replace: (value: RemoteBackendPolicyReplacement) =>
        boundary.run(() => this.replace(value)),
      clear: () => boundary.run(() => this.clear()),
    })
  }

  private defaultPolicy(): RemoteBackendPolicyV1 {
    return {
      version: REMOTE_BACKEND_POLICY_VERSION,
      authorityKey: this.authorityKey,
      authenticatedInstanceId: this.authenticatedInstanceId,
      remoteDataBoundaryAcceptedAt: null,
      allowRequestCredentials: false,
      allowCustomHeaders: false,
      allowPageContent: false,
      allowServerUrlProbe: false,
      allowServerUrlResolve: false,
      allowAutomaticTakeover: false,
    }
  }
}

/** The only production constructor: every operation re-enters the caller's
 * nominal endpoint-attempt lease immediately before storage I/O. */
export function createLeaseBoundRemoteBackendPolicyStore(
  authority: RemoteBackendAuthority,
  authenticatedInstanceId: string,
  boundary: RemoteBackendPolicyMutationBoundary
): LeaseBoundRemoteBackendPolicyStore {
  assertBackendAttemptMutationCapability(boundary)
  return new RemoteBackendPolicyStoreCore(
    authority,
    authenticatedInstanceId
  ).withMutationBoundary(boundary)
}

/** Raw storage-core primitive for tests only. Production use is rejected by
 * scripts/check-imports.mjs. */
export function createRemoteBackendPolicyStoreForTest(
  authority: RemoteBackendAuthority,
  authenticatedInstanceId: string
): RemoteBackendPolicyTestStore {
  return new RemoteBackendPolicyStoreCore(authority, authenticatedInstanceId)
}
