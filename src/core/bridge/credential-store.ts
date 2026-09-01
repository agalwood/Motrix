import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Browser } from '@shared/protocol/bridge'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { normalizeExtensionIdentity } from './extension-identity-resolver'

/** Default lifetime of a provisional credential that is never acked or used
 *  (spec §6.7). */
export const PROVISIONAL_TTL_MS = 10 * 60 * 1000

/** Sibling of `pairing.json` / `endpoint.json` in the bridge data directory. */
export const MBP1_CREDENTIALS_FILENAME = 'mbp1-credentials.json'

const DOCUMENT_VERSION = 2
const LEGACY_DOCUMENT_VERSION = 1
const MAX_STORED_CREDENTIALS = 16_384
const MAX_CREDENTIAL_ID_LENGTH = 128
const MAX_MUTUAL_KEY_LENGTH = 256
const MAX_VERIFIED_ORIGIN_LENGTH = 512
const MAX_INSTALLATION_ID_LENGTH = 256
const MAX_EXTENSION_ID_LENGTH = 256
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const BrowserSchema: z.ZodType<Browser> = z.enum(['chromium', 'firefox'])

const CredentialPrincipalSchema = z
  .object({
    browser: BrowserSchema,
    verifiedOrigin: z.string().min(1).max(MAX_VERIFIED_ORIGIN_LENGTH),
    clientInstallationId: z.string().min(1).max(MAX_INSTALLATION_ID_LENGTH),
  })
  .strict()

/** Spec §6.7: a second browser profile is a new principal, so issuing or
 *  rotating one credential never affects another. */
export type CredentialPrincipal = z.infer<typeof CredentialPrincipalSchema>

const IdentityTriStateSchema = z.enum([
  'official',
  'attested-non-official',
  'unverified',
])

/** The §5 extension identity tri-state, frozen onto the credential at offer
 *  time so a later reconnect renders the same trust level. */
export type IdentityTriState = z.infer<typeof IdentityTriStateSchema>

const StoredCredentialBaseSchema = z
  .object({
    credentialId: z.string().min(1).max(MAX_CREDENTIAL_ID_LENGTH),
    mutualKeyB64: z.string().min(1).max(MAX_MUTUAL_KEY_LENGTH),
    principal: CredentialPrincipalSchema,
    /** The principal's committed `credentialId` this successor was offered
     *  against — `null` for a first pair. It is both half of the single-slot key
     *  and the compare-and-swap witness for the rotation (§6.7). Cleared once the
     *  credential itself becomes the committed one. */
    predecessorId: z.string().min(1).max(MAX_CREDENTIAL_ID_LENGTH).nullable(),
    state: z.enum(['provisional', 'committed']),
    identity: IdentityTriStateSchema,
    createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    committedAt: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict()

const StoredCredentialSchema = StoredCredentialBaseSchema.extend({
  authorizationEpoch: z.string().regex(UUID_V4_PATTERN),
})

const LegacyStoredCredentialSchema = StoredCredentialBaseSchema.omit({
  predecessorId: true,
})
  .extend({
    // Early beta documents could omit this field. Mapping only absence to
    // null is safe: a rotation then fails its predecessor CAS rather than
    // authenticating against an inferred predecessor.
    predecessorId: z
      .string()
      .min(1)
      .max(MAX_CREDENTIAL_ID_LENGTH)
      .nullable()
      .optional(),
  })
  .transform((credential) => ({
    ...credential,
    predecessorId: credential.predecessorId ?? null,
  }))

/**
 * `authorizationEpoch` is optional in the exported structural type solely so
 * existing MBP1 state-machine doubles remain source-compatible. Every real
 * credential loaded or written by {@link Mbp1CredentialStore} has it; witness
 * issuance rejects a record without it.
 */
export type StoredCredential = z.infer<typeof StoredCredentialBaseSchema> & {
  authorizationEpoch?: string
}

const CredentialDocumentSchema = z
  .object({
    version: z.literal(DOCUMENT_VERSION),
    credentials: z.array(z.unknown()).max(MAX_STORED_CREDENTIALS),
    pendingPromote: z.string().min(1).nullable(),
  })
  .strict()

const LegacyCredentialDocumentSchema = z
  .object({
    version: z.literal(LEGACY_DOCUMENT_VERSION),
    credentials: z.array(z.unknown()).max(MAX_STORED_CREDENTIALS),
    pendingPromote: z.string().min(1).nullable().optional(),
  })
  .strict()

interface CredentialDocument {
  version: typeof DOCUMENT_VERSION
  credentials: StoredCredential[]
  pendingPromote: string | null
}

const COMMITTED_EXTENSION_WITNESS_BRAND: unique symbol = Symbol(
  'motrix.mbp1.committed-extension-witness'
)
const COMMITTED_EXTENSION_SNAPSHOT_BRAND: unique symbol = Symbol(
  'motrix.mbp1.committed-extension-snapshot'
)
const EXTENSION_IDENTITY_ABSENCE_WITNESS_BRAND: unique symbol = Symbol(
  'motrix.mbp1.extension-identity-absence-witness'
)

export interface CommittedExtensionCredentialWitness {
  readonly [COMMITTED_EXTENSION_WITNESS_BRAND]: true
  readonly identity: {
    readonly kind: 'extension'
    readonly browser: Browser
    readonly extensionId: string
  }
  readonly verifiedOrigin: string
  readonly identityTrust: IdentityTriState
  readonly authorizationEpoch: string
  readonly createdAt: number
  readonly committedAt: number
}

export interface CommittedExtensionCredentialSnapshot {
  readonly [COMMITTED_EXTENSION_SNAPSHOT_BRAND]: true
  readonly witnesses: readonly CommittedExtensionCredentialWitness[]
}

/**
 * Nominal proof that one transport identity currently has no committed or
 * provisional MBP1 credential in the issuing store. The proof is useful only
 * through {@link withLiveExtensionIdentityAbsenceWitness}; copying its public
 * fields does not copy the issuing store's queue-bound claim.
 */
export interface ExtensionIdentityAbsenceWitness {
  readonly [EXTENSION_IDENTITY_ABSENCE_WITNESS_BRAND]: true
  readonly identity: {
    readonly kind: 'extension'
    readonly browser: Browser
    readonly extensionId: string
  }
}

export const CommittedExtensionCredentialError = Object.freeze({
  InvalidWitness: 'mbp1 committed extension witness rejected',
  NotCommitted: 'mbp1 committed extension credential unavailable',
  NotAbsent: 'mbp1 extension credential identity still authorized',
  EpochConflict: 'mbp1 extension authorization epoch conflict',
  InvalidInput: 'mbp1 credential input rejected',
  CapacityExceeded: 'mbp1 credential capacity exceeded',
} as const)

interface WitnessClaim {
  run<T>(operation: () => Promise<T>): Promise<T>
}

interface SnapshotClaim {
  run<T>(operation: () => Promise<T>): Promise<T>
}

interface AbsenceWitnessClaim {
  readonly key: string
  run<T>(operation: () => Promise<T>): Promise<T>
}

const witnessClaims = new WeakMap<object, WitnessClaim>()
const snapshotClaims = new WeakMap<object, SnapshotClaim>()
const absenceWitnessClaims = new WeakMap<object, AbsenceWitnessClaim>()

/**
 * Injective principal key: a delimiter-free concatenation of three
 * attacker-influenced strings is not (`{browser:'a', origin:'bc'}` would
 * collide with `{browser:'ab', origin:'c'}`), so the tuple is JSON-encoded.
 */
export function principalKey(p: CredentialPrincipal): string {
  return JSON.stringify([p.browser, p.verifiedOrigin, p.clientInstallationId])
}

/**
 * Run a projection mutation while the issuing credential store's queue proves
 * the exact credential is still committed. Holding that queue until
 * `operation` settles prevents an in-process revoke or rotation from racing
 * between the liveness check and the projection write.
 */
export function withLiveCommittedExtensionWitness<T>(
  witness: CommittedExtensionCredentialWitness,
  operation: () => Promise<T>
): Promise<T> {
  const claim = witnessClaims.get(witness)
  if (!claim) {
    return Promise.reject(
      new Error(CommittedExtensionCredentialError.InvalidWitness)
    )
  }
  return claim.run(operation)
}

/** The snapshot counterpart of {@link withLiveCommittedExtensionWitness}.
 * Its fingerprint proves the caller supplied the complete committed set,
 * including an authentically empty set after a full revoke. */
export function withLiveCommittedExtensionSnapshot<T>(
  snapshot: CommittedExtensionCredentialSnapshot,
  operation: (
    witnesses: readonly CommittedExtensionCredentialWitness[]
  ) => Promise<T>
): Promise<T> {
  const claim = snapshotClaims.get(snapshot)
  if (!claim) {
    return Promise.reject(
      new Error(CommittedExtensionCredentialError.InvalidWitness)
    )
  }
  return claim.run(() => operation(snapshot.witnesses))
}

/**
 * Run a cleanup mutation while the issuing credential store's serialization
 * queue proves the named identity is still fully absent. This makes
 * projection deletion depend on credential deletion at the API boundary and
 * prevents a new provisional credential from appearing during that deletion.
 */
export function withLiveExtensionIdentityAbsenceWitness<T>(
  witness: ExtensionIdentityAbsenceWitness,
  expectedIdentity: { readonly browser: Browser; readonly extensionId: string },
  operation: () => Promise<T>
): Promise<T> {
  const normalized = normalizeTransportIdentity(
    expectedIdentity.browser,
    expectedIdentity.extensionId
  )
  const claim = absenceWitnessClaims.get(witness)
  if (normalized === null || claim?.key !== transportIdentityKey(normalized)) {
    return Promise.reject(
      new Error(CommittedExtensionCredentialError.InvalidWitness)
    )
  }
  return claim.run(operation)
}

/**
 * Durable MBP1 credential storage — the server half of the §6.7 two-phase
 * commit.
 *
 * §6.7 fixes the ordering of durable writes relative to wire messages, not
 * just the end state, so this store is written around three rules:
 *
 * - A credential is durable in state `provisional` **before** the caller may
 *   send `credentialOffer`; `offerProvisional` only resolves once the write
 *   landed.
 * - A promotion (`credentialAck` or an authenticated reconnect) is durable
 *   **before** the caller may send `credentialCommitted` / `reconnectAccept`,
 *   and for a rotation it commits the successor and revokes the predecessor in
 *   a **single** document write — never both credentials, never neither.
 * - `load()` reconciles a `pendingPromote` journal entry and converges every
 *   principal to one committed credential **before it returns**, so `/v1`
 *   cannot admit an authentication against a half-applied rotation.
 *
 * Every mutation is serialized through one promise chain, computes the next
 * full document inside that chain, writes it atomically at 0600, and only then
 * swaps the in-memory array. A failed write therefore leaves memory and disk
 * agreeing on the previous state.
 *
 * The store never logs: credential ids and mutual keys are secrets (§11), so
 * they must not reach a log sink, and neither do its error messages carry them.
 */
export class Mbp1CredentialStore {
  private persistenceTail: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    private credentials: StoredCredential[],
    private readonly now: () => number
  ) {}

  static async load(
    filePath: string,
    opts?: { now?: () => number }
  ): Promise<Mbp1CredentialStore> {
    const now = opts?.now ?? Date.now
    const parsed = await readDocument(filePath)
    const { credentials, changed } = reconcile(parsed, readClock(now))
    // The replay is durable before any caller holds the store, which is what
    // makes "replay completes before /v1 accepts authentication" true.
    if (changed) {
      await writeDocument(filePath, credentials)
      await syncParentDirectory(filePath)
    }
    return new Mbp1CredentialStore(filePath, credentials, now)
  }

  /**
   * Mint (or re-offer) the single provisional successor for this principal.
   *
   * At most one outstanding provisional exists per
   * `{principal, currentCommittedCredentialId}`: a repeated offer for the same
   * pair re-offers the **identical** `{credentialId, mutualKey}` already on
   * disk rather than a freshly minted replacement, so a client that stored the
   * earlier offer and one that did not converge on the same successor (§6.7).
   */
  async offerProvisional(
    principal: CredentialPrincipal,
    identity: IdentityTriState
  ): Promise<{ credentialId: string; mutualKeyB64: string }> {
    return this.enqueue(async () => {
      const parsedPrincipal = parseCredentialPrincipal(principal)
      if (!IdentityTriStateSchema.safeParse(identity).success) {
        throw new Error(CommittedExtensionCredentialError.InvalidInput)
      }
      const operationNow = this.readNow()
      const key = principalKey(parsedPrincipal)
      const predecessorId = this.committedForKey(key)?.credentialId ?? null
      const slot = this.credentials.find(
        (c) =>
          c.state === 'provisional' &&
          principalKey(c.principal) === key &&
          c.predecessorId === predecessorId &&
          !isExpiredAt(c, operationNow)
      )
      if (slot) {
        return {
          credentialId: slot.credentialId,
          mutualKeyB64: slot.mutualKeyB64,
        }
      }
      const retained = this.credentials.filter(
        (credential) =>
          credential.state !== 'provisional' ||
          principalKey(credential.principal) !== key
      )
      if (retained.length >= MAX_STORED_CREDENTIALS) {
        throw new Error(CommittedExtensionCredentialError.CapacityExceeded)
      }
      const fresh: StoredCredential = {
        credentialId: randomUUID(),
        mutualKeyB64: randomBytes(32).toString('base64url'),
        principal: { ...parsedPrincipal },
        predecessorId,
        state: 'provisional',
        identity,
        authorizationEpoch:
          this.authorizationEpochForPrincipal(parsedPrincipal) ?? randomUUID(),
        createdAt: operationNow,
        committedAt: null,
      }
      // Replacing the slot (its occupant expired, or the committed credential
      // moved) drops the previous provisional instead of accumulating P₁…Pₙ.
      const next = [...retained, fresh]
      await this.persist(next)
      return {
        credentialId: fresh.credentialId,
        mutualKeyB64: fresh.mutualKeyB64,
      }
    })
  }

  /**
   * `credentialAck` path (§6.7 step 3): commit durably, then the caller sends
   * `credentialCommitted`. When the pair flow ran inside an authenticated
   * session this is a rotation, so it is the same single durable transaction
   * as {@link promoteOnReconnect}.
   */
  async commitFromPair(credentialId: string): Promise<void> {
    assertCredentialId(credentialId)
    return this.enqueue(() => this.promoteDurably(credentialId))
  }

  /**
   * Reconnect path (§6.7/§8): a successful challenge–response is itself an
   * authenticated acknowledgment. The caller must run this **after** verifying
   * `reconnectResponse` and **before** sending `reconnectAccept` — accepting
   * first would let a crash leave the just-authenticated credential merely
   * provisional, where it later expires.
   *
   * Only a live provisional can be promoted; call it solely for a credential
   * whose state is `provisional`.
   */
  async promoteOnReconnect(credentialId: string): Promise<void> {
    assertCredentialId(credentialId)
    return this.enqueue(() => this.promoteDurably(credentialId))
  }

  /** The credential a reconnect may authenticate against: committed, or a
   *  provisional that is still live and still the current successor. */
  findForAuth(credentialId: string): StoredCredential | null {
    if (!validCredentialId(credentialId)) return null
    const found = this.credentials.find((c) => c.credentialId === credentialId)
    if (!found) return null
    if (found.state === 'committed') return freezeCredential(found)
    if (isExpiredAt(found, this.readNow())) return null
    // A successor whose predecessor is no longer the committed credential can
    // never be promoted, so it must not authenticate either — otherwise the
    // §6.7 ordering would owe an accept the promote cannot back.
    const key = principalKey(found.principal)
    const committedId = this.committedForKey(key)?.credentialId ?? null
    return committedId === found.predecessorId ? freezeCredential(found) : null
  }

  committedFor(principal: CredentialPrincipal): StoredCredential | null {
    const parsed = CredentialPrincipalSchema.safeParse(principal)
    if (!parsed.success) return null
    const credential = this.committedForKey(principalKey(parsed.data))
    return credential ? freezeCredential(credential) : null
  }

  listCommitted(): StoredCredential[] {
    return this.credentials
      .filter((credential) => credential.state === 'committed')
      .map(freezeCredential)
  }

  /** Issue one nominal projection witness for an exact committed credential.
   * Callers must retain the credential id from the MBP1 commit/reconnect path;
   * there is intentionally no identity-only or "first matching" fallback. */
  async issueCommittedExtensionWitness(
    credentialId: string
  ): Promise<CommittedExtensionCredentialWitness> {
    assertCredentialId(credentialId)
    return this.enqueue(async () => {
      const credential = this.credentials.find(
        (candidate) =>
          candidate.credentialId === credentialId &&
          candidate.state === 'committed'
      )
      if (!credential) {
        throw new Error(CommittedExtensionCredentialError.NotCommitted)
      }
      return this.issueWitness(credential)
    })
  }

  /** Issue a complete, nominal snapshot for startup/cleanup reconciliation. */
  async issueCommittedExtensionSnapshot(): Promise<CommittedExtensionCredentialSnapshot> {
    return this.enqueue(async () => {
      this.assertOneEpochPerTransportIdentity()
      const committed = this.credentials.filter(
        (credential) => credential.state === 'committed'
      )
      const witnesses = Object.freeze(
        committed.map((credential) => this.issueWitness(credential))
      )
      const snapshot = { witnesses } as CommittedExtensionCredentialSnapshot
      Object.defineProperty(snapshot, COMMITTED_EXTENSION_SNAPSHOT_BRAND, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      })
      Object.freeze(snapshot)
      const fingerprint = committedFingerprint(committed)
      snapshotClaims.set(snapshot, {
        run: <T>(operation: () => Promise<T>): Promise<T> =>
          this.enqueue(async () => {
            const liveCommitted = this.credentials.filter(
              (credential) => credential.state === 'committed'
            )
            if (committedFingerprint(liveCommitted) !== fingerprint) {
              throw new Error(CommittedExtensionCredentialError.NotCommitted)
            }
            this.assertOneEpochPerTransportIdentity()
            return operation()
          }),
      })
      return snapshot
    })
  }

  /** Revoke a credential and, in the same write, the provisional successor it
   *  was to be rotated into — that successor's trust derives entirely from the
   *  revoked credential, and §6.7 allows no silent re-trust. */
  async revoke(credentialId: string): Promise<void> {
    assertCredentialId(credentialId)
    return this.enqueue(async () => {
      const next = this.credentials.filter(
        (c) =>
          c.credentialId !== credentialId &&
          !(c.state === 'provisional' && c.predecessorId === credentialId)
      )
      if (next.length === this.credentials.length) return
      await this.persist(next)
    })
  }

  /**
   * Revoke every credential bound to one verified extension origin.
   *
   * A browser profile reinstall changes `clientInstallationId`, and a failed
   * rotation can leave a provisional successor beside the committed record.
   * The renderer's revoke action names the transport identity
   * (`browser` + Origin host), not either of those credential-internal values,
   * so revocation must remove every matching committed and provisional record
   * in one durable write. Revoking only the currently displayed credential
   * would leave another installation slot able to authenticate immediately.
   */
  async revokeExtensionIdentity(
    browser: Browser,
    extensionId: string
  ): Promise<number> {
    const identity = normalizeTransportIdentity(browser, extensionId)
    if (identity === null) {
      throw new Error(CommittedExtensionCredentialError.InvalidInput)
    }
    return this.enqueue(async () => {
      const next = this.credentials.filter(
        (credential) =>
          !principalMatchesExtensionIdentity(
            credential.principal,
            identity.browser,
            identity.extensionId
          )
      )
      const revoked = this.credentials.length - next.length
      if (revoked === 0) return 0
      await this.persist(next)
      return revoked
    })
  }

  /**
   * Issue a nominal, queue-bound proof that an extension transport identity
   * has no committed or provisional credential. A surviving rotation slot or
   * a newly offered first-pair credential makes issuance fail closed.
   */
  async issueExtensionIdentityAbsenceWitness(
    browser: Browser,
    extensionId: string
  ): Promise<ExtensionIdentityAbsenceWitness> {
    const identity = normalizeTransportIdentity(browser, extensionId)
    if (identity === null) {
      throw new Error(CommittedExtensionCredentialError.InvalidInput)
    }
    return this.enqueue(async () => {
      this.assertExtensionIdentityAbsent(identity)
      return this.issueAbsenceWitness(identity)
    })
  }

  /** Drop provisionals that were never acked or used within the TTL (§6.7).
   *  Committed credentials are never swept — only explicit revocation or a
   *  rotation removes one. */
  async sweepExpiredProvisionals(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.readNow()
      const next = this.credentials.filter((c) => !isExpiredAt(c, now))
      if (next.length === this.credentials.length) return
      await this.persist(next)
    })
  }

  private issueWitness(
    credential: StoredCredential
  ): CommittedExtensionCredentialWitness {
    if (
      credential.state !== 'committed' ||
      credential.committedAt === null ||
      credential.authorizationEpoch === undefined
    ) {
      throw new Error(CommittedExtensionCredentialError.NotCommitted)
    }
    const transport = transportIdentityForPrincipal(credential.principal)
    if (!transport) {
      throw new Error(CommittedExtensionCredentialError.NotCommitted)
    }
    const witness = {
      identity: Object.freeze({
        kind: 'extension' as const,
        browser: transport.browser,
        extensionId: transport.extensionId,
      }),
      verifiedOrigin: credential.principal.verifiedOrigin,
      identityTrust: credential.identity,
      authorizationEpoch: credential.authorizationEpoch,
      createdAt: credential.createdAt,
      committedAt: credential.committedAt,
    } as CommittedExtensionCredentialWitness
    Object.defineProperty(witness, COMMITTED_EXTENSION_WITNESS_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    })
    Object.freeze(witness)
    const credentialId = credential.credentialId
    const authorizationEpoch = credential.authorizationEpoch
    witnessClaims.set(witness, {
      run: <T>(operation: () => Promise<T>): Promise<T> =>
        this.enqueue(async () => {
          const live = this.credentials.find(
            (candidate) =>
              candidate.credentialId === credentialId &&
              candidate.state === 'committed' &&
              candidate.authorizationEpoch === authorizationEpoch
          )
          if (!live) {
            throw new Error(CommittedExtensionCredentialError.NotCommitted)
          }
          return operation()
        }),
    })
    return witness
  }

  private issueAbsenceWitness(identity: {
    browser: Browser
    extensionId: string
  }): ExtensionIdentityAbsenceWitness {
    const key = transportIdentityKey(identity)
    const witness = {
      identity: Object.freeze({ kind: 'extension' as const, ...identity }),
    } as ExtensionIdentityAbsenceWitness
    Object.defineProperty(witness, EXTENSION_IDENTITY_ABSENCE_WITNESS_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    })
    Object.freeze(witness)
    absenceWitnessClaims.set(witness, {
      key,
      run: <T>(operation: () => Promise<T>): Promise<T> =>
        this.enqueue(async () => {
          this.assertExtensionIdentityAbsent(identity)
          return operation()
        }),
    })
    return witness
  }

  private assertExtensionIdentityAbsent(identity: {
    browser: Browser
    extensionId: string
  }): void {
    if (
      this.credentials.some((credential) =>
        principalMatchesExtensionIdentity(
          credential.principal,
          identity.browser,
          identity.extensionId
        )
      )
    ) {
      throw new Error(CommittedExtensionCredentialError.NotAbsent)
    }
  }

  private authorizationEpochForPrincipal(
    principal: CredentialPrincipal
  ): string | null {
    const key = transportKeyForPrincipal(principal)
    if (key === null) {
      throw new Error(CommittedExtensionCredentialError.NotCommitted)
    }
    const epochs = new Set(
      this.credentials
        .filter(
          (credential) => transportKeyForPrincipal(credential.principal) === key
        )
        .map((credential) => credential.authorizationEpoch)
        .filter((epoch): epoch is string => epoch !== undefined)
    )
    if (epochs.size > 1) {
      throw new Error(CommittedExtensionCredentialError.EpochConflict)
    }
    return epochs.values().next().value ?? null
  }

  private assertOneEpochPerTransportIdentity(): void {
    const byIdentity = new Map<string, string>()
    for (const credential of this.credentials) {
      if (credential.state !== 'committed') continue
      const key = transportKeyForPrincipal(credential.principal)
      const epoch = credential.authorizationEpoch
      if (key === null || epoch === undefined) {
        throw new Error(CommittedExtensionCredentialError.EpochConflict)
      }
      const seen = byIdentity.get(key)
      if (seen !== undefined && seen !== epoch) {
        throw new Error(CommittedExtensionCredentialError.EpochConflict)
      }
      byIdentity.set(key, epoch)
    }
  }

  /** Commit-new and revoke-old as one document write: a crash can leave both
   *  credentials valid or neither only if these are two writes. */
  private async promoteDurably(credentialId: string): Promise<void> {
    const target = this.credentials.find((c) => c.credentialId === credentialId)
    const now = this.readNow()
    if (
      target?.state !== 'provisional' ||
      isExpiredAt(target, now) ||
      now < target.createdAt
    ) {
      throw new Error('mbp1 credential promote rejected: no live provisional')
    }
    // Compare-and-swap on the principal's current committed credentialId.
    // Rotations are serialized by the persistence chain, so the loser of two
    // concurrent rotations observes the changed current id here and is
    // rejected — exactly one successor commits.
    const key = principalKey(target.principal)
    const committedId = this.committedForKey(key)?.credentialId ?? null
    if (committedId !== target.predecessorId) {
      throw new Error('mbp1 credential promote rejected: stale rotation')
    }
    await this.persist(applyPromote(this.credentials, target, now))
  }

  private committedForKey(key: string): StoredCredential | null {
    return (
      this.credentials.find(
        (c) => c.state === 'committed' && principalKey(c.principal) === key
      ) ?? null
    )
  }

  private readNow(): number {
    return readClock(this.now)
  }

  /**
   * `rename` → memory → parent-directory sync, in that order, and the order is
   * the whole design.
   *
   * `writeDocument` returns once the atomic rename has landed, so at that point
   * **disk already holds `next`** — which is why memory is updated before the
   * directory sync rather than after. The sync only makes the rename's
   * directory entry survive power loss; it cannot un-land it. If it rejects,
   * this method still rejects (the caller has not been promised durability),
   * but memory and disk agree, so a later mutation cannot write a stale
   * snapshot back.
   *
   * Contrast the `chmod` that used to sit here: that step was **redundant**,
   * because `write-file-atomic` already set the mode on the temp file, so the
   * fix was to delete it. This step is not redundant — §6.7's crash
   * consistency depends on it — so it stays and the memory update moves ahead
   * of it instead. Same window, opposite remedy, because one step was doing
   * nothing and the other is load-bearing.
   */
  private async persist(next: StoredCredential[]): Promise<void> {
    await writeDocument(this.filePath, next)
    this.credentials = next
    await syncParentDirectory(this.filePath)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistenceTail.then(operation)
    // Keep the queue usable after an operation rejects while preserving that
    // rejection for the operation's own caller.
    this.persistenceTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function parseCredentialPrincipal(
  principal: CredentialPrincipal
): CredentialPrincipal {
  const parsed = CredentialPrincipalSchema.safeParse(principal)
  if (!parsed.success || transportIdentityForPrincipal(parsed.data) === null) {
    throw new Error(CommittedExtensionCredentialError.InvalidInput)
  }
  return parsed.data
}

function normalizeTransportIdentity(
  browser: Browser,
  extensionId: string
): { browser: Browser; extensionId: string } | null {
  if (
    (browser !== 'chromium' && browser !== 'firefox') ||
    typeof extensionId !== 'string' ||
    extensionId.length === 0 ||
    extensionId.length > MAX_EXTENSION_ID_LENGTH ||
    extensionId !== extensionId.toLowerCase()
  ) {
    return null
  }
  const scheme = browser === 'chromium' ? 'chrome-extension' : 'moz-extension'
  const normalized = normalizeExtensionIdentity({
    browser,
    verifiedOrigin: `${scheme}://${extensionId}`,
    claimedExtensionId: extensionId,
  })
  if (!normalized.ok || normalized.identity.originHost !== extensionId) {
    return null
  }
  return { browser, extensionId }
}

function validCredentialId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CREDENTIAL_ID_LENGTH
  )
}

function assertCredentialId(value: unknown): asserts value is string {
  if (!validCredentialId(value)) {
    throw new Error(CommittedExtensionCredentialError.InvalidInput)
  }
}

function readClock(clock: () => number): number {
  let value: number
  try {
    value = clock()
  } catch {
    throw new Error(CommittedExtensionCredentialError.InvalidInput)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(CommittedExtensionCredentialError.InvalidInput)
  }
  return value
}

function freezeCredential(credential: StoredCredential): StoredCredential {
  return Object.freeze({
    ...credential,
    principal: Object.freeze({ ...credential.principal }),
  })
}

function transportIdentityForPrincipal(principal: CredentialPrincipal): {
  browser: Browser
  extensionId: string
} | null {
  let parsed: URL
  try {
    parsed = new URL(principal.verifiedOrigin)
  } catch {
    return null
  }
  const normalized = normalizeExtensionIdentity({
    browser: principal.browser,
    verifiedOrigin: principal.verifiedOrigin,
    claimedExtensionId: parsed.hostname,
  })
  if (
    !normalized.ok ||
    normalized.identity.originHost.length > MAX_EXTENSION_ID_LENGTH ||
    normalized.identity.originHost !==
      normalized.identity.originHost.toLowerCase()
  ) {
    return null
  }
  return {
    browser: normalized.identity.browser,
    extensionId: normalized.identity.originHost,
  }
}

function transportKeyForPrincipal(
  principal: CredentialPrincipal
): string | null {
  const identity = transportIdentityForPrincipal(principal)
  return identity
    ? JSON.stringify([identity.browser, identity.extensionId])
    : null
}

function transportIdentityKey(identity: {
  browser: Browser
  extensionId: string
}): string {
  return JSON.stringify([identity.browser, identity.extensionId])
}

function committedFingerprint(
  credentials: readonly StoredCredential[]
): string {
  return JSON.stringify(
    credentials
      .map((credential) => [
        credential.credentialId,
        credential.authorizationEpoch ?? null,
        principalKey(credential.principal),
        credential.identity,
        credential.createdAt,
        credential.committedAt,
      ])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
  )
}

function principalMatchesExtensionIdentity(
  principal: CredentialPrincipal,
  browser: Browser,
  extensionId: string
): boolean {
  if (principal.browser !== browser) return false
  try {
    const origin = new URL(principal.verifiedOrigin)
    const protocol =
      browser === 'chromium' ? 'chrome-extension:' : 'moz-extension:'
    return (
      origin.protocol === protocol && origin.host === extensionId.toLowerCase()
    )
  } catch {
    return false
  }
}

/** The promoted credential becomes the principal's sole credential: the
 *  predecessor and any other outstanding successor go in the same write. */
function applyPromote(
  credentials: StoredCredential[],
  target: StoredCredential,
  now: number
): StoredCredential[] {
  const key = principalKey(target.principal)
  return [
    ...credentials.filter((c) => principalKey(c.principal) !== key),
    {
      ...target,
      state: 'committed',
      committedAt: target.committedAt ?? now,
      predecessorId: null,
    },
  ]
}

function isExpiredAt(credential: StoredCredential, now: number): boolean {
  return (
    credential.state === 'provisional' &&
    now - credential.createdAt >= PROVISIONAL_TTL_MS
  )
}

interface ParsedDocument {
  credentials: StoredCredential[]
  pendingPromote: string | null
  legacy: boolean
}

const CREDENTIAL_STORAGE_REJECTED = 'mbp1 credential storage rejected'

/** Missing is a clean first run. Corrupt, future, or partially malformed
 * state is preserved and rejected wholesale; silently dropping credentials
 * would turn storage damage into a fresh authorization boundary. */
async function readDocument(filePath: string): Promise<ParsedDocument> {
  const empty: ParsedDocument = {
    credentials: [],
    pendingPromote: null,
    legacy: false,
  }
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw new Error(CREDENTIAL_STORAGE_REJECTED)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(CREDENTIAL_STORAGE_REJECTED)
  }
  const currentEnvelope = CredentialDocumentSchema.safeParse(json)
  const legacyEnvelope = LegacyCredentialDocumentSchema.safeParse(json)
  if (!currentEnvelope.success && !legacyEnvelope.success) {
    throw new Error(CREDENTIAL_STORAGE_REJECTED)
  }
  const legacy = !currentEnvelope.success
  const envelope = currentEnvelope.success
    ? currentEnvelope.data
    : legacyEnvelope.success
      ? legacyEnvelope.data
      : null
  if (envelope === null) throw new Error(CREDENTIAL_STORAGE_REJECTED)
  const recordSchema = legacy
    ? LegacyStoredCredentialSchema
    : StoredCredentialSchema

  const credentials: StoredCredential[] = []
  for (const record of envelope.credentials) {
    const parsed = recordSchema.safeParse(record)
    if (!parsed.success || !validCredentialState(parsed.data)) {
      throw new Error(CREDENTIAL_STORAGE_REJECTED)
    }
    credentials.push(parsed.data)
  }
  return {
    credentials,
    pendingPromote: envelope.pendingPromote ?? null,
    legacy,
  }
}

/** Journal replay plus convergence to one committed credential per principal
 *  (§6.7). Reports whether the result must be written back before the store is
 *  handed out. */
function reconcile(
  doc: ParsedDocument,
  now: number,
  makeEpoch: () => string = randomUUID
): { credentials: StoredCredential[]; changed: boolean } {
  let credentials = doc.credentials
  // A journal entry always forces the write-back, if only to clear it.
  let changed = doc.pendingPromote !== null || doc.legacy

  if (doc.pendingPromote !== null) {
    const target = credentials.find(
      (c) => c.credentialId === doc.pendingPromote
    )
    if (target) credentials = applyPromote(credentials, target, now)
  }

  // Keep the newest committed credential per principal. Two committed
  // credentials for one principal are not reachable through this store's
  // writes; converging anyway means a hand-edited or foreign document cannot
  // let a principal authenticate against a stale credential.
  const newest = new Map<string, StoredCredential>()
  for (const c of credentials) {
    if (c.state !== 'committed') continue
    const key = principalKey(c.principal)
    const seen = newest.get(key)
    if (!seen || committedOrder(c) >= committedOrder(seen)) newest.set(key, c)
  }

  const converged = credentials.filter((c) =>
    c.state === 'committed'
      ? newest.get(principalKey(c.principal)) === c
      : !isExpiredAt(c, now)
  )
  if (converged.length !== credentials.length) changed = true

  const groups = new Map<string, StoredCredential[]>()
  for (const credential of converged) {
    const key = transportKeyForPrincipal(credential.principal)
    if (key === null) throw new Error(CREDENTIAL_STORAGE_REJECTED)
    const group = groups.get(key) ?? []
    group.push(credential)
    groups.set(key, group)
  }
  const migrated: StoredCredential[] = []
  for (const group of groups.values()) {
    const epochs = new Set(
      group
        .map((credential) => credential.authorizationEpoch)
        .filter((epoch): epoch is string => epoch !== undefined)
    )
    if (epochs.size > 1) {
      throw new Error(CommittedExtensionCredentialError.EpochConflict)
    }
    const epoch = epochs.values().next().value ?? makeEpoch()
    for (const credential of group) {
      if (credential.authorizationEpoch !== epoch) changed = true
      migrated.push({ ...credential, authorizationEpoch: epoch })
    }
  }
  return { credentials: migrated, changed }
}

function committedOrder(credential: StoredCredential): number {
  return credential.committedAt ?? credential.createdAt
}

/**
 * Fsyncs the directory holding `filePath`, so the rename that published the new
 * document is itself durable.
 *
 * `write-file-atomic@8.0.0` fsyncs the temp file's fd before renaming but never
 * opens the parent directory, so without this the *contents* are durable while
 * the directory entry naming them may not be. §6.7 requires the server to
 * "durably promote ... and only then send `reconnectAccept`", and names the
 * exact failure this closes: "a crash after the accept could leave the
 * just-authenticated credential merely provisional and let it later expire."
 * Power loss between the rename and the directory metadata reaching stable
 * storage could also re-expose the previous document, resurrecting a credential
 * this store had revoked.
 *
 * Skipped on Windows by an explicit platform check rather than by catching the
 * open failure: a directory cannot be opened as a file there, so the guarantee
 * rests on the filesystem instead. Inferring the platform from an error would
 * have made a genuine `EACCES` on Unix indistinguishable from "unsupported",
 * silently downgrading a real durability failure — so on every platform that
 * has the syscall, every failure here propagates.
 */
async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await openFile(dirname(filePath), 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeDocument(
  filePath: string,
  credentials: StoredCredential[]
): Promise<void> {
  if (
    credentials.some(
      (credential) =>
        credential.authorizationEpoch === undefined ||
        !validCredentialState(credential)
    )
  ) {
    throw new Error(CREDENTIAL_STORAGE_REJECTED)
  }
  await mkdir(dirname(filePath), { recursive: true })
  const document: CredentialDocument = {
    version: DOCUMENT_VERSION,
    credentials,
    // Always null on the write path: every mutation is one atomic rename, so
    // there is no window a journal entry could describe. The field is honored
    // on load so a document written by a recovery tool still converges.
    pendingPromote: null,
  }
  // Atomic: temp file, fsync, rename over the target — a crash mid-write leaves
  // the previous document intact. Owner-only (0600) because the file holds
  // mutual keys.
  //
  // There is deliberately no `chmod` after this call, and the absence is
  // load-bearing. `write-file-atomic` creates the temp file with an explicitly
  // supplied `mode` (it only inherits the existing target's mode when `mode` is
  // omitted), chmods that temp file, and *then* renames — so a mode failure
  // happens before the commit point and leaves the old document intact, while
  // the rename replaces the inode and the result carries 0600 by construction.
  //
  // A post-rename `chmod` was therefore redundant, and being redundant was the
  // smaller half of the problem: it was a fallible step *after* the data was
  // durable, so `chmod` rejecting made `persist` throw before
  // `this.credentials = next`. Disk held the promoted successor while memory
  // still held the revoked predecessor, and any later mutation would write that
  // stale array back — resurrecting a credential this store had already revoked,
  // against §6.7's requirement that rotation converge on exactly one.
  await writeFileAtomic(filePath, JSON.stringify(document, null, 2), {
    mode: 0o600,
  })
}

function validCredentialState(credential: StoredCredential): boolean {
  return credential.state === 'committed'
    ? credential.committedAt !== null &&
        credential.committedAt >= credential.createdAt
    : credential.committedAt === null
}
