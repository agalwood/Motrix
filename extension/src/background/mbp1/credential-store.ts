import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Durable MBP1 client credentials (bridge-pairing-protocol.md §6.7, §12).
 *
 * The wire principal identifies the browser profile. `BackendAuthority` is a
 * separate, client-local namespace which prevents two Motrix backends from
 * sharing credentials for that principal. Authentication stays below MDXP;
 * neither the authority nor its storage key is added to the MBP1 transcript.
 *
 * Every operation is serialized by one module-level queue. This is deliberate:
 * browser wiring should create one root store, but an accidental second root
 * must not turn two read-modify-write operations into a lost update.
 */

import {
  assertBackendAttemptMutationCapability,
  type BackendAttemptMutationCapability,
} from '@/background/EndpointCatalogService'
import {
  type BackendAuthority,
  backendAuthorityKey,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { b64uEncode, concatBytes, enc } from '@/background/mbp1/canonical'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

/** §6.7 wire principal. A second browser profile is a new principal. */
export interface Principal {
  browser: string
  verifiedOrigin: string
  clientInstallationId: string
}

export type CredentialState = 'provisional' | 'committed'
export type ProvisionalSub = 'unacked' | 'commit-uncertain'

/**
 * Credential returned to pairing/reconnect code.
 *
 * `authenticatedInstanceId` remains optional in the public type so existing
 * test doubles and the temporary local facade keep compiling. An authority
 * view always returns the property. Persisted v2 entries always contain it.
 */
export interface StoredCredential {
  credentialId: string
  mutualKey: string
  principalKey: string
  state: CredentialState
  /** Present exactly when `state === 'provisional'`. */
  sub?: ProvisionalSub
  createdAt: number
  authenticatedInstanceId?: string | null
}

const credentialLifecycleStoreBrand: unique symbol = Symbol(
  'CredentialLifecycleStore'
)

/** Durable lifecycle surface consumed by pair/reconnect flows. */
export interface CredentialLifecycleStore {
  /** Nominal scope proof. Only an authority view issued by this module has it. */
  readonly [credentialLifecycleStoreBrand]: true
  writeProvisionalUnacked(
    principal: Principal,
    cred: { credentialId: string; mutualKey: string },
    authenticatedInstanceId: string | null
  ): Promise<void>
  markCommitUncertain(credentialId: string): Promise<void>
  commitAndActivate(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null
  ): Promise<void>
  finalizeAndPrune(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]>
  prunePrincipalExcept(
    principal: Principal,
    keepCredentialId: string,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]>
}

/** Complete connection-attempt view. Every mutating method is rebound to the
 * same endpoint lease; callers cannot retain an unguarded authority writer. */
export interface CredentialAttemptStore extends CredentialLifecycleStore {
  recoverOrder(principal: Principal): Promise<StoredCredential[]>
  hasCommittedCredential(principal: Principal): Promise<boolean>
  revokeAll(
    principal: Principal,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]>
  ageOutUnacked(now: number): Promise<void>
  cleanupFirstPairOrphans(principal: Principal, now: number): Promise<void>
}

/** A coordinator-owned critical section. Both local and remote connection
 * attempts bind this to one module-issued BackendAttemptLease. */
export type CredentialMutationBoundary = BackendAttemptMutationCapability

interface PersistedCredential {
  authorityKey: string
  credentialId: string
  mutualKey: string
  principalKey: string
  state: CredentialState
  sub?: ProvisionalSub
  createdAt: number
  authenticatedInstanceId: string | null
}

interface StoredCredentialSetV1 {
  version: 1
  credentials: StoredCredential[]
  activeCredentialId: string | null
}

interface StoredCredentialSetV2 {
  version: 2
  credentials: PersistedCredential[]
  activeCredentialIds: Record<string, string>
}

type ReadResult =
  | { kind: 'known'; set: StoredCredentialSetV2 }
  | { kind: 'legacy'; set: StoredCredentialSetV2 }
  | { kind: 'future' }
  | { kind: 'corrupt' }

const STORAGE_KEY = 'motrix.mbp1.credentials'
const PROVISIONAL_TTL_MS = 10 * 60_000
const MAX_INSTANCE_ID_LENGTH = 128
const ACTIVE_KEY_DOMAIN = 'MBP1/credential-active/v2'
const enqueueCredentialOperation = createOperationQueue()

const LOCAL_AUTHORITY_KEY = backendAuthorityKey(LOCAL_BACKEND_AUTHORITY)
const issuedCredentialLifecycleStores = new WeakSet<object>()

interface AuthorityRevocationState {
  generation: number
  revoking: boolean
}

/**
 * Process-local lifecycle fence. Durable endpoint state remains the
 * coordinator's responsibility, but this closes the in-realm queue race:
 * work issued by a stale authority view can never run after Forget finishes.
 */
const authorityRevocationStates = new Map<string, AuthorityRevocationState>()

function authorityRevocationState(
  authorityKey: string
): AuthorityRevocationState {
  return (
    authorityRevocationStates.get(authorityKey) ?? {
      generation: 0,
      revoking: false,
    }
  )
}

function beginAuthorityRevocation(authorityKey: string): number {
  const generation = authorityRevocationState(authorityKey).generation + 1
  authorityRevocationStates.set(authorityKey, {
    generation,
    revoking: true,
  })
  return generation
}

function finishAuthorityRevocation(
  authorityKey: string,
  generation: number
): void {
  const current = authorityRevocationState(authorityKey)
  if (current.generation !== generation) return
  authorityRevocationStates.set(authorityKey, {
    generation,
    revoking: false,
  })
}

/** Stable, injective storage key for a wire principal. */
export function principalKey(p: Principal): string {
  return b64uEncode(
    concatBytes(
      enc(p.browser),
      enc(p.verifiedOrigin),
      enc(p.clientInstallationId)
    )
  )
}

/** Stable, injective map key for `{authorityKey, principalKey}`. */
function activeCredentialMapKey(
  authorityKey: string,
  ownerPrincipalKey: string
): string {
  return b64uEncode(
    concatBytes(
      enc(ACTIVE_KEY_DOMAIN),
      enc(authorityKey),
      enc(ownerPrincipalKey)
    )
  )
}

function tupleKey(left: string, right: string): string {
  return JSON.stringify([left, right])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isEncodableNonEmptyString(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  try {
    enc(value)
    return true
  } catch {
    return false
  }
}

function isNullableInstanceId(value: unknown): value is string | null {
  return (
    value === null ||
    (isEncodableNonEmptyString(value) && value.length <= MAX_INSTANCE_ID_LENGTH)
  )
}

type CredentialBase = Omit<StoredCredential, 'authenticatedInstanceId'>

/** Read the state-machine fields shared by v1 and v2. */
function readCredentialBase(value: unknown): CredentialBase | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<CredentialBase>
  if (
    !isNonEmptyString(raw.credentialId) ||
    !isNonEmptyString(raw.mutualKey) ||
    !isEncodableNonEmptyString(raw.principalKey) ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt)
  ) {
    return null
  }

  const base = {
    credentialId: raw.credentialId,
    mutualKey: raw.mutualKey,
    principalKey: raw.principalKey,
    createdAt: raw.createdAt,
  }
  if (raw.state === 'committed') {
    return { ...base, state: 'committed' }
  }
  if (
    raw.state === 'provisional' &&
    (raw.sub === 'unacked' || raw.sub === 'commit-uncertain')
  ) {
    return { ...base, state: 'provisional', sub: raw.sub }
  }
  return null
}

function readV2Credential(value: unknown): PersistedCredential | null {
  const base = readCredentialBase(value)
  if (base === null || !value || typeof value !== 'object') return null
  const raw = value as {
    authorityKey?: unknown
    authenticatedInstanceId?: unknown
  }
  if (
    !isEncodableNonEmptyString(raw.authorityKey) ||
    !isNullableInstanceId(raw.authenticatedInstanceId)
  ) {
    return null
  }
  // v1 is migrated only into the one known local authority. Every non-local
  // v2 row therefore represents a remote authority and must carry the server
  // identity authenticated by confirmB/reconnectAccept. Retaining a null row
  // would hide it from recovery while still letting it occupy a state-machine
  // slot indefinitely.
  if (
    raw.authorityKey !== LOCAL_AUTHORITY_KEY &&
    raw.authenticatedInstanceId === null
  ) {
    return null
  }
  return {
    ...base,
    authorityKey: raw.authorityKey,
    authenticatedInstanceId: raw.authenticatedInstanceId,
  }
}

/**
 * Parse entries independently. If persisted data contains two rows for the
 * same `{authority, credentialId}`, both are dropped: choosing one could pick
 * attacker-controlled key material. An unrelated valid entry still survives.
 */
function readV2Set(
  value: Record<string, unknown>
): StoredCredentialSetV2 | null {
  if (
    !Array.isArray(value.credentials) ||
    !value.activeCredentialIds ||
    typeof value.activeCredentialIds !== 'object' ||
    Array.isArray(value.activeCredentialIds)
  ) {
    return null
  }
  const byIdentity = new Map<string, PersistedCredential | null>()
  const rawCredentials = value.credentials
  for (const raw of rawCredentials) {
    const credential = readV2Credential(raw)
    if (credential === null) continue
    const identity = tupleKey(credential.authorityKey, credential.credentialId)
    if (byIdentity.has(identity)) {
      byIdentity.set(identity, null)
    } else {
      byIdentity.set(identity, credential)
    }
  }

  const credentials = [...byIdentity.values()].filter(
    (credential): credential is PersistedCredential => credential !== null
  )
  const rawActiveCredentialIds = value.activeCredentialIds as Record<
    string,
    unknown
  >
  const activeCredentialIds: Record<string, string> = {}
  for (const credential of credentials) {
    if (credential.state !== 'committed') continue
    const key = activeCredentialMapKey(
      credential.authorityKey,
      credential.principalKey
    )
    if (rawActiveCredentialIds[key] === credential.credentialId) {
      activeCredentialIds[key] = credential.credentialId
    }
  }
  return sanitizeSet({ version: 2, credentials, activeCredentialIds })
}

/** Safely migrates every provable v1 credential into the local authority. */
function readV1Set(value: Record<string, unknown>): StoredCredentialSetV2 {
  const legacy = value as Partial<StoredCredentialSetV1>
  const byId = new Map<string, CredentialBase | null>()
  const rawCredentials = Array.isArray(legacy.credentials)
    ? legacy.credentials
    : []
  for (const raw of rawCredentials) {
    const credential = readCredentialBase(raw)
    if (credential === null) continue
    if (byId.has(credential.credentialId)) {
      byId.set(credential.credentialId, null)
    } else {
      byId.set(credential.credentialId, credential)
    }
  }

  const credentials: PersistedCredential[] = [...byId.values()]
    .filter((credential): credential is CredentialBase => credential !== null)
    .map((credential) => ({
      ...credential,
      authorityKey: LOCAL_AUTHORITY_KEY,
      authenticatedInstanceId: null,
    }))

  const activeCredentialIds: Record<string, string> = {}
  if (isNonEmptyString(legacy.activeCredentialId)) {
    const target = credentials.find(
      (credential) =>
        credential.credentialId === legacy.activeCredentialId &&
        credential.state === 'committed'
    )
    if (target !== undefined) {
      activeCredentialIds[
        activeCredentialMapKey(LOCAL_AUTHORITY_KEY, target.principalKey)
      ] = target.credentialId
    }
  }
  return { version: 2, credentials, activeCredentialIds }
}

function readStoredSet(value: unknown, present: boolean): ReadResult {
  if (!present) return { kind: 'known', set: emptySet() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'corrupt' }
  }
  const raw = value as Record<string, unknown>
  if (raw.version === 2) {
    const set = readV2Set(raw)
    return set === null ? { kind: 'corrupt' } : { kind: 'known', set }
  }
  if (raw.version === 1) return { kind: 'legacy', set: readV1Set(raw) }

  // Any explicit unknown version may belong to a newer writer. Reads expose no
  // credential and mutations must not overwrite or remove it.
  if (Object.hasOwn(raw, 'version')) return { kind: 'future' }
  return { kind: 'corrupt' }
}

function emptySet(): StoredCredentialSetV2 {
  return { version: 2, credentials: [], activeCredentialIds: {} }
}

function sanitizeSet(set: StoredCredentialSetV2): StoredCredentialSetV2 {
  const activeCredentialIds: Record<string, string> = {}
  for (const credential of set.credentials) {
    if (credential.state !== 'committed') continue
    const mapKey = activeCredentialMapKey(
      credential.authorityKey,
      credential.principalKey
    )
    if (set.activeCredentialIds[mapKey] === credential.credentialId) {
      activeCredentialIds[mapKey] = credential.credentialId
    }
  }
  return { version: 2, credentials: set.credentials, activeCredentialIds }
}

async function persistSet(set: StoredCredentialSetV2): Promise<void> {
  const stored = sanitizeSet(set)
  if (stored.credentials.length === 0) {
    await browser.storage.local.remove(STORAGE_KEY)
    return
  }
  await browser.storage.local.set({ [STORAGE_KEY]: stored })
}

/**
 * Reads and, when necessary, atomically migrates v1. A future version returns
 * no data to readers and throws before every mutation, preserving its bytes.
 */
async function loadSet(
  forMutation: boolean
): Promise<StoredCredentialSetV2 | null> {
  const object = await browser.storage.local.get(STORAGE_KEY)
  const storedObject = object as Record<string, unknown>
  const result = readStoredSet(
    storedObject[STORAGE_KEY],
    Object.hasOwn(storedObject, STORAGE_KEY)
  )
  if (result.kind === 'future') {
    if (forMutation) throw new UnsupportedCredentialStoreVersionError()
    return null
  }
  if (result.kind === 'corrupt') {
    if (forMutation) throw new CorruptCredentialStoreError()
    return null
  }
  if (result.kind === 'legacy') await persistSet(result.set)
  return result.set
}

/** Fixed protocol error; the credential id and key never enter its message. */
export class CredentialCollisionError extends Error {
  constructor() {
    super('credential offer conflicts with existing credential metadata')
  }
}

/** Fixed fail-closed error for a record written by an unknown version. */
export class UnsupportedCredentialStoreVersionError extends Error {
  constructor() {
    super('credential store version is unsupported')
  }
}

/** Fixed fail-closed error for a malformed current-version container. */
export class CorruptCredentialStoreError extends Error {
  constructor() {
    super('credential store is corrupt')
  }
}

/** Fixed protocol error; the authenticated identity never enters its message. */
export class CredentialInstanceMismatchError extends Error {
  constructor() {
    super('authenticated server instance conflicts with credential metadata')
  }
}

/** A stale authority view attempted to write after an authority revocation. */
export class CredentialAuthorityRevokedError extends Error {
  constructor() {
    super('credential authority view is stale or being revoked')
  }
}

/** A split finalize/prune caller no longer owns the active credential slot. */
export class CredentialFinalizeConflictError extends Error {
  constructor() {
    super('credential finalize no longer owns the active slot')
  }
}

export class OfferContradictsSlotError extends Error {}

function isUnacked(c: PersistedCredential): boolean {
  return c.state === 'provisional' && c.sub === 'unacked'
}

function isCommitUncertain(c: PersistedCredential): boolean {
  return c.state === 'provisional' && c.sub === 'commit-uncertain'
}

function newestFirst(a: PersistedCredential, b: PersistedCredential): number {
  return b.createdAt - a.createdAt
}

function validateAuthenticatedInstanceId(
  remote: boolean,
  authenticatedInstanceId: string | null
): void {
  if (
    !isNullableInstanceId(authenticatedInstanceId) ||
    (remote && authenticatedInstanceId === null)
  ) {
    throw new Error(
      'authenticated instance id is required for remote authority'
    )
  }
}

function assertAuthorityInstanceContinuity(
  set: StoredCredentialSetV2,
  authorityKey: string,
  remote: boolean,
  authenticatedInstanceId: string | null
): void {
  if (!remote) return
  for (const credential of set.credentials) {
    if (
      credential.authorityKey === authorityKey &&
      credential.authenticatedInstanceId !== authenticatedInstanceId
    ) {
      throw new CredentialInstanceMismatchError()
    }
  }
}

function authorityHasInstanceConflict(
  set: StoredCredentialSetV2,
  authorityKey: string
): boolean {
  let instanceId: string | null = null
  for (const credential of set.credentials) {
    if (credential.authorityKey !== authorityKey) continue
    if (instanceId === null) {
      instanceId = credential.authenticatedInstanceId
    } else if (credential.authenticatedInstanceId !== instanceId) {
      return true
    }
  }
  return false
}

function publicCredential(credential: PersistedCredential): StoredCredential {
  const base = {
    credentialId: credential.credentialId,
    mutualKey: credential.mutualKey,
    principalKey: credential.principalKey,
    state: credential.state,
    createdAt: credential.createdAt,
    authenticatedInstanceId: credential.authenticatedInstanceId,
  }
  if (credential.state === 'provisional' && credential.sub !== undefined) {
    return { ...base, sub: credential.sub }
  }
  return base
}

/** A scoped view. It owns no queue; all views use the module queue above. */
const authorityCredentialStoreIssuance = Symbol('AuthorityCredentialStore')

export class AuthorityCredentialStore implements CredentialAttemptStore {
  readonly [credentialLifecycleStoreBrand] = true as const
  private readonly authorityKey: string
  private readonly remote: boolean
  private readonly authorityGeneration: number

  constructor(
    authority: BackendAuthority,
    issuance: typeof authorityCredentialStoreIssuance
  ) {
    if (issuance !== authorityCredentialStoreIssuance) {
      throw new TypeError('authority credential store was not issued')
    }
    this.authorityKey = backendAuthorityKey(authority)
    this.remote = authority.kind === 'remote'
    const revocation = authorityRevocationState(this.authorityKey)
    // A view obtained while Forget is in flight is never allowed to become a
    // delayed post-revocation writer. The coordinator must acquire a new view
    // after revocation has settled before it can start a new lifecycle.
    this.authorityGeneration = revocation.revoking ? -1 : revocation.generation
    issuedCredentialLifecycleStores.add(this)
  }

  private assertWritableAuthority(): void {
    const revocation = authorityRevocationState(this.authorityKey)
    if (
      revocation.revoking ||
      revocation.generation !== this.authorityGeneration
    ) {
      throw new CredentialAuthorityRevokedError()
    }
  }

  async writeProvisionalUnacked(
    principal: Principal,
    cred: { credentialId: string; mutualKey: string },
    authenticatedInstanceId: string | null
  ): Promise<void> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      validateAuthenticatedInstanceId(this.remote, authenticatedInstanceId)
      assertAuthorityInstanceContinuity(
        set,
        this.authorityKey,
        this.remote,
        authenticatedInstanceId
      )

      const existing = set.credentials.find(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.credentialId === cred.credentialId
      )
      if (existing !== undefined) {
        if (
          existing.principalKey === key &&
          existing.mutualKey === cred.mutualKey &&
          existing.authenticatedInstanceId === authenticatedInstanceId
        ) {
          return
        }
        throw new CredentialCollisionError()
      }

      const mine = set.credentials.filter(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key
      )
      const committed = mine.find(
        (credential) => credential.state === 'committed'
      )
      const staleCommitUncertain = mine.find(
        (credential) =>
          isCommitUncertain(credential) &&
          Date.now() - credential.createdAt > PROVISIONAL_TTL_MS
      )
      const liveCommitUncertain = mine.find(
        (credential) =>
          isCommitUncertain(credential) &&
          Date.now() - credential.createdAt <= PROVISIONAL_TTL_MS
      )
      if (committed === undefined && liveCommitUncertain !== undefined) {
        throw new OfferContradictsSlotError(
          'credentialOffer contradicts a live commit-uncertain slot'
        )
      }

      const credentials = set.credentials.filter((credential) => {
        if (
          credential.authorityKey !== this.authorityKey ||
          credential.principalKey !== key
        ) {
          return true
        }
        if (isUnacked(credential)) return false
        if (committed === undefined && credential === staleCommitUncertain) {
          return false
        }
        return true
      })
      credentials.push({
        authorityKey: this.authorityKey,
        credentialId: cred.credentialId,
        mutualKey: cred.mutualKey,
        principalKey: key,
        state: 'provisional',
        sub: 'unacked',
        createdAt: Date.now(),
        authenticatedInstanceId,
      })
      await persistSet({ ...set, credentials })
    })
  }

  async markCommitUncertain(credentialId: string): Promise<void> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const index = set.credentials.findIndex(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.credentialId === credentialId
      )
      const target = set.credentials[index]
      if (target === undefined) {
        throw new Error('markCommitUncertain: unknown credential')
      }
      if (this.remote && target.authenticatedInstanceId === null) {
        throw new CredentialInstanceMismatchError()
      }
      assertAuthorityInstanceContinuity(
        set,
        this.authorityKey,
        this.remote,
        target.authenticatedInstanceId
      )
      if (target.state === 'committed' || target.sub === 'commit-uncertain') {
        return
      }
      const credentials = [...set.credentials]
      credentials[index] = { ...target, sub: 'commit-uncertain' }
      await persistSet({ ...set, credentials })
    })
  }

  async commitAndActivate(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null
  ): Promise<void> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      validateAuthenticatedInstanceId(this.remote, authenticatedInstanceId)
      const index = set.credentials.findIndex(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.credentialId === credentialId
      )
      const target = set.credentials[index]
      if (target === undefined) {
        throw new Error('commitAndActivate: unknown credential')
      }
      if (target.principalKey !== key) {
        throw new Error(
          'commitAndActivate: credential belongs to another principal'
        )
      }
      if (
        target.authenticatedInstanceId !== null &&
        target.authenticatedInstanceId !== authenticatedInstanceId
      ) {
        throw new CredentialInstanceMismatchError()
      }
      const storedInstanceId =
        target.authenticatedInstanceId ?? authenticatedInstanceId
      validateAuthenticatedInstanceId(this.remote, storedInstanceId)
      assertAuthorityInstanceContinuity(
        set,
        this.authorityKey,
        this.remote,
        storedInstanceId
      )

      const credentials = [...set.credentials]
      credentials[index] = {
        authorityKey: target.authorityKey,
        credentialId: target.credentialId,
        mutualKey: target.mutualKey,
        principalKey: target.principalKey,
        state: 'committed',
        createdAt: target.createdAt,
        authenticatedInstanceId: storedInstanceId,
      }
      const activeCredentialIds = { ...set.activeCredentialIds }
      activeCredentialIds[
        activeCredentialMapKey(this.authorityKey, target.principalKey)
      ] = target.credentialId
      await persistSet({ version: 2, credentials, activeCredentialIds })
    })
  }

  /**
   * Authenticated finalize and §12 prune in one queue transaction and one
   * durable write. `beforeDelete` runs while every soon-to-be-deleted
   * credential is still present, preserving the pins-first crash ordering.
   */
  async finalizeAndPrune(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      validateAuthenticatedInstanceId(this.remote, authenticatedInstanceId)

      const target = set.credentials.find(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.credentialId === credentialId
      )
      if (target === undefined) {
        throw new Error('finalizeAndPrune: unknown credential')
      }
      if (target.principalKey !== key) {
        throw new Error(
          'finalizeAndPrune: credential belongs to another principal'
        )
      }
      if (
        target.authenticatedInstanceId !== null &&
        target.authenticatedInstanceId !== authenticatedInstanceId
      ) {
        throw new CredentialInstanceMismatchError()
      }
      const storedInstanceId =
        target.authenticatedInstanceId ?? authenticatedInstanceId
      validateAuthenticatedInstanceId(this.remote, storedInstanceId)
      assertAuthorityInstanceContinuity(
        set,
        this.authorityKey,
        this.remote,
        storedInstanceId
      )

      const pruned = set.credentials
        .filter(
          (credential) =>
            credential.authorityKey === this.authorityKey &&
            credential.principalKey === key &&
            credential.credentialId !== credentialId
        )
        .map((credential) => credential.credentialId)
      await beforeDelete?.(Object.freeze([...pruned]))

      const committedTarget: PersistedCredential = {
        authorityKey: target.authorityKey,
        credentialId: target.credentialId,
        mutualKey: target.mutualKey,
        principalKey: target.principalKey,
        state: 'committed',
        createdAt: target.createdAt,
        authenticatedInstanceId: storedInstanceId,
      }
      const credentials = set.credentials.flatMap((credential) => {
        if (
          credential.authorityKey !== this.authorityKey ||
          credential.principalKey !== key
        ) {
          return [credential]
        }
        return credential.credentialId === credentialId ? [committedTarget] : []
      })
      const activeCredentialIds = { ...set.activeCredentialIds }
      activeCredentialIds[activeCredentialMapKey(this.authorityKey, key)] =
        credentialId
      await persistSet({ version: 2, credentials, activeCredentialIds })
      return pruned
    })
  }

  async prunePrincipalExcept(
    principal: Principal,
    keepCredentialId: string,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const credentials: PersistedCredential[] = []
      const pruned: string[] = []
      for (const credential of set.credentials) {
        if (
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key &&
          credential.credentialId !== keepCredentialId
        ) {
          pruned.push(credential.credentialId)
        } else {
          credentials.push(credential)
        }
      }
      if (pruned.length === 0) return pruned
      const keep = set.credentials.find(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key &&
          credential.credentialId === keepCredentialId
      )
      const activeId =
        set.activeCredentialIds[
          activeCredentialMapKey(this.authorityKey, key)
        ] ?? null
      if (keep?.state !== 'committed' || activeId !== keepCredentialId) {
        throw new CredentialFinalizeConflictError()
      }
      // Keep the queue locked across external pin deletion, preserving the
      // existing pins-first crash ordering and exact plan/apply id set.
      await beforeDelete?.(Object.freeze([...pruned]))
      await persistSet({ ...set, credentials })
      return pruned
    })
  }

  async recoverOrder(principal: Principal): Promise<StoredCredential[]> {
    return enqueueCredentialOperation(async () => {
      const key = principalKey(principal)
      const set = await loadSet(false)
      if (set === null) return []
      if (this.remote && authorityHasInstanceConflict(set, this.authorityKey)) {
        return []
      }
      const mine = set.credentials.filter(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key &&
          (!this.remote || credential.authenticatedInstanceId !== null)
      )
      const activeId =
        set.activeCredentialIds[
          activeCredentialMapKey(this.authorityKey, key)
        ] ?? null
      const ordered: PersistedCredential[] = []
      const taken = new Set<string>()
      const take = (candidates: PersistedCredential[]): void => {
        for (const candidate of candidates) {
          if (taken.has(candidate.credentialId)) continue
          taken.add(candidate.credentialId)
          ordered.push(candidate)
        }
      }
      take(mine.filter((credential) => credential.credentialId === activeId))
      take(mine.filter(isCommitUncertain).sort(newestFirst))
      take(
        mine
          .filter((credential) => credential.state === 'committed')
          .sort(newestFirst)
      )
      take(
        mine
          .filter((credential) => credential.state === 'provisional')
          .sort(newestFirst)
      )
      return ordered.map(publicCredential)
    })
  }

  async hasCommittedCredential(principal: Principal): Promise<boolean> {
    return enqueueCredentialOperation(async () => {
      const key = principalKey(principal)
      const set = await loadSet(false)
      if (set === null) return false
      if (this.remote && authorityHasInstanceConflict(set, this.authorityKey)) {
        return false
      }
      return set.credentials.some(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key &&
          (!this.remote || credential.authenticatedInstanceId !== null) &&
          credential.state === 'committed'
      )
    })
  }

  async revokeAll(
    principal: Principal,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const credentials: PersistedCredential[] = []
      const revoked: string[] = []
      for (const credential of set.credentials) {
        if (
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key
        ) {
          revoked.push(credential.credentialId)
        } else {
          credentials.push(credential)
        }
      }
      if (revoked.length === 0) return revoked
      await beforeDelete?.(Object.freeze([...revoked]))
      await persistSet({ ...set, credentials })
      return revoked
    })
  }

  /**
   * Removes every principal in this authority, leaving other authorities.
   *
   * The generation is advanced synchronously, before this operation joins the
   * module queue. Thus a write already waiting in the queue observes a stale
   * view and cannot land after the deletion. A new lifecycle must acquire a
   * fresh authority view after this promise settles.
   */
  revokeAuthority(
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    const revocationGeneration = beginAuthorityRevocation(this.authorityKey)
    return enqueueCredentialOperation(async () => {
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const credentials: PersistedCredential[] = []
      const revoked: string[] = []
      for (const credential of set.credentials) {
        if (credential.authorityKey === this.authorityKey) {
          revoked.push(credential.credentialId)
        } else {
          credentials.push(credential)
        }
      }
      if (revoked.length > 0) {
        await beforeDelete?.(Object.freeze([...revoked]))
      }
      // Persist even when no *valid parsed* row matched. The raw v2 record may
      // still contain malformed rows (notably a remote null-instance row) that
      // the parser deliberately dropped; Forget must durably sanitize those
      // before the authority gate can reopen.
      await persistSet({ ...set, credentials })
      // A failed callback or durable write leaves the tombstone closed. A
      // later explicit revokeAuthority call is the only operation allowed to
      // retry cleanup and reopen the authority.
      finishAuthorityRevocation(this.authorityKey, revocationGeneration)
      return revoked
    })
  }

  async ageOutUnacked(now: number): Promise<void> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const credentials = set.credentials.filter(
        (credential) =>
          !(
            credential.authorityKey === this.authorityKey &&
            isUnacked(credential) &&
            now - credential.createdAt > PROVISIONAL_TTL_MS
          )
      )
      if (credentials.length === set.credentials.length) return
      await persistSet({ ...set, credentials })
    })
  }

  async cleanupFirstPairOrphans(
    principal: Principal,
    now: number
  ): Promise<void> {
    this.assertWritableAuthority()
    return enqueueCredentialOperation(async () => {
      this.assertWritableAuthority()
      const key = principalKey(principal)
      const set = await loadSet(true)
      if (set === null) throw new UnsupportedCredentialStoreVersionError()
      const hasCommitted = set.credentials.some(
        (credential) =>
          credential.authorityKey === this.authorityKey &&
          credential.principalKey === key &&
          credential.state === 'committed'
      )
      if (hasCommitted) return
      const credentials = set.credentials.filter(
        (credential) =>
          !(
            credential.authorityKey === this.authorityKey &&
            credential.principalKey === key &&
            isCommitUncertain(credential) &&
            now - credential.createdAt > PROVISIONAL_TTL_MS
          )
      )
      if (credentials.length === set.credentials.length) return
      await persistSet({ ...set, credentials })
    })
  }
}

/** Nominal lifecycle facade that re-enters a profile lease immediately before
 * every durable credential mutation. It exposes no recovery/read helpers, so
 * remote orchestration cannot accidentally retain an unguarded write view. */
class BoundaryCredentialLifecycleStore implements CredentialAttemptStore {
  readonly [credentialLifecycleStoreBrand] = true as const

  constructor(
    private readonly inner: AuthorityCredentialStore,
    private readonly boundary: CredentialMutationBoundary
  ) {
    issuedCredentialLifecycleStores.add(this)
  }

  writeProvisionalUnacked(
    principal: Principal,
    cred: { credentialId: string; mutualKey: string },
    authenticatedInstanceId: string | null
  ): Promise<void> {
    return this.boundary.run(() =>
      this.inner.writeProvisionalUnacked(
        principal,
        cred,
        authenticatedInstanceId
      )
    )
  }

  markCommitUncertain(credentialId: string): Promise<void> {
    return this.boundary.run(() => this.inner.markCommitUncertain(credentialId))
  }

  commitAndActivate(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null
  ): Promise<void> {
    return this.boundary.run(() =>
      this.inner.commitAndActivate(
        credentialId,
        principal,
        authenticatedInstanceId
      )
    )
  }

  finalizeAndPrune(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return this.boundary.run(() =>
      this.inner.finalizeAndPrune(
        credentialId,
        principal,
        authenticatedInstanceId,
        beforeDelete
      )
    )
  }

  prunePrincipalExcept(
    principal: Principal,
    keepCredentialId: string,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return this.boundary.run(() =>
      this.inner.prunePrincipalExcept(principal, keepCredentialId, beforeDelete)
    )
  }

  recoverOrder(principal: Principal): Promise<StoredCredential[]> {
    return this.boundary.run(() => this.inner.recoverOrder(principal))
  }

  hasCommittedCredential(principal: Principal): Promise<boolean> {
    return this.boundary.run(() => this.inner.hasCommittedCredential(principal))
  }

  revokeAll(
    principal: Principal,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return this.boundary.run(() =>
      this.inner.revokeAll(principal, beforeDelete)
    )
  }

  ageOutUnacked(now: number): Promise<void> {
    return this.boundary.run(() => this.inner.ageOutUnacked(now))
  }

  cleanupFirstPairOrphans(principal: Principal, now: number): Promise<void> {
    return this.boundary.run(() =>
      this.inner.cleanupFirstPairOrphans(principal, now)
    )
  }
}

function issueAuthorityCredentialStore(
  authority: BackendAuthority
): AuthorityCredentialStore {
  return new AuthorityCredentialStore(
    authority,
    authorityCredentialStoreIssuance
  )
}

/** Root facade. Production connection flows can obtain only a nominal,
 * lease-bound attempt view; intent-specific status/revoke helpers never expose
 * a retained raw authority writer. */
export class CredentialStore {
  private readonly local = issueAuthorityCredentialStore(
    LOCAL_BACKEND_AUTHORITY
  )

  /** Raw storage-core fixture view. Production source is forbidden from
   * calling it by scripts/check-imports.mjs. */
  forAuthorityForTest(authority: BackendAuthority): AuthorityCredentialStore {
    return issueAuthorityCredentialStore(authority)
  }

  forAttempt(
    authority: BackendAuthority,
    boundary: CredentialMutationBoundary
  ): CredentialAttemptStore {
    assertBackendAttemptMutationCapability(boundary)
    return new BoundaryCredentialLifecycleStore(
      issueAuthorityCredentialStore(authority),
      boundary
    )
  }

  async hasCommittedCredentialForAuthority(
    authority: BackendAuthority,
    principal: Principal
  ): Promise<boolean> {
    return issueAuthorityCredentialStore(authority).hasCommittedCredential(
      principal
    )
  }

  async revokePrincipalForAuthority(
    authority: BackendAuthority,
    principal: Principal,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return issueAuthorityCredentialStore(authority).revokeAll(
      principal,
      beforeDelete
    )
  }

  async revokeAuthority(
    authority: BackendAuthority,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return issueAuthorityCredentialStore(authority).revokeAuthority(
      beforeDelete
    )
  }

  /** @deprecated Local-only compatibility facade. */
  async writeProvisionalUnacked(
    principal: Principal,
    cred: { credentialId: string; mutualKey: string },
    authenticatedInstanceId: string | null = null
  ): Promise<void> {
    return this.local.writeProvisionalUnacked(
      principal,
      cred,
      authenticatedInstanceId
    )
  }

  /** @deprecated Local-only compatibility facade. */
  async markCommitUncertain(credentialId: string): Promise<void> {
    return this.local.markCommitUncertain(credentialId)
  }

  /** @deprecated Local-only compatibility facade. */
  async commitAndActivate(
    credentialId: string,
    principal: Principal,
    authenticatedInstanceId: string | null = null
  ): Promise<void> {
    return this.local.commitAndActivate(
      credentialId,
      principal,
      authenticatedInstanceId
    )
  }

  /** @deprecated Local-only compatibility facade. */
  async prunePrincipalExcept(
    principal: Principal,
    keepCredentialId: string,
    beforeDelete?: (prunedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return this.local.prunePrincipalExcept(
      principal,
      keepCredentialId,
      beforeDelete
    )
  }

  /** @deprecated Local-only compatibility facade. */
  async recoverOrder(principal: Principal): Promise<StoredCredential[]> {
    return this.local.recoverOrder(principal)
  }

  /** @deprecated Local-only compatibility facade. */
  async hasCommittedCredential(principal: Principal): Promise<boolean> {
    return this.local.hasCommittedCredential(principal)
  }

  /** @deprecated Local-only compatibility facade. */
  async revokeAll(
    principal: Principal,
    beforeDelete?: (revokedIds: readonly string[]) => Promise<void>
  ): Promise<string[]> {
    return this.local.revokeAll(principal, beforeDelete)
  }

  /** @deprecated Local-only compatibility facade. */
  async ageOutUnacked(now: number): Promise<void> {
    return this.local.ageOutUnacked(now)
  }

  /** @deprecated Local-only compatibility facade. */
  async cleanupFirstPairOrphans(
    principal: Principal,
    now: number
  ): Promise<void> {
    return this.local.cleanupFirstPairOrphans(principal, now)
  }
}

/**
 * Temporary local compatibility accepted by the existing ConnectionManager.
 * A root is an explicit alternative, never a structural lifecycle store: the
 * resolver always turns it into the local scoped view before a flow can write.
 */
export type CredentialLifecycleSource =
  | CredentialLifecycleStore
  | CredentialStore

export function resolveCredentialLifecycleStore(
  source: CredentialLifecycleSource
): CredentialLifecycleStore {
  if (source instanceof CredentialStore) {
    return issueAuthorityCredentialStore(LOCAL_BACKEND_AUTHORITY)
  }
  if (!issuedCredentialLifecycleStores.has(source)) {
    throw new TypeError('credential lifecycle store was not issued by a scope')
  }
  return source
}

/** Explicit raw view for storage-core tests and fixtures only. Import/use is
 * rejected from production source by scripts/check-imports.mjs. */
export function credentialStoreForAuthorityForTest(
  _root: CredentialStore,
  authority: BackendAuthority
): AuthorityCredentialStore {
  return issueAuthorityCredentialStore(authority)
}
