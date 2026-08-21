import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Browser } from '@shared/protocol/bridge'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

/** Default lifetime of a provisional credential that is never acked or used
 *  (spec §6.7). */
export const PROVISIONAL_TTL_MS = 10 * 60 * 1000

/** Sibling of `pairing.json` / `endpoint.json` in the bridge data directory. */
export const MBP1_CREDENTIALS_FILENAME = 'mbp1-credentials.json'

const DOCUMENT_VERSION = 1

const BrowserSchema: z.ZodType<Browser> = z.enum(['chromium', 'firefox'])

const CredentialPrincipalSchema = z.object({
  browser: BrowserSchema,
  verifiedOrigin: z.string().min(1),
  clientInstallationId: z.string().min(1),
})

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

const StoredCredentialSchema = z.object({
  credentialId: z.string().min(1),
  mutualKeyB64: z.string().min(1),
  principal: CredentialPrincipalSchema,
  /** The principal's committed `credentialId` this successor was offered
   *  against — `null` for a first pair. It is both half of the single-slot key
   *  and the compare-and-swap witness for the rotation (§6.7). Cleared once the
   *  credential itself becomes the committed one. */
  predecessorId: z.string().min(1).nullable().catch(null),
  state: z.enum(['provisional', 'committed']),
  identity: IdentityTriStateSchema,
  createdAt: z.number().int(),
  committedAt: z.number().int().nullable(),
})

export type StoredCredential = z.infer<typeof StoredCredentialSchema>

const CredentialDocumentSchema = z.object({
  version: z.literal(DOCUMENT_VERSION),
  credentials: z.array(z.unknown()).catch([]),
  pendingPromote: z.string().min(1).nullable().catch(null),
})

interface CredentialDocument {
  version: typeof DOCUMENT_VERSION
  credentials: StoredCredential[]
  pendingPromote: string | null
}

/**
 * Injective principal key: a delimiter-free concatenation of three
 * attacker-influenced strings is not (`{browser:'a', origin:'bc'}` would
 * collide with `{browser:'ab', origin:'c'}`), so the tuple is JSON-encoded.
 */
export function principalKey(p: CredentialPrincipal): string {
  return JSON.stringify([p.browser, p.verifiedOrigin, p.clientInstallationId])
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
    const { credentials, changed } = reconcile(parsed, now())
    // The replay is durable before any caller holds the store, which is what
    // makes "replay completes before /v1 accepts authentication" true.
    if (changed) await writeDocument(filePath, credentials)
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
      const key = principalKey(principal)
      const predecessorId = this.committedForKey(key)?.credentialId ?? null
      const slot = this.credentials.find(
        (c) =>
          c.state === 'provisional' &&
          principalKey(c.principal) === key &&
          c.predecessorId === predecessorId &&
          !isExpiredAt(c, this.now())
      )
      if (slot) {
        return {
          credentialId: slot.credentialId,
          mutualKeyB64: slot.mutualKeyB64,
        }
      }
      const fresh: StoredCredential = {
        credentialId: randomUUID(),
        mutualKeyB64: randomBytes(32).toString('base64url'),
        principal: { ...principal },
        predecessorId,
        state: 'provisional',
        identity,
        createdAt: this.now(),
        committedAt: null,
      }
      // Replacing the slot (its occupant expired, or the committed credential
      // moved) drops the previous provisional instead of accumulating P₁…Pₙ.
      const next = [
        ...this.credentials.filter(
          (c) => c.state !== 'provisional' || principalKey(c.principal) !== key
        ),
        fresh,
      ]
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
    return this.enqueue(() => this.promoteDurably(credentialId))
  }

  /** The credential a reconnect may authenticate against: committed, or a
   *  provisional that is still live and still the current successor. */
  findForAuth(credentialId: string): StoredCredential | null {
    const found = this.credentials.find((c) => c.credentialId === credentialId)
    if (!found) return null
    if (found.state === 'committed') return found
    if (isExpiredAt(found, this.now())) return null
    // A successor whose predecessor is no longer the committed credential can
    // never be promoted, so it must not authenticate either — otherwise the
    // §6.7 ordering would owe an accept the promote cannot back.
    const key = principalKey(found.principal)
    const committedId = this.committedForKey(key)?.credentialId ?? null
    return committedId === found.predecessorId ? found : null
  }

  committedFor(principal: CredentialPrincipal): StoredCredential | null {
    return this.committedForKey(principalKey(principal))
  }

  listCommitted(): StoredCredential[] {
    return this.credentials.filter((c) => c.state === 'committed')
  }

  /** Revoke a credential and, in the same write, the provisional successor it
   *  was to be rotated into — that successor's trust derives entirely from the
   *  revoked credential, and §6.7 allows no silent re-trust. */
  async revoke(credentialId: string): Promise<void> {
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

  /** Drop provisionals that were never acked or used within the TTL (§6.7).
   *  Committed credentials are never swept — only explicit revocation or a
   *  rotation removes one. */
  async sweepExpiredProvisionals(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.now()
      const next = this.credentials.filter((c) => !isExpiredAt(c, now))
      if (next.length === this.credentials.length) return
      await this.persist(next)
    })
  }

  /** Commit-new and revoke-old as one document write: a crash can leave both
   *  credentials valid or neither only if these are two writes. */
  private async promoteDurably(credentialId: string): Promise<void> {
    const target = this.credentials.find((c) => c.credentialId === credentialId)
    if (target?.state !== 'provisional' || isExpiredAt(target, this.now())) {
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
    await this.persist(applyPromote(this.credentials, target, this.now()))
  }

  private committedForKey(key: string): StoredCredential | null {
    return (
      this.credentials.find(
        (c) => c.state === 'committed' && principalKey(c.principal) === key
      ) ?? null
    )
  }

  /** Durable first, in-memory second: a failed write must not leave the store
   *  claiming a state that is not on disk. */
  private async persist(next: StoredCredential[]): Promise<void> {
    await writeDocument(this.filePath, next)
    this.credentials = next
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
}

/** Read the document defensively: a missing, unparsable, or wrong-version file
 *  yields an empty store, and individual malformed records are dropped rather
 *  than failing the whole load. */
async function readDocument(filePath: string): Promise<ParsedDocument> {
  const empty: ParsedDocument = { credentials: [], pendingPromote: null }
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return empty
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return empty
  }
  const envelope = CredentialDocumentSchema.safeParse(json)
  if (!envelope.success) return empty

  const credentials: StoredCredential[] = []
  for (const record of envelope.data.credentials) {
    const parsed = StoredCredentialSchema.safeParse(record)
    if (parsed.success) credentials.push(parsed.data)
  }
  return { credentials, pendingPromote: envelope.data.pendingPromote }
}

/** Journal replay plus convergence to one committed credential per principal
 *  (§6.7). Reports whether the result must be written back before the store is
 *  handed out. */
function reconcile(
  doc: ParsedDocument,
  now: number
): { credentials: StoredCredential[]; changed: boolean } {
  let credentials = doc.credentials
  // A journal entry always forces the write-back, if only to clear it.
  let changed = doc.pendingPromote !== null

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
  return { credentials: converged, changed }
}

function committedOrder(credential: StoredCredential): number {
  return credential.committedAt ?? credential.createdAt
}

async function writeDocument(
  filePath: string,
  credentials: StoredCredential[]
): Promise<void> {
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
