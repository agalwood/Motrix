import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'
import { EndpointCatalogService } from '@/background/EndpointCatalogService'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import {
  backendAuthorityKey,
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import {
  type AuthorityCredentialStore,
  CorruptCredentialStoreError,
  CredentialAuthorityRevokedError,
  CredentialCollisionError,
  CredentialFinalizeConflictError,
  CredentialInstanceMismatchError,
  type CredentialLifecycleStore,
  CredentialStore,
  OfferContradictsSlotError,
  principalKey,
  resolveCredentialLifecycleStore,
  UnsupportedCredentialStoreVersionError,
} from '@/background/mbp1/credential-store'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.mbp1.credentials'

const P = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://abc',
  clientInstallationId: 'inst-1',
}
/** A second browser profile: a different principal (§6.7), same origin. */
const Q = { ...P, clientInstallationId: 'inst-2' }
const SERVER_A = createRemoteBackendAuthority({
  endpointId: 'server-a',
  wsBase: 'wss://a.example.test/bridge',
})

const SERVER_B = createRemoteBackendAuthority({
  endpointId: 'server-b',
  wsBase: 'wss://b.example.test/bridge',
})
const INSTANCE_A = 'instance-a'
const INSTANCE_B = 'instance-b'

let backing: Record<string, unknown> = {}
// Date.now() is spied rather than faked wholesale, so `await` and the store's
// own promise queue keep running on real microtasks while `createdAt` stays
// under the test's control. Several assertions below are about strict
// createdAt ordering and would otherwise be decided by insertion order.
let clock = 1_700_000_000_000

const advance = (ms: number): void => {
  clock += ms
}

beforeEach(() => {
  backing = {}
  clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    if (typeof k === 'string') return k in backing ? { [k]: backing[k] } : {}
    if (Array.isArray(k)) {
      const out: Record<string, unknown> = {}
      for (const key of k) if (key in backing) out[key] = backing[key]
      return out
    }
    return { ...backing }
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The raw persisted record, to assert on shape the public API hides. */
function persisted(): {
  version: unknown
  credentials: Array<Record<string, unknown>>
  activeCredentialIds: Record<string, unknown>
  /** Compatibility projection for the original local-only assertions. */
  activeCredentialId: unknown
} {
  const raw = backing[STORAGE_KEY] as {
    version: unknown
    credentials: Array<Record<string, unknown>>
    activeCredentialIds?: Record<string, unknown>
  }
  const activeCredentialIds = raw.activeCredentialIds ?? {}
  return {
    ...raw,
    activeCredentialIds,
    activeCredentialId: Object.values(activeCredentialIds)[0] ?? null,
  }
}

async function ids(
  store: CredentialStore | AuthorityCredentialStore,
  p = P
): Promise<string[]> {
  return (await store.recoverOrder(p)).map((c) => c.credentialId)
}

describe('CredentialStore (§6.7/§12)', () => {
  it('recovery order prefers activeCredentialId, then newest commit-uncertain', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k1' })
    await s.markCommitUncertain('c1')
    await s.commitAndActivate('c1', P)
    // The successor must be strictly newer than the active credential, or this
    // assertion would also hold for a store that merely sorted by createdAt
    // (stable sort keeps insertion order on a tie) and never consulted the
    // pointer at all.
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'c2', mutualKey: 'k2' }) // rotation successor
    await s.markCommitUncertain('c2')
    const order = await s.recoverOrder(P)
    expect(order[0]?.credentialId).toBe('c1') // activeCredentialId wins over newer commit-uncertain
    expect(order.map((c) => c.credentialId)).toEqual(['c1', 'c2'])
  })

  it('ages out an unacked provisional after 10 min but never a commit-uncertain one', async () => {
    const s = new CredentialStore()
    // The two live under DIFFERENT principals on purpose. `ageOutUnacked` spans
    // all principals, but `writeProvisionalUnacked` evicts an older `unacked`
    // of the *same* principal — so with both under P, writing the second would
    // already have deleted the first and the age-out assertion would hold
    // whether or not `ageOutUnacked` did anything at all. Keeping them apart is
    // what makes the age-out the only thing that can remove `u1`.
    await s.writeProvisionalUnacked(P, { credentialId: 'u1', mutualKey: 'k' })
    await s.writeProvisionalUnacked(Q, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    await s.ageOutUnacked(Date.now() + 11 * 60_000)
    expect(await ids(s, P)).toEqual([])
    expect(await ids(s, Q)).toEqual(['cu'])
  })

  it('post-auth prune deletes every other credential for the principal', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'old', mutualKey: 'k' })
    await s.commitAndActivate('old', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'new', mutualKey: 'k' })
    await s.commitAndActivate('new', P)
    await s.prunePrincipalExcept(P, 'new')
    expect(await ids(s)).toEqual(['new'])
  })

  it('returns the pruned credentialIds so the caller can clear their pins', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' })
    await s.commitAndActivate('a', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'b', mutualKey: 'k' })
    await s.commitAndActivate('b', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'c', mutualKey: 'k' })
    await s.writeProvisionalUnacked(Q, { credentialId: 'q', mutualKey: 'k' })

    // §12: each returned id still has a PinStore entry keyed by it, and the
    // caller MUST clear those pins or an orphan accumulates per interrupted
    // rotation. Returning them is how that obligation stays visible.
    expect((await s.prunePrincipalExcept(P, 'b')).sort()).toEqual(['a', 'c'])
    // Nothing left to delete: an empty array, not the surviving id.
    expect(await s.prunePrincipalExcept(P, 'b')).toEqual([])
    // A principal with nothing stored at all also prunes to nothing.
    expect(await s.prunePrincipalExcept(Q, 'q')).toEqual([])
    expect(await ids(s, P)).toEqual(['b'])
    expect(await ids(s, Q)).toEqual(['q'])
  })

  it('hasCommittedCredential is false with nothing stored and with only a provisional entry', async () => {
    const s = new CredentialStore()
    expect(await s.hasCommittedCredential(P)).toBe(false)
    await s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' })
    expect(await s.hasCommittedCredential(P)).toBe(false)
  })

  it('hasCommittedCredential is true once a credential commits, for that principal only', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' })
    await s.commitAndActivate('a', P)
    expect(await s.hasCommittedCredential(P)).toBe(true)
    expect(await s.hasCommittedCredential(Q)).toBe(false)
  })

  it('revokeAll deletes every credential of the principal, regardless of state', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' })
    await s.commitAndActivate('a', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'b', mutualKey: 'k' })
    await s.writeProvisionalUnacked(Q, { credentialId: 'q', mutualKey: 'k' })

    expect((await s.revokeAll(P)).sort()).toEqual(['a', 'b'])
    expect(await ids(s, P)).toEqual([])
    // A different principal is untouched.
    expect(await ids(s, Q)).toEqual(['q'])
  })

  it('revokeAll runs beforeDelete with the ids it is about to delete, and no-ops on nothing stored', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' })
    await s.commitAndActivate('a', P)

    const seen: string[][] = []
    expect(
      await s.revokeAll(P, async (revokedIds) => {
        seen.push([...revokedIds])
      })
    ).toEqual(['a'])
    expect(seen).toEqual([['a']])

    // Nothing left for P: a second call is a genuine no-op, and beforeDelete
    // must not fire for an empty revocation.
    expect(
      await s.revokeAll(P, async () => {
        throw new Error('beforeDelete must not run with nothing to revoke')
      })
    ).toEqual([])
  })

  it('does not age out an unacked provisional that is younger than 10 min', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'u1', mutualKey: 'k' })
    await s.ageOutUnacked(Date.now() + 9 * 60_000)
    expect(await ids(s)).toEqual(['u1'])
  })

  // Review round 6: a crash after the committed write but before pruning
  // legitimately leaves two committed entries with the pointer on the
  // predecessor. commitAndActivate must therefore never delete the
  // predecessor itself — pruning is a separate, later, post-auth step.
  it('keeps the predecessor committed until the post-auth prune runs', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'old', mutualKey: 'k1' })
    await s.commitAndActivate('old', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'new', mutualKey: 'k2' })
    await s.commitAndActivate('new', P)

    const stored = persisted()
    expect(stored.activeCredentialId).toBe('new')
    expect(
      stored.credentials
        .filter((c) => c.state === 'committed')
        .map((c) => c.credentialId)
        .sort()
    ).toEqual(['new', 'old'])
    // Active first, then the other committed entry — the pointer, not a guess,
    // disambiguates the two.
    expect(await ids(s)).toEqual(['new', 'old'])
  })

  it('commits state and the active pointer in a single storage write', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await s.markCommitUncertain('c1')
    const setSpy = browser.storage.local.set as ReturnType<typeof vi.fn>
    setSpy.mockClear()
    await s.commitAndActivate('c1', P)
    // §6.7 durable-commit ordering: state and pointer can never disagree, so
    // they may not be persisted by two separate writes.
    expect(setSpy).toHaveBeenCalledTimes(1)
    const stored = persisted()
    expect(stored.activeCredentialId).toBe('c1')
    expect(stored.credentials[0]?.state).toBe('committed')
    expect(stored.credentials[0]).not.toHaveProperty('sub')
  })

  it('orders active, then other committed, then remaining provisional', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await s.commitAndActivate('c1', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'c2', mutualKey: 'k' })
    await s.commitAndActivate('c2', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'u3', mutualKey: 'k' })
    expect(await ids(s)).toEqual(['c2', 'c1', 'u3'])
  })

  it('orders the newest commit-uncertain first when none is active', async () => {
    // Seeded rather than written, because the new offer rule makes two
    // commit-uncertain successors with nothing committed unreachable through
    // this store's own writes — a second distinct offer in that state is
    // refused. `recoverOrder` is a recovery function, so it still has to be
    // correct on a state it cannot itself produce: data written by an older
    // build, or a partial write. Seeding is how that gets tested at all.
    const key = principalKey(P)
    backing = {
      [STORAGE_KEY]: {
        version: 1,
        activeCredentialId: null,
        credentials: [
          {
            credentialId: 'a1',
            mutualKey: 'k',
            principalKey: key,
            state: 'provisional',
            sub: 'commit-uncertain',
            createdAt: clock,
          },
          {
            credentialId: 'a2',
            mutualKey: 'k',
            principalKey: key,
            state: 'provisional',
            sub: 'commit-uncertain',
            createdAt: clock + 1000,
          },
        ],
      },
    }
    expect(await ids(new CredentialStore())).toEqual(['a2', 'a1'])
  })

  it('prefers a commit-uncertain over a committed one that is not active', async () => {
    const s = new CredentialStore()
    // Reach the state the group order actually depends on: a committed
    // credential with the pointer *not* on it, alongside a commit-uncertain
    // one. The public prune API now refuses to delete the active target, so
    // clear the persisted pointer directly to model a crash/older writer.
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await s.commitAndActivate('c1', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'c2', mutualKey: 'k' })
    await s.commitAndActivate('c2', P)
    for (const key of Object.keys(persisted().activeCredentialIds)) {
      delete persisted().activeCredentialIds[key]
    }
    expect(persisted().activeCredentialId).toBeNull()

    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    // §6.7 recovery order: the newest commit-uncertain is tried before any
    // other committed credential, because the server may already have
    // committed it and revoked the rest.
    expect(await ids(s)).toEqual(['cu', 'c2', 'c1'])
  })

  it('bounds the retained set by dropping only an older unacked provisional', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'u1', mutualKey: 'k' })
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'u2', mutualKey: 'k' })
    expect(await ids(s)).toEqual(['u2'])
  })

  it('keeps a commit-uncertain successor when a committed credential exists', async () => {
    // The one path to three entries, and it is the correct one: with a
    // committed credential present, this side cannot tell "the server committed
    // my successor and this offer is the next rotation" from "the server expired
    // it and this offer is a retry". In the first case the successor is the live
    // credential, so dropping it would strand (§6.7).
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c0', mutualKey: 'k' })
    await s.commitAndActivate('c0', P)
    await s.writeProvisionalUnacked(P, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'u2', mutualKey: 'k' })
    expect((await ids(s)).sort()).toEqual(['c0', 'cu', 'u2'])
  })

  it('refuses a different offer while a live commit-uncertain is held', async () => {
    // §6.7 keys the server's single provisional slot by
    // `{principal, currentCommittedCredentialId}` and requires a repeat offer
    // for that pair to re-send the identical `{credentialId, mutualKey}`. A
    // different id contradicts that, and accepting it is unbounded by
    // construction — nothing evicts a `commit-uncertain`, so a peer minting a
    // fresh id per attempt would add a stale mutual key per pairing.
    //
    // Refusing is safe precisely because the held successor is still live: an
    // authenticated reconnect can still resolve it, so declining costs nothing
    // that stacking would have preserved.
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    advance(1000)
    await expect(
      s.writeProvisionalUnacked(P, { credentialId: 'other', mutualKey: 'k' })
    ).rejects.toBeInstanceOf(OfferContradictsSlotError)
    expect(await ids(s)).toEqual(['cu'])
  })

  it('drops a first-pair commit-uncertain the server can no longer hold', async () => {
    // Past the server's 10-minute provisional TTL with nothing committed, the
    // successor is provably gone server-side: unusable, and with no committed
    // sibling there is nothing to be stranded on. So a fresh offer is the server
    // legitimately minting a new one, and the stale entry goes — the same
    // licence `cleanupFirstPairOrphans` operates under, applied at the moment
    // the replacement actually arrives.
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, {
      credentialId: 'stale',
      mutualKey: 'k',
    })
    await s.markCommitUncertain('stale')
    advance(11 * 60_000)
    await s.writeProvisionalUnacked(P, {
      credentialId: 'fresh',
      mutualKey: 'k',
    })
    expect(await ids(s)).toEqual(['fresh'])
  })

  it('permits committed + N commit-uncertain, which the flow is what bounds', async () => {
    // What the store allows, stated precisely, because the previous version of
    // this test said "accumulate without bound" and that is no longer true.
    //
    // With a committed credential present the store accepts each distinct offer
    // and retains the earlier successors, because it cannot tell "the server
    // committed that successor and this is the next rotation" from "the server
    // expired it and this is a retry" — and dropping it in the first case would
    // strand. So the store's own bound is `committed + N`, not `committed + 1`.
    //
    // The §6.7 bound is restored one layer up, not here: a rotation offer only
    // arrives inside an authenticated session, and the mandatory post-auth prune
    // runs before it, so production reaches at most one successor at a time. A
    // first-pair offer that contradicts a live successor is refused outright by
    // the test above. This state is therefore reachable only by bypassing the
    // flow — which is exactly what this test does, deliberately, to pin what the
    // store will and will not do on its own.
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, {
      credentialId: 'committed',
      mutualKey: 'k',
    })
    await s.commitAndActivate('committed', P)

    for (const id of ['cu1', 'cu2', 'cu3']) {
      advance(1000)
      await s.writeProvisionalUnacked(P, { credentialId: id, mutualKey: 'k' })
      await s.markCommitUncertain(id)
    }

    expect((await ids(s)).sort()).toEqual(['committed', 'cu1', 'cu2', 'cu3'])
    // None is `unacked`, which is why the eviction in `writeProvisionalUnacked`
    // never reclaims any of them.
    const stored = persisted().credentials.filter(
      (c) => c.credentialId !== 'committed'
    )
    expect(stored.every((c) => c.sub === 'commit-uncertain')).toBe(true)
  })

  it('treats an identical re-offer as idempotent and never downgrades it', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k1' })
    await s.markCommitUncertain('c1')
    // The server's §6.7 idempotent re-offer path re-sends the *same*
    // {credentialId, mutualKey} it already persisted. Appending a duplicate
    // would make markCommitUncertain ambiguous; overwriting would reset the
    // durable write-ahead and re-expose the credential to age-out.
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k1' })
    expect(persisted().credentials).toHaveLength(1)
    expect(persisted().credentials[0]?.sub).toBe('commit-uncertain')
    await s.ageOutUnacked(Date.now() + 11 * 60_000)
    expect(await ids(s)).toEqual(['c1'])
  })

  it('throws instead of no-opping on an unknown credentialId', async () => {
    const s = new CredentialStore()
    // A silent no-op would let the flow transmit credentialAck believing the
    // durable write-ahead landed when it did not (review round 5).
    await expect(s.markCommitUncertain('nope')).rejects.toThrow(
      /unknown credential/i
    )
    await expect(s.commitAndActivate('nope', P)).rejects.toThrow(
      /unknown credential/i
    )
    expect(backing[STORAGE_KEY]).toBeUndefined()
  })

  it('keeps the credentialId out of the thrown message', async () => {
    const s = new CredentialStore()
    // §11: nothing credential-shaped may leak into a message that a caller may
    // log. The id is the only attacker-influenced value reaching this path.
    const error = await s.markCommitUncertain('leaky-id').catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('leaky-id')
  })

  it('leaves an already-committed credential untouched on markCommitUncertain', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await s.commitAndActivate('c1', P)
    await s.markCommitUncertain('c1')
    // `committed` is strictly stronger than the write-ahead this flips on, so
    // downgrading it would lose state the pointer still claims.
    expect(persisted().credentials[0]?.state).toBe('committed')
    expect(persisted().credentials[0]).not.toHaveProperty('sub')
    expect(persisted().activeCredentialId).toBe('c1')
  })

  it('refuses to activate a credential belonging to another principal', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await expect(s.commitAndActivate('c1', Q)).rejects.toThrow(/principal/i)
    expect(persisted().activeCredentialId).toBeNull()
  })

  it('isolates principals across prune, recover, and the retained bound', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'p1', mutualKey: 'k' })
    await s.commitAndActivate('p1', P)
    await s.writeProvisionalUnacked(Q, { credentialId: 'q1', mutualKey: 'k' })
    await s.commitAndActivate('q1', Q)
    // Per-principal, so Q's provisional does not evict P's.
    await s.writeProvisionalUnacked(P, { credentialId: 'p2', mutualKey: 'k' })
    await s.writeProvisionalUnacked(Q, { credentialId: 'q2', mutualKey: 'k' })
    expect((await ids(s, P)).sort()).toEqual(['p1', 'p2'])
    expect((await ids(s, Q)).sort()).toEqual(['q1', 'q2'])
    // §6.7: rotating one principal's credential MUST NOT affect another's.
    await s.commitAndActivate('p2', P)
    await s.prunePrincipalExcept(P, 'p2')
    expect(await ids(s, P)).toEqual(['p2'])
    expect((await ids(s, Q)).sort()).toEqual(['q1', 'q2'])
  })

  it('keys principals injectively, not by a delimiter join', async () => {
    // Two distinct principals whose fields concatenate to the same string
    // under any single-delimiter join. Sharing a key would merge their
    // credential sets, so one principal's prune would delete the other's.
    const left = {
      browser: 'chromium',
      verifiedOrigin: 'chrome-extension://a:b',
      clientInstallationId: 'c',
    }
    const right = {
      browser: 'chromium',
      verifiedOrigin: 'chrome-extension://a',
      clientInstallationId: 'b:c',
    }
    expect(principalKey(left)).not.toBe(principalKey(right))

    const s = new CredentialStore()
    await s.writeProvisionalUnacked(left, {
      credentialId: 'L',
      mutualKey: 'k',
    })
    await s.writeProvisionalUnacked(right, {
      credentialId: 'R',
      mutualKey: 'k',
    })
    // Both are `unacked`; a shared key would make the second write evict the
    // first under the retained-set bound.
    expect(await ids(s, left)).toEqual(['L'])
    expect(await ids(s, right)).toEqual(['R'])
  })

  it('drops a first-pair commit-uncertain orphan once the server TTL elapsed', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    await s.cleanupFirstPairOrphans(P, Date.now() + 9 * 60_000)
    expect(await ids(s)).toEqual(['cu']) // TTL has not provably elapsed yet
    await s.cleanupFirstPairOrphans(P, Date.now() + 11 * 60_000)
    expect(await ids(s)).toEqual([])
    expect(backing[STORAGE_KEY]).toBeUndefined()
  })

  it('never treats a rotation commit-uncertain as a first-pair orphan', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'com', mutualKey: 'k' })
    await s.commitAndActivate('com', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'cu', mutualKey: 'k' })
    await s.markCommitUncertain('cu')
    // A committed predecessor exists, so only reconnect can prove which of the
    // two the server kept — age is not evidence (§6.7).
    await s.cleanupFirstPairOrphans(P, Date.now() + 60 * 60_000)
    expect((await ids(s)).sort()).toEqual(['com', 'cu'])
  })

  it('scopes first-pair orphan cleanup to the given principal', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(Q, { credentialId: 'q-cu', mutualKey: 'k' })
    await s.markCommitUncertain('q-cu')
    await s.cleanupFirstPairOrphans(P, Date.now() + 11 * 60_000)
    expect(await ids(s, Q)).toEqual(['q-cu'])
  })

  it('refuses to prune the active credential in favor of a provisional keep', async () => {
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'k' })
    await s.commitAndActivate('c1', P)
    advance(1000)
    await s.writeProvisionalUnacked(P, { credentialId: 'c2', mutualKey: 'k' })
    await expect(s.prunePrincipalExcept(P, 'c2')).rejects.toBeInstanceOf(
      CredentialFinalizeConflictError
    )
    expect(persisted().activeCredentialId).toBe('c1')
    expect(await ids(s)).toEqual(['c1', 'c2'])
  })

  it('serializes concurrent mutations instead of losing writes', async () => {
    const s = new CredentialStore()
    await Promise.all([
      s.writeProvisionalUnacked(P, { credentialId: 'a', mutualKey: 'k' }),
      s.writeProvisionalUnacked(Q, { credentialId: 'b', mutualKey: 'k' }),
    ])
    // Read-modify-write against storage.local: without the queue the second
    // write reads the pre-first snapshot and clobbers it.
    expect(persisted().credentials).toHaveLength(2)
  })

  it('returns the stored mutualKey to callers unchanged', async () => {
    const s = new CredentialStore()
    const mutualKey = 'zm8Ln-Qx7Y_abcdefghijklmnopqrstuvwxyz012345'
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey })
    const [recovered] = await s.recoverOrder(P)
    // base64url string form, as the server generates and stores it: this layer
    // does not decode it.
    expect(recovered?.mutualKey).toBe(mutualKey)
  })

  it('fails closed on a corrupt container and preserves it across mutations', async () => {
    const s = new CredentialStore()
    const corrupt = { version: 2, credentials: 'nope' }
    backing[STORAGE_KEY] = corrupt
    const setSpy = browser.storage.local.set as ReturnType<typeof vi.fn>
    const removeSpy = browser.storage.local.remove as ReturnType<typeof vi.fn>
    setSpy.mockClear()
    removeSpy.mockClear()
    expect(await ids(s)).toEqual([])
    await expect(
      s.writeProvisionalUnacked(P, {
        credentialId: 'must-not-overwrite',
        mutualKey: 'key',
      })
    ).rejects.toBeInstanceOf(CorruptCredentialStoreError)
    await expect(s.revokeAuthority(SERVER_A)).rejects.toBeInstanceOf(
      CorruptCredentialStoreError
    )
    expect(setSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(backing[STORAGE_KEY]).toBe(corrupt)

    // A failed retirement deliberately keeps this authority closed in the
    // current service-worker realm. Model repair, then retry so the test does
    // not leak that lifecycle fence into later cases.
    delete backing[STORAGE_KEY]
    await expect(s.revokeAuthority(SERVER_A)).resolves.toEqual([])
  })

  it('survives a future-version stored record', async () => {
    const s = new CredentialStore()
    // Version-gated independently of shape: a future version carrying a
    // perfectly well-formed entry is still uninterpretable, since this code
    // cannot know what that version's state fields mean.
    backing[STORAGE_KEY] = {
      version: 3,
      credentials: [
        {
          credentialId: 'future',
          mutualKey: 'k',
          principalKey: principalKey(P),
          state: 'committed',
          createdAt: 1,
        },
      ],
      activeCredentialIds: { future: 'future' },
    }
    expect(await ids(s)).toEqual([])
    backing[STORAGE_KEY] = {
      version: 1,
      credentials: [
        {
          credentialId: 'ok',
          mutualKey: 'k',
          principalKey: principalKey(P),
          state: 'committed',
          createdAt: 1,
        },
        {
          credentialId: 'bad-state',
          mutualKey: 'k',
          principalKey: principalKey(P),
          state: 'weird',
          createdAt: 1,
        },
        {
          credentialId: 'no-sub',
          mutualKey: 'k',
          principalKey: principalKey(P),
          state: 'provisional',
          createdAt: 1,
        },
        {
          // No key means no reconnect MAC: handing this to the flow would
          // burn an authentication attempt that can never succeed.
          credentialId: 'no-key',
          mutualKey: '',
          principalKey: principalKey(P),
          state: 'committed',
          createdAt: 1,
        },
      ],
      activeCredentialId: 'gone',
    }
    // Unusable entries are dropped individually; a usable one is never
    // discarded alongside them, and a pointer to nothing reads as unset.
    expect(await ids(s)).toEqual(['ok'])
  })

  it('survives repeated MV3 root reconstruction through commit-uncertain recovery, rotation, and revoke', async () => {
    const firstWorker = new CredentialStore().forAuthorityForTest(SERVER_A)
    await firstWorker.writeProvisionalUnacked(
      P,
      { credentialId: 'first', mutualKey: 'first-key' },
      INSTANCE_A
    )
    await firstWorker.markCommitUncertain('first')

    const afterPairSuspend = new CredentialStore().forAuthorityForTest(SERVER_A)
    expect(await afterPairSuspend.recoverOrder(P)).toMatchObject([
      { credentialId: 'first', state: 'provisional', sub: 'commit-uncertain' },
    ])
    await afterPairSuspend.commitAndActivate('first', P, INSTANCE_A)
    await afterPairSuspend.finalizeAndPrune('first', P, INSTANCE_A)

    await afterPairSuspend.writeProvisionalUnacked(
      P,
      { credentialId: 'rotated', mutualKey: 'rotated-key' },
      INSTANCE_A
    )
    await afterPairSuspend.markCommitUncertain('rotated')

    const afterRotateSuspend = new CredentialStore().forAuthorityForTest(
      SERVER_A
    )
    expect(
      (await afterRotateSuspend.recoverOrder(P)).map(
        ({ credentialId }) => credentialId
      )
    ).toEqual(['first', 'rotated'])
    await afterRotateSuspend.commitAndActivate('rotated', P, INSTANCE_A)
    await afterRotateSuspend.finalizeAndPrune('rotated', P, INSTANCE_A)

    const afterReconnect = new CredentialStore().forAuthorityForTest(SERVER_A)
    expect(
      (await afterReconnect.recoverOrder(P)).map(
        ({ credentialId }) => credentialId
      )
    ).toEqual(['rotated'])
    await afterReconnect.revokeAll(P)

    const afterRevokeSuspend = new CredentialStore().forAuthorityForTest(
      SERVER_A
    )
    expect(await afterRevokeSuspend.recoverOrder(P)).toEqual([])
  })

  it('isolates local, Server A, and Server B even when all reuse one credential id', async () => {
    const root = new CredentialStore()
    const local = root.forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
    const a = root.forAuthorityForTest(SERVER_A)
    const b = root.forAuthorityForTest(SERVER_B)

    await local.writeProvisionalUnacked(
      P,
      { credentialId: 'shared-id', mutualKey: 'local-key' },
      null
    )
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'shared-id', mutualKey: 'a-key' },
      INSTANCE_A
    )
    await b.writeProvisionalUnacked(
      P,
      { credentialId: 'shared-id', mutualKey: 'b-key' },
      INSTANCE_B
    )
    await local.commitAndActivate('shared-id', P, null)
    await a.commitAndActivate('shared-id', P, INSTANCE_A)
    await b.commitAndActivate('shared-id', P, INSTANCE_B)

    expect((await local.recoverOrder(P))[0]).toMatchObject({
      credentialId: 'shared-id',
      mutualKey: 'local-key',
      authenticatedInstanceId: null,
    })
    expect((await a.recoverOrder(P))[0]).toMatchObject({
      credentialId: 'shared-id',
      mutualKey: 'a-key',
      authenticatedInstanceId: INSTANCE_A,
    })
    expect((await b.recoverOrder(P))[0]).toMatchObject({
      credentialId: 'shared-id',
      mutualKey: 'b-key',
      authenticatedInstanceId: INSTANCE_B,
    })

    const stored = persisted()
    expect(stored.version).toBe(2)
    expect(stored.credentials).toHaveLength(3)
    expect(
      new Set(stored.credentials.map((credential) => credential.authorityKey))
    ).toEqual(
      new Set([
        backendAuthorityKey(LOCAL_BACKEND_AUTHORITY),
        backendAuthorityKey(SERVER_A),
        backendAuthorityKey(SERVER_B),
      ])
    )
  })

  it('requires a remote authenticated instance and detects same-authority id collisions without leaking values', async () => {
    const a = new CredentialStore().forAuthorityForTest(SERVER_A)
    await expect(
      a.writeProvisionalUnacked(
        P,
        { credentialId: 'remote-id', mutualKey: 'secret-key' },
        null
      )
    ).rejects.toThrow(/instance/i)
    expect(backing[STORAGE_KEY]).toBeUndefined()

    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'remote-id', mutualKey: 'secret-key' },
      INSTANCE_A
    )
    await a.markCommitUncertain('remote-id')
    // An exact re-offer is idempotent and cannot downgrade the write-ahead.
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'remote-id', mutualKey: 'secret-key' },
      INSTANCE_A
    )
    expect(persisted().credentials).toHaveLength(1)
    expect(persisted().credentials[0]?.sub).toBe('commit-uncertain')

    for (const attempt of [
      () =>
        a.writeProvisionalUnacked(
          P,
          { credentialId: 'remote-id', mutualKey: 'other-key' },
          INSTANCE_A
        ),
      () =>
        a.writeProvisionalUnacked(
          Q,
          { credentialId: 'remote-id', mutualKey: 'secret-key' },
          INSTANCE_A
        ),
    ]) {
      const error = await attempt().catch((caught) => caught)
      expect(error).toBeInstanceOf(CredentialCollisionError)
      expect((error as Error).message).not.toContain('remote-id')
      expect((error as Error).message).not.toContain('secret-key')
      expect((error as Error).message).not.toContain('other-instance')
    }

    const identityError = await a
      .writeProvisionalUnacked(
        P,
        { credentialId: 'remote-id', mutualKey: 'secret-key' },
        'other-instance'
      )
      .catch((caught) => caught)
    expect(identityError).toBeInstanceOf(CredentialInstanceMismatchError)
    expect((identityError as Error).message).not.toContain('other-instance')
  })

  it('rechecks authenticated instance on commit and never exposes a corrupt remote null-instance row', async () => {
    const a = new CredentialStore().forAuthorityForTest(SERVER_A)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'remote-id', mutualKey: 'secret-key' },
      INSTANCE_A
    )

    await expect(
      a.commitAndActivate('remote-id', P, 'different-instance')
    ).rejects.toBeInstanceOf(CredentialInstanceMismatchError)
    expect(persisted().credentials[0]?.state).toBe('provisional')

    await a.commitAndActivate('remote-id', P, INSTANCE_A)
    const row = persisted().credentials[0]
    if (row === undefined) throw new Error('test setup missing credential')
    row.authenticatedInstanceId = null

    expect(await a.recoverOrder(P)).toEqual([])
    expect(await a.hasCommittedCredential(P)).toBe(false)
    await expect(a.markCommitUncertain('remote-id')).rejects.toThrow(
      /unknown credential/i
    )
  })

  it('binds one authenticated instance across every principal in a remote authority', async () => {
    const a = new CredentialStore().forAuthorityForTest(SERVER_A)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'p-a', mutualKey: 'p-key' },
      INSTANCE_A
    )
    await a.commitAndActivate('p-a', P, INSTANCE_A)

    const beforeMismatch = structuredClone(backing[STORAGE_KEY])
    await expect(
      a.writeProvisionalUnacked(
        Q,
        { credentialId: 'q-b', mutualKey: 'q-key' },
        INSTANCE_B
      )
    ).rejects.toBeInstanceOf(CredentialInstanceMismatchError)
    expect(backing[STORAGE_KEY]).toEqual(beforeMismatch)

    // A second principal is fine when it authenticated the same server.
    await a.writeProvisionalUnacked(
      Q,
      { credentialId: 'q-a', mutualKey: 'q-key' },
      INSTANCE_A
    )

    // A corrupted mixed-instance authority is never partially trusted: commit
    // is refused and no reconnect candidate is exposed until explicit Forget.
    const raw = backing[STORAGE_KEY] as {
      credentials: Array<Record<string, unknown>>
    }
    raw.credentials.push({
      ...raw.credentials[0],
      credentialId: 'injected-b',
      authenticatedInstanceId: INSTANCE_B,
    })
    await expect(
      a.commitAndActivate('q-a', Q, INSTANCE_A)
    ).rejects.toBeInstanceOf(CredentialInstanceMismatchError)
    expect(await a.recoverOrder(P)).toEqual([])
    expect(await a.hasCommittedCredential(P)).toBe(false)
  })

  it('drops a future-dated remote null-instance row before slot and duplicate checks', async () => {
    const authorityKey = backendAuthorityKey(SERVER_A)
    const key = principalKey(P)
    backing[STORAGE_KEY] = {
      version: 2,
      credentials: [
        {
          authorityKey,
          credentialId: 'same-id',
          mutualKey: 'untrusted-null-key',
          principalKey: key,
          state: 'provisional',
          sub: 'commit-uncertain',
          createdAt: Date.now() + 365 * 24 * 60 * 60_000,
          authenticatedInstanceId: null,
        },
        {
          authorityKey,
          credentialId: 'same-id',
          mutualKey: 'valid-key',
          principalKey: key,
          state: 'committed',
          createdAt: Date.now(),
          authenticatedInstanceId: INSTANCE_A,
        },
      ],
      activeCredentialIds: {},
    }
    const a = new CredentialStore().forAuthorityForTest(SERVER_A)

    // The malformed null row neither poisons the valid duplicate nor occupies
    // a live commit-uncertain slot forever.
    expect(await ids(a)).toEqual(['same-id'])
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'fresh', mutualKey: 'fresh-key' },
      INSTANCE_A
    )
    expect(
      persisted()
        .credentials.map((row) => row.credentialId)
        .sort()
    ).toEqual(['fresh', 'same-id'])
    expect(
      persisted().credentials.every(
        (row) => row.authenticatedInstanceId !== null
      )
    ).toBe(true)
  })

  it('keeps an independent active pointer for every authority and principal', async () => {
    const root = new CredentialStore()
    const local = root.forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
    const a = root.forAuthorityForTest(SERVER_A)
    const b = root.forAuthorityForTest(SERVER_B)

    await local.writeProvisionalUnacked(
      P,
      { credentialId: 'local', mutualKey: 'k' },
      null
    )
    await local.commitAndActivate('local', P, null)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a-old', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.commitAndActivate('a-old', P, INSTANCE_A)
    advance(1000)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a-new', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.commitAndActivate('a-new', P, INSTANCE_A)
    await a.writeProvisionalUnacked(
      Q,
      { credentialId: 'a-q', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.commitAndActivate('a-q', Q, INSTANCE_A)
    await b.writeProvisionalUnacked(
      P,
      { credentialId: 'b', mutualKey: 'k' },
      INSTANCE_B
    )
    await b.commitAndActivate('b', P, INSTANCE_B)

    expect(await ids(local)).toEqual(['local'])
    expect(await ids(a)).toEqual(['a-new', 'a-old'])
    expect(await ids(a, Q)).toEqual(['a-q'])
    expect(await ids(b)).toEqual(['b'])
    expect(Object.keys(persisted().activeCredentialIds)).toHaveLength(4)
    expect(Object.values(persisted().activeCredentialIds).sort()).toEqual([
      'a-new',
      'a-q',
      'b',
      'local',
    ])
  })

  it('scopes prune, revoke, age-out, and orphan cleanup to one authority', async () => {
    const root = new CredentialStore()
    const a = root.forAuthorityForTest(SERVER_A)
    const b = root.forAuthorityForTest(SERVER_B)

    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a-old', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.commitAndActivate('a-old', P, INSTANCE_A)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a-new', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.commitAndActivate('a-new', P, INSTANCE_A)
    await b.writeProvisionalUnacked(
      P,
      { credentialId: 'b-live', mutualKey: 'k' },
      INSTANCE_B
    )
    await b.commitAndActivate('b-live', P, INSTANCE_B)
    await a.prunePrincipalExcept(P, 'a-new')
    expect(await ids(a)).toEqual(['a-new'])
    expect(await ids(b)).toEqual(['b-live'])

    await a.writeProvisionalUnacked(
      Q,
      { credentialId: 'a-stale', mutualKey: 'k' },
      INSTANCE_A
    )
    await b.writeProvisionalUnacked(
      Q,
      { credentialId: 'b-stale', mutualKey: 'k' },
      INSTANCE_B
    )
    await a.ageOutUnacked(Date.now() + 11 * 60_000)
    expect(await ids(a, Q)).toEqual([])
    expect(await ids(b, Q)).toEqual(['b-stale'])

    await a.writeProvisionalUnacked(
      Q,
      { credentialId: 'a-orphan', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.markCommitUncertain('a-orphan')
    await b.markCommitUncertain('b-stale')
    await a.cleanupFirstPairOrphans(Q, Date.now() + 11 * 60_000)
    expect(await ids(a, Q)).toEqual([])
    expect(await ids(b, Q)).toEqual(['b-stale'])

    expect(await a.revokeAll(P)).toEqual(['a-new'])
    expect(await ids(a)).toEqual([])
    expect(await ids(b)).toEqual(['b-live'])
  })

  it('serializes views from separate roots through one module queue', async () => {
    const firstRoot = new CredentialStore()
    const secondRoot = new CredentialStore()
    const firstA = firstRoot.forAuthorityForTest(SERVER_A)
    const secondA = secondRoot.forAuthorityForTest(SERVER_A)
    const secondB = secondRoot.forAuthorityForTest(SERVER_B)

    await Promise.all([
      firstA.writeProvisionalUnacked(
        P,
        { credentialId: 'a-p', mutualKey: 'k' },
        INSTANCE_A
      ),
      secondA.writeProvisionalUnacked(
        Q,
        { credentialId: 'a-q', mutualKey: 'k' },
        INSTANCE_A
      ),
      secondB.writeProvisionalUnacked(
        P,
        { credentialId: 'b-p', mutualKey: 'k' },
        INSTANCE_B
      ),
      firstRoot.writeProvisionalUnacked(P, {
        credentialId: 'local-p',
        mutualKey: 'k',
      }),
    ])

    expect(await ids(firstA)).toEqual(['a-p'])
    expect(await ids(secondA, Q)).toEqual(['a-q'])
    expect(await ids(secondB)).toEqual(['b-p'])
    expect(await ids(firstRoot)).toEqual(['local-p'])
    expect(persisted().credentials).toHaveLength(4)
  })

  it('issues nominal scoped lifecycle views and resolves the legacy root only to local', () => {
    expectTypeOf<AuthorityCredentialStore>().toMatchTypeOf<CredentialLifecycleStore>()
    expectTypeOf<CredentialStore>().not.toMatchTypeOf<CredentialLifecycleStore>()

    const root = new CredentialStore()
    const remote = root.forAuthorityForTest(SERVER_A)
    expect(resolveCredentialLifecycleStore(remote)).toBe(remote)
    expect(resolveCredentialLifecycleStore(root)).not.toBe(root)
    expect(() =>
      resolveCredentialLifecycleStore({} as unknown as CredentialLifecycleStore)
    ).toThrow(/not issued/i)
    expect(() =>
      resolveCredentialLifecycleStore({
        ...remote,
      } as unknown as CredentialLifecycleStore)
    ).toThrow(/not issued/i)
  })

  it('finalizes and prunes atomically across two roots without deleting both candidates', async () => {
    const first = new CredentialStore().forAuthorityForTest(SERVER_A)
    const second = new CredentialStore().forAuthorityForTest(SERVER_A)
    await first.writeProvisionalUnacked(
      P,
      { credentialId: 'old', mutualKey: 'old-key' },
      INSTANCE_A
    )
    await first.commitAndActivate('old', P, INSTANCE_A)
    await first.writeProvisionalUnacked(
      P,
      { credentialId: 'candidate-a', mutualKey: 'a-key' },
      INSTANCE_A
    )
    await first.markCommitUncertain('candidate-a')
    await second.writeProvisionalUnacked(
      P,
      { credentialId: 'candidate-b', mutualKey: 'b-key' },
      INSTANCE_A
    )
    await second.markCommitUncertain('candidate-b')

    let releaseFirst: (() => void) | undefined
    let firstEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstFinalize = first.finalizeAndPrune(
      'candidate-a',
      P,
      INSTANCE_A,
      async (idsToDelete) => {
        expect(Object.isFrozen(idsToDelete)).toBe(true)
        firstEntered?.()
        await release
      }
    )
    await entered

    let secondSettled = false
    const secondFinalize = second
      .finalizeAndPrune('candidate-b', P, INSTANCE_A)
      .finally(() => {
        secondSettled = true
      })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    releaseFirst?.()
    await expect(firstFinalize).resolves.toEqual(
      expect.arrayContaining(['old', 'candidate-b'])
    )
    await expect(secondFinalize).rejects.toThrow(/unknown credential/i)
    expect(await ids(first)).toEqual(['candidate-a'])
    expect(persisted().activeCredentialId).toBe('candidate-a')
  })

  it('tombstones an authority before queued revocation can be followed by a stale write', async () => {
    const firstRoot = new CredentialStore()
    const secondRoot = new CredentialStore()
    const stale = firstRoot.forAuthorityForTest(SERVER_A)
    await stale.writeProvisionalUnacked(
      P,
      { credentialId: 'existing', mutualKey: 'old-key' },
      INSTANCE_A
    )

    // The write joins the promise queue first, but revoke advances the
    // generation synchronously. Its in-queue recheck therefore rejects it.
    const queuedWrite = stale.writeProvisionalUnacked(
      Q,
      { credentialId: 'late', mutualKey: 'late-key' },
      INSTANCE_A
    )
    let releaseRevoke: (() => void) | undefined
    let revokeEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      revokeEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseRevoke = resolve
    })
    const revoke = secondRoot.revokeAuthority(SERVER_A, async () => {
      revokeEntered?.()
      await release
    })

    await expect(queuedWrite).rejects.toBeInstanceOf(
      CredentialAuthorityRevokedError
    )
    await entered
    const issuedDuringRevoke = firstRoot.forAuthorityForTest(SERVER_A)
    await expect(
      issuedDuringRevoke.writeProvisionalUnacked(
        P,
        { credentialId: 'during', mutualKey: 'during-key' },
        INSTANCE_A
      )
    ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)
    releaseRevoke?.()
    await expect(revoke).resolves.toEqual(['existing'])

    await expect(
      stale.writeProvisionalUnacked(
        P,
        { credentialId: 'stale-after', mutualKey: 'stale-key' },
        INSTANCE_A
      )
    ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)
    await expect(
      issuedDuringRevoke.writeProvisionalUnacked(
        P,
        { credentialId: 'also-stale', mutualKey: 'stale-key' },
        INSTANCE_A
      )
    ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)

    const fresh = firstRoot.forAuthorityForTest(SERVER_A)
    await fresh.writeProvisionalUnacked(
      P,
      { credentialId: 'fresh', mutualKey: 'fresh-key' },
      INSTANCE_A
    )
    expect(await ids(fresh)).toEqual(['fresh'])
  })

  it.each(['set', 'remove'] as const)(
    'keeps the authority tombstoned after a failed durable %s and reopens only after retry',
    async (failingMethod) => {
      const root = new CredentialStore()
      const stale = root.forAuthorityForTest(SERVER_A)
      await stale.writeProvisionalUnacked(
        P,
        { credentialId: 'existing', mutualKey: 'old-key' },
        INSTANCE_A
      )
      if (failingMethod === 'set') {
        const other = root.forAuthorityForTest(SERVER_B)
        await other.writeProvisionalUnacked(
          P,
          { credentialId: 'other-authority', mutualKey: 'other-key' },
          INSTANCE_B
        )
        const setSpy = browser.storage.local.set as ReturnType<typeof vi.fn>
        setSpy.mockRejectedValueOnce(new Error('durable set failed'))
      } else {
        const removeSpy = browser.storage.local.remove as ReturnType<
          typeof vi.fn
        >
        removeSpy.mockRejectedValueOnce(new Error('durable remove failed'))
      }

      await expect(root.revokeAuthority(SERVER_A)).rejects.toThrow(/failed/i)
      const issuedAfterFailure = root.forAuthorityForTest(SERVER_A)
      for (const blocked of [stale, issuedAfterFailure]) {
        await expect(
          blocked.writeProvisionalUnacked(
            Q,
            { credentialId: 'blocked', mutualKey: 'blocked-key' },
            INSTANCE_A
          )
        ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)
      }

      // Revoke is a retirement capability, so it remains callable while the
      // normal mutation gate is closed. Only a successful durable retry opens
      // the next generation.
      await expect(root.revokeAuthority(SERVER_A)).resolves.toEqual([
        'existing',
      ])
      for (const blocked of [stale, issuedAfterFailure]) {
        await expect(
          blocked.writeProvisionalUnacked(
            Q,
            { credentialId: 'still-blocked', mutualKey: 'blocked-key' },
            INSTANCE_A
          )
        ).rejects.toBeInstanceOf(CredentialAuthorityRevokedError)
      }

      const freshAfterRetry = root.forAuthorityForTest(SERVER_A)
      await freshAfterRetry.writeProvisionalUnacked(
        P,
        { credentialId: 'fresh-after-retry', mutualKey: 'fresh-key' },
        INSTANCE_A
      )
      expect(await ids(freshAfterRetry)).toEqual(['fresh-after-retry'])
    }
  )

  it('migrates v1 once into local scope and maps its active id to the owning principal', async () => {
    backing[STORAGE_KEY] = {
      version: 1,
      credentials: [
        {
          credentialId: 'p',
          mutualKey: 'p-key',
          principalKey: principalKey(P),
          state: 'committed',
          createdAt: 1,
        },
        {
          credentialId: 'q',
          mutualKey: 'q-key',
          principalKey: principalKey(Q),
          state: 'committed',
          createdAt: 2,
        },
      ],
      activeCredentialId: 'q',
    }
    const setSpy = browser.storage.local.set as ReturnType<typeof vi.fn>
    setSpy.mockClear()
    const root = new CredentialStore()

    expect(await ids(root, P)).toEqual(['p'])
    expect(await ids(root, Q)).toEqual(['q'])
    expect(await ids(root.forAuthorityForTest(SERVER_A), P)).toEqual([])
    expect(setSpy).toHaveBeenCalledTimes(1)

    const stored = persisted()
    expect(stored.version).toBe(2)
    expect(stored.credentials).toHaveLength(2)
    expect(
      stored.credentials.every(
        (credential) =>
          credential.authorityKey ===
            backendAuthorityKey(LOCAL_BACKEND_AUTHORITY) &&
          credential.authenticatedInstanceId === null
      )
    ).toBe(true)
    expect(Object.values(stored.activeCredentialIds)).toEqual(['q'])

    // Reading the migrated record is idempotent; no second rewrite occurs.
    await root.recoverOrder(Q)
    expect(setSpy).toHaveBeenCalledTimes(1)
  })

  it('fills a migrated local null instance only from an authenticated commit', async () => {
    backing[STORAGE_KEY] = {
      version: 1,
      credentials: [
        {
          credentialId: 'legacy',
          mutualKey: 'legacy-key',
          principalKey: principalKey(P),
          state: 'committed',
          createdAt: 1,
        },
      ],
      activeCredentialId: 'legacy',
    }
    const local = new CredentialStore().forAuthorityForTest(
      LOCAL_BACKEND_AUTHORITY
    )

    await local.commitAndActivate('legacy', P, 'authenticated-local-instance')

    expect(persisted().credentials[0]?.authenticatedInstanceId).toBe(
      'authenticated-local-instance'
    )
    await expect(
      local.commitAndActivate('legacy', P, 'different-local-instance')
    ).rejects.toBeInstanceOf(CredentialInstanceMismatchError)
  })

  it('does not expose or overwrite an unknown future version', async () => {
    const future = {
      version: 99,
      credentials: [{ opaque: 'future-state' }],
      activeCredentialIds: { opaque: 'future-id' },
    }
    backing[STORAGE_KEY] = future
    const setSpy = browser.storage.local.set as ReturnType<typeof vi.fn>
    const removeSpy = browser.storage.local.remove as ReturnType<typeof vi.fn>
    setSpy.mockClear()
    removeSpy.mockClear()
    const root = new CredentialStore()

    expect(await root.recoverOrder(P)).toEqual([])
    expect(await root.hasCommittedCredential(P)).toBe(false)
    await expect(
      root.writeProvisionalUnacked(P, {
        credentialId: 'new-id',
        mutualKey: 'new-key',
      })
    ).rejects.toBeInstanceOf(UnsupportedCredentialStoreVersionError)
    await expect(root.revokeAuthority(SERVER_A)).rejects.toBeInstanceOf(
      UnsupportedCredentialStoreVersionError
    )
    expect(setSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(backing[STORAGE_KEY]).toBe(future)

    // A failed authority retirement intentionally leaves its in-realm gate
    // closed. Model the newer writer removing its opaque record, then retry so
    // this test does not leak that deliberate tombstone into later cases.
    delete backing[STORAGE_KEY]
    await expect(root.revokeAuthority(SERVER_A)).resolves.toEqual([])
  })

  it('drops malformed or colliding rows without discarding unrelated authorities', async () => {
    const root = new CredentialStore()
    const a = root.forAuthorityForTest(SERVER_A)
    const b = root.forAuthorityForTest(SERVER_B)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a', mutualKey: 'a-key' },
      INSTANCE_A
    )
    await b.writeProvisionalUnacked(
      P,
      { credentialId: 'b', mutualKey: 'b-key' },
      INSTANCE_B
    )

    const raw = backing[STORAGE_KEY] as {
      version: 2
      credentials: Array<Record<string, unknown>>
      activeCredentialIds: Record<string, string>
    }
    const aRow = raw.credentials.find(
      (credential) => credential.credentialId === 'a'
    )
    if (aRow === undefined) throw new Error('test setup missing A credential')
    raw.credentials.push({ malformed: true })
    raw.credentials.push({ ...aRow, authorityKey: '💥' })
    raw.credentials.push({ ...aRow, mutualKey: 'conflicting-key' })

    // Both ambiguous A rows fail closed; B remains independently recoverable.
    expect(await ids(a)).toEqual([])
    expect(await ids(b)).toEqual(['b'])
  })

  it('revokeAuthority clears all principals in only that authority', async () => {
    const root = new CredentialStore()
    const a = root.forAuthorityForTest(SERVER_A)
    const b = root.forAuthorityForTest(SERVER_B)
    await a.writeProvisionalUnacked(
      P,
      { credentialId: 'a-p', mutualKey: 'k' },
      INSTANCE_A
    )
    await a.writeProvisionalUnacked(
      Q,
      { credentialId: 'a-q', mutualKey: 'k' },
      INSTANCE_A
    )
    await b.writeProvisionalUnacked(
      P,
      { credentialId: 'b-p', mutualKey: 'k' },
      INSTANCE_B
    )
    await root.writeProvisionalUnacked(P, {
      credentialId: 'local-p',
      mutualKey: 'k',
    })

    const beforeDelete = vi.fn(async (_ids: readonly string[]) => {})
    expect((await root.revokeAuthority(SERVER_A, beforeDelete)).sort()).toEqual(
      ['a-p', 'a-q']
    )
    expect(beforeDelete).toHaveBeenCalledTimes(1)
    expect([...beforeDelete.mock.calls[0][0]].sort()).toEqual(['a-p', 'a-q'])
    expect(await ids(a, P)).toEqual([])
    expect(await ids(a, Q)).toEqual([])
    expect(await ids(b, P)).toEqual(['b-p'])
    expect(await ids(root, P)).toEqual(['local-p'])
  })

  it('logs nothing at any level (§11)', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    )
    const s = new CredentialStore()
    await s.writeProvisionalUnacked(P, { credentialId: 'c1', mutualKey: 'sec' })
    await s.markCommitUncertain('c1')
    await s.commitAndActivate('c1', P)
    await s.recoverOrder(P)
    await s.prunePrincipalExcept(P, 'c1')
    await s.ageOutUnacked(Date.now())
    await s.cleanupFirstPairOrphans(P, Date.now())
    await s.markCommitUncertain('unknown').catch(() => undefined) // error path too
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('lease-bound credential lifecycle facade', () => {
  it('routes every flow mutation through the supplied critical section', async () => {
    const failure = new Error('stale endpoint lease')
    const endpointStore = new EndpointConfigStore()
    await endpointStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'A',
          url: SERVER_A.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const endpointLifecycle = new EndpointCatalogService(endpointStore, {
      retire: async () => undefined,
    })
    const lease = await endpointLifecycle.issueBackendAttemptLease('server-a')
    const capability = endpointLifecycle.bindBackendAttemptLease(lease, () => {
      throw failure
    })
    const lifecycle = new CredentialStore().forAttempt(SERVER_A, capability)

    expect(resolveCredentialLifecycleStore(lifecycle)).toBe(lifecycle)
    await expect(
      lifecycle.writeProvisionalUnacked(
        P,
        { credentialId: 'c1', mutualKey: 'key' },
        INSTANCE_A
      )
    ).rejects.toBe(failure)
    await expect(lifecycle.markCommitUncertain('c1')).rejects.toBe(failure)
    await expect(lifecycle.commitAndActivate('c1', P, INSTANCE_A)).rejects.toBe(
      failure
    )
    await expect(lifecycle.finalizeAndPrune('c1', P, INSTANCE_A)).rejects.toBe(
      failure
    )
    await expect(lifecycle.prunePrincipalExcept(P, 'c1')).rejects.toBe(failure)
    expect(backing['motrix.mbp1.credentials']).toBeUndefined()
  })
})
