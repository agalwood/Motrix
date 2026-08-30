import type { Browser } from '@shared/protocol/bridge'
import {
  type CommittedExtensionCredentialSnapshot,
  type CommittedExtensionCredentialWitness,
  type ExtensionIdentityAbsenceWitness,
  type IdentityTriState,
  withLiveCommittedExtensionSnapshot,
  withLiveCommittedExtensionWitness,
  withLiveExtensionIdentityAbsenceWitness,
} from './credential-store'
import { normalizeExtensionIdentity } from './extension-identity-resolver'

const MAX_EXTENSION_ID_LENGTH = 256
const MAX_PROJECTION_RECORDS = 4_096
const CLEANUP_LEASE_BRAND: unique symbol = Symbol(
  'motrix.extension-pairing-projection.cleanup-lease'
)

type ProjectionStatus = 'ready' | 'cleanup-pending'
export type ExtensionPairingProjectionHealth =
  | 'uninitialized'
  | 'ready'
  | 'degraded'
  | 'stopped'

export interface ExtensionTransportIdentity {
  readonly kind: 'extension'
  readonly browser: Browser
  readonly extensionId: string
}

export interface ExtensionPairingProjection {
  readonly identity: ExtensionTransportIdentity
  readonly identityTrust: IdentityTriState
  readonly authorizationEpoch: string
  readonly status: ProjectionStatus
  readonly pairedAt: number
  readonly lastActiveAt: number | null
}

export interface ExtensionPairingProjectionStoreSnapshot {
  readonly revision: number
  readonly records: unknown
}

export interface ExtensionPairingProjectionStore {
  load(): Promise<ExtensionPairingProjectionStoreSnapshot>
  /** Compare-and-swap `expectedRevision`; resolve with exactly the next
   * revision only after the replacement is durable. */
  save(
    next: readonly ExtensionPairingProjection[],
    expectedRevision: number
  ): Promise<number>
}

export interface ExtensionPairingCleanupLease {
  readonly [CLEANUP_LEASE_BRAND]: true
  readonly identity: ExtensionTransportIdentity
  readonly authorizationEpoch: string
}

export interface ExtensionPairingProjectionServiceOptions {
  readonly now?: () => number
}

export const ExtensionPairingProjectionError = Object.freeze({
  InvalidWitness: 'extension-pairing-projection invalid witness',
  InvalidIdentity: 'extension-pairing-projection invalid identity',
  InvalidTime: 'extension-pairing-projection invalid time',
  StorageRejected: 'extension-pairing-projection storage rejected',
  PersistenceFailed: 'extension-pairing-projection persistence failed',
  CapacityExceeded: 'extension-pairing-projection capacity exceeded',
  NotLoaded: 'extension-pairing-projection not loaded',
  Degraded: 'extension-pairing-projection degraded',
  CleanupPending: 'extension-pairing-projection cleanup pending',
  CleanupRequired: 'extension-pairing-projection cleanup required',
  InvalidCleanupLease: 'extension-pairing-projection cleanup lease rejected',
  EpochConflict: 'extension-pairing-projection epoch conflict',
  Stopped: 'extension-pairing-projection stopped',
} as const)

interface CleanupLeaseClaim {
  readonly service: ExtensionPairingProjectionService
  readonly key: string
  readonly authorizationEpoch: string
}

const cleanupLeaseClaims = new WeakMap<object, CleanupLeaseClaim>()

export class ExtensionPairingProjectionService {
  private records: ExtensionPairingProjection[] = []
  private revision = 0
  private persistenceTail: Promise<void> = Promise.resolve()
  private health: ExtensionPairingProjectionHealth = 'uninitialized'
  private drainPromise: Promise<void> | null = null
  private stopRequested = false
  private readonly activeCleanup = new Map<
    string,
    ExtensionPairingCleanupLease
  >()
  private readonly now: () => number

  constructor(
    private readonly store: ExtensionPairingProjectionStore,
    options: ExtensionPairingProjectionServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      this.health = 'uninitialized'
      this.records = []
      let snapshot: ExtensionPairingProjectionStoreSnapshot
      try {
        snapshot = await this.store.load()
      } catch {
        return this.failDegraded(
          ExtensionPairingProjectionError.PersistenceFailed
        )
      }
      let parsed: ReturnType<typeof parseStoreSnapshot>
      try {
        parsed = parseStoreSnapshot(snapshot)
      } catch {
        return this.failDegraded(
          ExtensionPairingProjectionError.StorageRejected
        )
      }
      this.records = parsed.records
      this.revision = parsed.revision
      this.pruneResolvedCleanupLeases()
      this.health = 'ready'
    }, false)
  }

  getHealth(): ExtensionPairingProjectionHealth {
    return this.health
  }

  list(): readonly ExtensionPairingProjection[] {
    return freezeSnapshot(this.records)
  }

  listReady(): readonly ExtensionPairingProjection[] {
    return freezeSnapshot(
      this.records.filter((record) => record.status === 'ready')
    )
  }

  canAdmitIdentity(identity: ExtensionTransportIdentity): boolean {
    const normalized = normalizeTransportIdentity(identity)
    if (normalized === null || this.health !== 'ready') return false
    const key = identityKey(normalized)
    return (
      !this.activeCleanup.has(key) &&
      !this.records.some(
        (record) =>
          identityKey(record.identity) === key &&
          record.status === 'cleanup-pending'
      )
    )
  }

  async recordCommitted(
    witness: CommittedExtensionCredentialWitness
  ): Promise<ExtensionPairingProjection> {
    return withLiveCommittedExtensionWitness(witness, () =>
      this.enqueue(async () => this.upsertLiveWitness(witness, null))
    )
  }

  async recordAuthenticated(
    witness: CommittedExtensionCredentialWitness,
    authenticatedAt?: number
  ): Promise<ExtensionPairingProjection> {
    return withLiveCommittedExtensionWitness(witness, () =>
      this.enqueue(async () => {
        const observedAt = authenticatedAt ?? this.readNow()
        if (!validTimestamp(observedAt) || observedAt < witness.committedAt) {
          throw new Error(ExtensionPairingProjectionError.InvalidTime)
        }
        return this.upsertLiveWitness(witness, observedAt)
      })
    )
  }

  /**
   * Persist the admission tombstone before the authoritative credential
   * revoke starts. The caller must not revoke first. After this resolves it
   * may revoke every credential for the identity, then call
   * {@link completeCleanup} with a queue-bound credential-absence witness.
   * Generic reconciliation never overrides a durable pending cleanup.
   */
  async prepareCleanup(
    witness: CommittedExtensionCredentialWitness
  ): Promise<ExtensionPairingCleanupLease> {
    return withLiveCommittedExtensionWitness(witness, () =>
      this.enqueue(async () => {
        const key = identityKey(witness.identity)
        const current = this.records.find(
          (record) => identityKey(record.identity) === key
        )
        if (
          current &&
          current.authorizationEpoch !== witness.authorizationEpoch
        ) {
          return this.failDegraded(
            ExtensionPairingProjectionError.CleanupRequired
          )
        }
        const pending: ExtensionPairingProjection = {
          identity: witness.identity,
          identityTrust: current
            ? conservativeTrust(current.identityTrust, witness.identityTrust)
            : witness.identityTrust,
          authorizationEpoch: witness.authorizationEpoch,
          status: 'cleanup-pending',
          pairedAt: current?.pairedAt ?? witness.committedAt,
          lastActiveAt: current?.lastActiveAt ?? null,
        }
        if (current?.status !== 'cleanup-pending') {
          const next = this.records.filter(
            (record) => identityKey(record.identity) !== key
          )
          next.push(pending)
          await this.persist(sortRecords(next))
        }
        return this.issueCleanupLease(pending)
      })
    )
  }

  /**
   * Prepare or resume a security-reducing cleanup from the durable management
   * row itself. This is the operator-revoke/startup-recovery seam: unlike an
   * authorization grant, marking an already-recorded identity pending cannot
   * create trust. It is required when a crash happened after credential
   * deletion, so no live credential witness remains with which to recover the
   * pending marker.
   */
  async prepareIdentityCleanup(
    identity: ExtensionTransportIdentity
  ): Promise<ExtensionPairingCleanupLease> {
    return this.enqueue(async () => {
      const normalized = normalizeTransportIdentity(identity)
      if (normalized === null) {
        throw new Error(ExtensionPairingProjectionError.InvalidIdentity)
      }
      const key = identityKey(normalized)
      const current = this.records.find(
        (record) => identityKey(record.identity) === key
      )
      if (current === undefined) {
        throw new Error(ExtensionPairingProjectionError.CleanupRequired)
      }
      if (current.status === 'ready') {
        await this.persist(
          sortRecords(
            this.records.map((record) =>
              identityKey(record.identity) === key
                ? { ...record, status: 'cleanup-pending' as const }
                : record
            )
          )
        )
      }
      const pending = this.records.find(
        (record) => identityKey(record.identity) === key
      )
      if (pending?.status !== 'cleanup-pending') {
        throw new Error(ExtensionPairingProjectionError.CleanupRequired)
      }
      return this.issueCleanupLease(pending)
    })
  }

  async completeCleanup(
    lease: ExtensionPairingCleanupLease,
    absenceWitness: ExtensionIdentityAbsenceWitness
  ): Promise<void> {
    const claim = cleanupLeaseClaims.get(lease)
    if (
      !claim ||
      claim.service !== this ||
      this.activeCleanup.get(claim.key) !== lease
    ) {
      throw new Error(ExtensionPairingProjectionError.InvalidCleanupLease)
    }
    return withLiveExtensionIdentityAbsenceWitness(
      absenceWitness,
      lease.identity,
      () =>
        this.enqueue(async () => {
          const current = this.records.find(
            (record) => identityKey(record.identity) === claim.key
          )
          if (
            current?.status !== 'cleanup-pending' ||
            current.authorizationEpoch !== claim.authorizationEpoch
          ) {
            throw new Error(ExtensionPairingProjectionError.InvalidCleanupLease)
          }
          await this.persist(
            this.records.filter(
              (record) => identityKey(record.identity) !== claim.key
            )
          )
          cleanupLeaseClaims.delete(lease)
          this.activeCleanup.delete(claim.key)
        })
    )
  }

  /** Roll back a prepared cleanup only while the same authorization epoch is
   * still authoritatively committed. This is the explicit credential-revoke
   * failure path; it cannot be invoked with a copied lease or stale witness. */
  async cancelCleanup(
    lease: ExtensionPairingCleanupLease,
    witness: CommittedExtensionCredentialWitness
  ): Promise<ExtensionPairingProjection> {
    const claim = cleanupLeaseClaims.get(lease)
    if (
      !claim ||
      claim.service !== this ||
      this.activeCleanup.get(claim.key) !== lease
    ) {
      throw new Error(ExtensionPairingProjectionError.InvalidCleanupLease)
    }
    return withLiveCommittedExtensionWitness(witness, () =>
      this.enqueue(async () => {
        if (
          identityKey(witness.identity) !== claim.key ||
          witness.authorizationEpoch !== claim.authorizationEpoch
        ) {
          throw new Error(ExtensionPairingProjectionError.InvalidCleanupLease)
        }
        const current = this.records.find(
          (record) => identityKey(record.identity) === claim.key
        )
        if (
          current?.status !== 'cleanup-pending' ||
          current.authorizationEpoch !== claim.authorizationEpoch
        ) {
          throw new Error(ExtensionPairingProjectionError.InvalidCleanupLease)
        }
        const restored: ExtensionPairingProjection = {
          ...current,
          identityTrust: conservativeTrust(
            current.identityTrust,
            witness.identityTrust
          ),
          status: 'ready',
        }
        const next = this.records.filter(
          (record) => identityKey(record.identity) !== claim.key
        )
        next.push(restored)
        await this.persist(sortRecords(next))
        cleanupLeaseClaims.delete(lease)
        this.activeCleanup.delete(claim.key)
        return freezeRecord(restored)
      })
    )
  }

  /** Reconcile from one store-issued complete snapshot. This is the only API
   * allowed to remove stale rows without a prepared cleanup lease. */
  async reconcileCommitted(
    snapshot: CommittedExtensionCredentialSnapshot
  ): Promise<readonly ExtensionPairingProjection[]> {
    return withLiveCommittedExtensionSnapshot(snapshot, (witnesses) =>
      this.enqueue(async () => {
        let aggregates: WitnessAggregate[]
        try {
          aggregates = aggregateWitnesses(witnesses)
        } catch (error) {
          return this.failDegraded(
            error instanceof Error &&
              error.message === ExtensionPairingProjectionError.CapacityExceeded
              ? ExtensionPairingProjectionError.CapacityExceeded
              : ExtensionPairingProjectionError.EpochConflict
          )
        }
        const existing = new Map(
          this.records.map((record) => [identityKey(record.identity), record])
        )
        const authoritativeKeys = new Set<string>()
        const next: ExtensionPairingProjection[] = []
        for (const aggregate of aggregates) {
          const key = identityKey(aggregate.identity)
          authoritativeKeys.add(key)
          const current = existing.get(key)
          const sameEpoch =
            current?.authorizationEpoch === aggregate.authorizationEpoch
          if (current?.status === 'cleanup-pending') {
            if (!sameEpoch) {
              return this.failDegraded(
                ExtensionPairingProjectionError.CleanupRequired
              )
            }
            next.push({
              ...current,
              identityTrust: conservativeTrust(
                current.identityTrust,
                aggregate.identityTrust
              ),
            })
            continue
          }
          next.push({
            identity: aggregate.identity,
            identityTrust: aggregate.identityTrust,
            authorizationEpoch: aggregate.authorizationEpoch,
            status: 'ready',
            pairedAt: sameEpoch
              ? current.pairedAt
              : aggregate.earliestCommittedAt,
            lastActiveAt: sameEpoch ? current.lastActiveAt : null,
          })
        }
        for (const current of this.records) {
          const key = identityKey(current.identity)
          if (
            current.status === 'cleanup-pending' &&
            !authoritativeKeys.has(key)
          ) {
            next.push(current)
          }
        }
        const sorted = sortRecords(next)
        if (!recordsEqual(this.records, sorted)) await this.persist(sorted)
        return freezeSnapshot(sorted)
      })
    )
  }

  stopAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.stopRequested = true
    this.drainPromise = this.persistenceTail.then(() => {
      this.health = 'stopped'
    })
    return this.drainPromise
  }

  private async upsertLiveWitness(
    witness: CommittedExtensionCredentialWitness,
    authenticatedAt: number | null
  ): Promise<ExtensionPairingProjection> {
    const key = identityKey(witness.identity)
    const current = this.records.find(
      (record) => identityKey(record.identity) === key
    )
    if (current?.status === 'cleanup-pending') {
      throw new Error(ExtensionPairingProjectionError.CleanupPending)
    }
    if (current && current.authorizationEpoch !== witness.authorizationEpoch) {
      return this.failDegraded(ExtensionPairingProjectionError.CleanupRequired)
    }
    if (!current && this.records.length >= MAX_PROJECTION_RECORDS) {
      throw new Error(ExtensionPairingProjectionError.CapacityExceeded)
    }
    if (
      current &&
      authenticatedAt !== null &&
      authenticatedAt < current.pairedAt
    ) {
      throw new Error(ExtensionPairingProjectionError.InvalidTime)
    }
    const updated: ExtensionPairingProjection = {
      identity: witness.identity,
      identityTrust: current
        ? conservativeTrust(current.identityTrust, witness.identityTrust)
        : witness.identityTrust,
      authorizationEpoch: witness.authorizationEpoch,
      status: 'ready',
      pairedAt: current?.pairedAt ?? witness.committedAt,
      lastActiveAt:
        authenticatedAt === null
          ? (current?.lastActiveAt ?? null)
          : Math.max(current?.lastActiveAt ?? 0, authenticatedAt),
    }
    if (current && recordEqual(current, updated)) return freezeRecord(current)
    const next = this.records.filter(
      (record) => identityKey(record.identity) !== key
    )
    next.push(updated)
    await this.persist(sortRecords(next))
    return freezeRecord(updated)
  }

  private issueCleanupLease(
    record: ExtensionPairingProjection
  ): ExtensionPairingCleanupLease {
    const key = identityKey(record.identity)
    const existing = this.activeCleanup.get(key)
    if (existing) return existing
    const lease = {
      identity: freezeIdentity(record.identity),
      authorizationEpoch: record.authorizationEpoch,
    } as ExtensionPairingCleanupLease
    Object.defineProperty(lease, CLEANUP_LEASE_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    })
    Object.freeze(lease)
    cleanupLeaseClaims.set(lease, {
      service: this,
      key,
      authorizationEpoch: record.authorizationEpoch,
    })
    this.activeCleanup.set(key, lease)
    return lease
  }

  private pruneResolvedCleanupLeases(): void {
    for (const [key, lease] of this.activeCleanup) {
      const claim = cleanupLeaseClaims.get(lease)
      const pending = this.records.find(
        (record) =>
          identityKey(record.identity) === key &&
          record.status === 'cleanup-pending'
      )
      if (
        !claim ||
        !pending ||
        pending.authorizationEpoch !== claim.authorizationEpoch
      ) {
        cleanupLeaseClaims.delete(lease)
        this.activeCleanup.delete(key)
      }
    }
  }

  private async persist(next: ExtensionPairingProjection[]): Promise<void> {
    const snapshot = freezeSnapshot(next)
    let nextRevision: number
    try {
      nextRevision = await this.store.save(snapshot, this.revision)
    } catch {
      return this.failDegraded(
        ExtensionPairingProjectionError.PersistenceFailed
      )
    }
    if (nextRevision !== this.revision + 1 || !validRevision(nextRevision)) {
      return this.failDegraded(
        ExtensionPairingProjectionError.PersistenceFailed
      )
    }
    this.records = snapshot.map(cloneRecord)
    this.revision = nextRevision
  }

  private readNow(): number {
    const now = this.now()
    if (!validTimestamp(now)) {
      throw new Error(ExtensionPairingProjectionError.InvalidTime)
    }
    return now
  }

  private failDegraded(message: string): never {
    this.health = 'degraded'
    this.records = []
    throw new Error(message)
  }

  private enqueue<T>(
    operation: () => Promise<T>,
    requiresReady = true
  ): Promise<T> {
    if (this.stopRequested || this.health === 'stopped') {
      return Promise.reject(new Error(ExtensionPairingProjectionError.Stopped))
    }
    const result = this.persistenceTail.then(async () => {
      if (requiresReady && this.health !== 'ready') {
        throw new Error(
          this.health === 'degraded'
            ? ExtensionPairingProjectionError.Degraded
            : ExtensionPairingProjectionError.NotLoaded
        )
      }
      return operation()
    })
    this.persistenceTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function parseStoreSnapshot(snapshot: unknown): {
  revision: number
  records: ExtensionPairingProjection[]
} {
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !hasOnlyKeys(snapshot as Record<string, unknown>, ['records', 'revision'])
  ) {
    throw new Error(ExtensionPairingProjectionError.StorageRejected)
  }
  const candidate = snapshot as { revision?: unknown; records?: unknown }
  if (!validRevision(candidate.revision) || !Array.isArray(candidate.records)) {
    throw new Error(ExtensionPairingProjectionError.StorageRejected)
  }
  if (candidate.records.length > MAX_PROJECTION_RECORDS) {
    throw new Error(ExtensionPairingProjectionError.StorageRejected)
  }
  const records = candidate.records.map(parseRecord)
  const sorted = sortRecords(records)
  for (let index = 1; index < sorted.length; index += 1) {
    if (
      identityKey(sorted[index - 1].identity) ===
      identityKey(sorted[index].identity)
    ) {
      throw new Error(ExtensionPairingProjectionError.StorageRejected)
    }
  }
  return { revision: candidate.revision, records: sorted }
}

function parseRecord(value: unknown): ExtensionPairingProjection {
  if (
    typeof value !== 'object' ||
    value === null ||
    !hasOnlyKeys(value as Record<string, unknown>, [
      'authorizationEpoch',
      'identity',
      'identityTrust',
      'lastActiveAt',
      'pairedAt',
      'status',
    ])
  ) {
    throw new Error(ExtensionPairingProjectionError.StorageRejected)
  }
  const candidate = value as Record<string, unknown>
  const identity = normalizeTransportIdentity(candidate.identity)
  if (
    identity === null ||
    !validTrust(candidate.identityTrust) ||
    !validEpoch(candidate.authorizationEpoch) ||
    (candidate.status !== 'ready' && candidate.status !== 'cleanup-pending') ||
    !validTimestamp(candidate.pairedAt) ||
    !(
      candidate.lastActiveAt === null ||
      (validTimestamp(candidate.lastActiveAt) &&
        candidate.lastActiveAt >= candidate.pairedAt)
    )
  ) {
    throw new Error(ExtensionPairingProjectionError.StorageRejected)
  }
  return {
    identity,
    identityTrust: candidate.identityTrust,
    authorizationEpoch: candidate.authorizationEpoch,
    status: candidate.status,
    pairedAt: candidate.pairedAt,
    lastActiveAt: candidate.lastActiveAt,
  }
}

interface WitnessAggregate {
  readonly identity: ExtensionTransportIdentity
  readonly identityTrust: IdentityTriState
  readonly authorizationEpoch: string
  readonly earliestCommittedAt: number
}

function aggregateWitnesses(
  witnesses: readonly CommittedExtensionCredentialWitness[]
): WitnessAggregate[] {
  if (witnesses.length > MAX_PROJECTION_RECORDS * 4) {
    throw new Error(ExtensionPairingProjectionError.CapacityExceeded)
  }
  const byIdentity = new Map<string, WitnessAggregate>()
  for (const witness of witnesses) {
    const key = identityKey(witness.identity)
    const current = byIdentity.get(key)
    if (current && current.authorizationEpoch !== witness.authorizationEpoch) {
      throw new Error(ExtensionPairingProjectionError.EpochConflict)
    }
    byIdentity.set(key, {
      identity: witness.identity,
      identityTrust: current
        ? conservativeTrust(current.identityTrust, witness.identityTrust)
        : witness.identityTrust,
      authorizationEpoch: witness.authorizationEpoch,
      earliestCommittedAt: Math.min(
        current?.earliestCommittedAt ?? witness.committedAt,
        witness.committedAt
      ),
    })
    if (byIdentity.size > MAX_PROJECTION_RECORDS) {
      throw new Error(ExtensionPairingProjectionError.CapacityExceeded)
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareIdentity(left.identity, right.identity)
  )
}

function conservativeTrust(
  left: IdentityTriState,
  right: IdentityTriState
): IdentityTriState {
  const order: readonly IdentityTriState[] = [
    'unverified',
    'attested-non-official',
    'official',
  ]
  return order[Math.min(order.indexOf(left), order.indexOf(right))]
}

function normalizeTransportIdentity(
  value: unknown
): ExtensionTransportIdentity | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !hasOnlyKeys(value as Record<string, unknown>, [
      'browser',
      'extensionId',
      'kind',
    ])
  ) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.kind !== 'extension' ||
    (candidate.browser !== 'chromium' && candidate.browser !== 'firefox') ||
    typeof candidate.extensionId !== 'string' ||
    candidate.extensionId.length === 0 ||
    candidate.extensionId.length > MAX_EXTENSION_ID_LENGTH ||
    candidate.extensionId !== candidate.extensionId.toLowerCase()
  ) {
    return null
  }
  const scheme =
    candidate.browser === 'chromium' ? 'chrome-extension' : 'moz-extension'
  const normalized = normalizeExtensionIdentity({
    browser: candidate.browser,
    verifiedOrigin: `${scheme}://${candidate.extensionId}`,
    claimedExtensionId: candidate.extensionId,
  })
  if (
    !normalized.ok ||
    normalized.identity.originHost !== candidate.extensionId
  ) {
    return null
  }
  return {
    kind: 'extension',
    browser: candidate.browser,
    extensionId: candidate.extensionId,
  }
}

function validTrust(value: unknown): value is IdentityTriState {
  return (
    value === 'official' ||
    value === 'attested-non-official' ||
    value === 'unverified'
  )
}

function validEpoch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value
    )
  )
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function identityKey(identity: ExtensionTransportIdentity): string {
  return JSON.stringify([identity.browser, identity.extensionId])
}

function compareIdentity(
  left: ExtensionTransportIdentity,
  right: ExtensionTransportIdentity
): number {
  return (
    left.browser.localeCompare(right.browser) ||
    left.extensionId.localeCompare(right.extensionId)
  )
}

function sortRecords(
  records: readonly ExtensionPairingProjection[]
): ExtensionPairingProjection[] {
  return [...records]
    .map(cloneRecord)
    .sort((left, right) => compareIdentity(left.identity, right.identity))
}

function recordEqual(
  left: ExtensionPairingProjection,
  right: ExtensionPairingProjection
): boolean {
  return (
    identityKey(left.identity) === identityKey(right.identity) &&
    left.identityTrust === right.identityTrust &&
    left.authorizationEpoch === right.authorizationEpoch &&
    left.status === right.status &&
    left.pairedAt === right.pairedAt &&
    left.lastActiveAt === right.lastActiveAt
  )
}

function recordsEqual(
  left: readonly ExtensionPairingProjection[],
  right: readonly ExtensionPairingProjection[]
): boolean {
  return (
    left.length === right.length &&
    left.every((record, index) =>
      right[index] ? recordEqual(record, right[index]) : false
    )
  )
}

function freezeIdentity(
  identity: ExtensionTransportIdentity
): ExtensionTransportIdentity {
  return Object.freeze({ ...identity })
}

function cloneRecord(
  record: ExtensionPairingProjection
): ExtensionPairingProjection {
  return {
    identity: { ...record.identity },
    identityTrust: record.identityTrust,
    authorizationEpoch: record.authorizationEpoch,
    status: record.status,
    pairedAt: record.pairedAt,
    lastActiveAt: record.lastActiveAt,
  }
}

function freezeRecord(
  record: ExtensionPairingProjection
): ExtensionPairingProjection {
  return Object.freeze({
    ...cloneRecord(record),
    identity: freezeIdentity(record.identity),
  })
}

function freezeSnapshot(
  records: readonly ExtensionPairingProjection[]
): readonly ExtensionPairingProjection[] {
  return Object.freeze(records.map(freezeRecord))
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  )
}
