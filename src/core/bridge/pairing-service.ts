import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type ClientIdentity, clientKey } from '@shared/protocol/bridge'

type PairingEventMap = {
  revoked: [{ identity: ClientIdentity; reason: string }]
  /**
   * Emitted by {@link PairingService.issueToken} when it rotates an existing
   * identity's token (re-pair). The previous token is now dead, so live readers
   * still authenticated with it — notably an open SSE firehose — must be
   * dropped. Carries no `reason`: rotation is not a revocation, so consumers
   * that kick/notify a client on `revoked` should NOT do so here.
   */
  rotated: [{ identity: ClientIdentity }]
}

export type { Browser } from '@shared/protocol/bridge'

/**
 * A paired client (extension OR cli/agent), keyed by its {@link ClientIdentity}.
 * Generalized from the old extension-only `PairedExtension` (Spec 7a) so the
 * device-code flow (Spec 7b) can issue tokens to non-extension principals.
 */
export interface PairedClient {
  identity: ClientIdentity
  token: string
  name: string
  pairedAt: number
  lastActiveAt: number | null
}

export interface PairingStore {
  load(): Promise<PairedClient[]>
  save(list: PairedClient[]): Promise<void>
}

/** Persist `lastActiveAt` at most once per this window per client. A paired CLI
 *  hitting `POST /mdxp` repeatedly must not trigger a disk write per request. */
const MARK_ACTIVE_PERSIST_MS = 60_000

export class PairingService extends EventEmitter<PairingEventMap> {
  private byToken = new Map<string, PairedClient>()
  private byKey = new Map<string, PairedClient>()
  private lastPersistedActive = new Map<string, number>()
  /**
   * Every store mutation shares one ordered tail. Besides preventing concurrent
   * issue/revoke lost updates, this makes best-effort markActive writes owned
   * work that shutdown can drain instead of leaving a filesystem write behind.
   */
  private persistenceTail: Promise<void> = Promise.resolve()
  private acceptingPersistence = true
  private drainPromise: Promise<void> | null = null

  constructor(private store: PairingStore) {
    super()
  }

  async load(): Promise<void> {
    this.byToken.clear()
    this.byKey.clear()
    const list = await this.store.load()
    for (const client of list) {
      this.byToken.set(client.token, client)
      this.byKey.set(clientKey(client.identity), client)
    }
  }

  async issueToken(
    identity: ClientIdentity,
    name: string
  ): Promise<PairedClient> {
    const token = randomBytes(32).toString('base64url')
    const entry: PairedClient = {
      identity,
      token,
      name,
      pairedAt: Date.now(),
      lastActiveAt: null,
    }
    return this.enqueuePersistence(async () => {
      // Compute the document inside the persistence queue. Computing it before
      // admission would let two concurrent issues both start from stale state.
      const key = clientKey(identity)
      const next = [...this.byKey.values()].filter(
        (e) => clientKey(e.identity) !== key
      )
      next.push(entry)
      // Persist FIRST — failure throws and leaves in-memory state untouched.
      await this.store.save(next)
      // Only now mutate the indexes. Drop the previous token (if any) so a
      // rotated pairing does not leave a dangling byToken entry.
      const existing = this.byKey.get(key)
      if (existing) {
        this.byToken.delete(existing.token)
      }
      this.byToken.set(token, entry)
      this.byKey.set(key, entry)
      // Signal rotation AFTER state is consistent, so a listener that reacts by
      // closing live connections for this identity sees the new token in place.
      if (existing) {
        this.emit('rotated', { identity })
      }
      return entry
    })
  }

  findByToken(token: string): PairedClient | null {
    return this.byToken.get(token) ?? null
  }

  async revoke(identity: ClientIdentity, reason: string): Promise<void> {
    return this.enqueuePersistence(async () => {
      const key = clientKey(identity)
      const client = this.byKey.get(key)
      if (!client) return
      // Persist the removal FIRST — if it fails, keep the in-memory entry so the
      // next load() does not resurrect a "revoked" client.
      const next = [...this.byKey.values()].filter(
        (e) => clientKey(e.identity) !== key
      )
      await this.store.save(next)
      this.byToken.delete(client.token)
      this.byKey.delete(key)
      this.emit('revoked', { identity, reason })
    })
  }

  markActive(identity: ClientIdentity): void {
    if (!this.acceptingPersistence) return
    const key = clientKey(identity)
    const client = this.byKey.get(key)
    if (!client) return
    const now = Date.now()
    // In-memory liveness is always current…
    client.lastActiveAt = now
    // …but persistence is debounced (≤ 1 write per client per window) so a
    // chatty agent does not cause a disk write per request.
    const lastPersist = this.lastPersistedActive.get(key) ?? 0
    if (now - lastPersist < MARK_ACTIVE_PERSIST_MS) return
    this.lastPersistedActive.set(key, now)
    // Persist asynchronously but through the owned queue. The snapshot is
    // computed when this operation reaches the head, so an earlier revoke or
    // rotation cannot be overwritten by a stale document.
    void this.enqueuePersistence(() =>
      this.store.save([...this.byKey.values()])
    ).catch(() => {
      // best-effort write; persistence failure is not fatal
    })
  }

  listPaired(): PairedClient[] {
    return [...this.byKey.values()]
  }

  /**
   * Close the persistence admission gate synchronously and wait for every
   * mutation accepted before the gate closed. Idempotent so startup rollback
   * and normal runtime shutdown can share the same ownership path.
   */
  stopAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.acceptingPersistence = false
    this.drainPromise = this.persistenceTail
    return this.drainPromise
  }

  private enqueuePersistence<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingPersistence) {
      return Promise.reject(new Error('pairing persistence is stopped'))
    }
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
