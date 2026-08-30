import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CredentialPrincipal,
  ExtensionIdentityAbsenceWitness,
  StoredCredential,
} from './credential-store'
import {
  CommittedExtensionCredentialError,
  Mbp1CredentialStore,
  PROVISIONAL_TTL_MS,
  principalKey,
  withLiveCommittedExtensionWitness,
  withLiveExtensionIdentityAbsenceWitness,
} from './credential-store'

/**
 * Counts durable writes without changing any of them: the mock delegates to the
 * real `write-file-atomic`, so every test in this file keeps writing real files
 * to a real temp dir. The count exists because §6.7 requires rotation's
 * commit-new and revoke-old to be ONE durable transaction, and a final-state
 * assertion cannot tell one write from two — a crash between two writes would
 * leave the predecessor deleted and the successor still provisional.
 */
const writeCount = { n: 0 }
vi.mock('write-file-atomic', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    default: (...args: unknown[]) => Promise<void>
  }
  return {
    default: (...args: unknown[]) => {
      writeCount.n += 1
      return actual.default(...args)
    },
  }
})

interface OnDiskDocument {
  version: number
  credentials: StoredCredential[]
  pendingPromote: string | null
}

const START = 1_700_000_000_000

const PRINCIPAL_A: CredentialPrincipal = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientInstallationId: 'install-a',
}

const PRINCIPAL_B: CredentialPrincipal = {
  browser: 'firefox',
  verifiedOrigin: 'moz-extension://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  clientInstallationId: 'install-b',
}

describe('Mbp1CredentialStore', () => {
  let tmpDir: string
  let filePath: string
  let now: number

  const clock = () => now

  const open = () => Mbp1CredentialStore.load(filePath, { now: clock })

  const readDoc = async (): Promise<OnDiskDocument> =>
    JSON.parse(await fs.readFile(filePath, 'utf-8'))

  const writeDoc = async (doc: OnDiskDocument): Promise<void> => {
    await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8')
  }

  const credential = (
    over: Partial<StoredCredential> & { credentialId: string }
  ): StoredCredential => ({
    mutualKeyB64: 'a'.repeat(43),
    principal: PRINCIPAL_A,
    predecessorId: null,
    state: 'committed',
    identity: 'official',
    createdAt: START,
    committedAt: START,
    ...over,
  })

  const mode = async (): Promise<number> => {
    const st = await fs.stat(filePath)
    return st.mode & 0o777
  }

  const loosen = async (): Promise<void> => {
    await fs.chmod(filePath, 0o644)
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mbp1-credentials-'))
    filePath = path.join(tmpDir, 'nested', 'mbp1-credentials.json')
    now = START
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('persists the provisional credential durably before offerProvisional resolves', async () => {
    const store = await open()

    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')

    // Read the FILE, not the instance: the provisional must already be durable
    // by the time the caller is free to send `credentialOffer` (§6.7 step 1).
    const doc = await readDoc()
    expect(doc.version).toBe(2)
    expect(doc.pendingPromote).toBeNull()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: offer.credentialId,
      mutualKeyB64: offer.mutualKeyB64,
      state: 'provisional',
      identity: 'official',
      predecessorId: null,
      createdAt: START,
      committedAt: null,
    })
    expect(doc.credentials[0]?.principal).toEqual(PRINCIPAL_A)
    expect(offer.mutualKeyB64).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('re-offers the identical credential for the same principal and committed predecessor', async () => {
    const store = await open()

    const first = await store.offerProvisional(PRINCIPAL_A, 'official')
    const second = await store.offerProvisional(PRINCIPAL_A, 'official')

    // Idempotent single slot (§6.7): never a freshly minted replacement, so a
    // client that stored the earlier offer and one that did not converge.
    expect(second.credentialId).toBe(first.credentialId)
    expect(second.mutualKeyB64).toBe(first.mutualKeyB64)

    const doc = await readDoc()
    expect(
      doc.credentials.filter((c) => c.state === 'provisional')
    ).toHaveLength(1)
  })

  it('commits a provisional credential durably on the credentialAck path', async () => {
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')

    now = START + 1_000
    await store.commitFromPair(offer.credentialId)

    const doc = await readDoc()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: offer.credentialId,
      state: 'committed',
      committedAt: START + 1_000,
    })

    const reloaded = await open()
    expect(reloaded.committedFor(PRINCIPAL_A)?.credentialId).toBe(
      offer.credentialId
    )
    expect(reloaded.listCommitted()).toHaveLength(1)
  })

  it('promotes the successor and revokes the predecessor in one document write', async () => {
    const store = await open()
    const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(c1.credentialId)

    const p2 = await store.offerProvisional(PRINCIPAL_A, 'official')
    now = START + 5_000
    writeCount.n = 0
    await store.promoteOnReconnect(p2.credentialId)

    // The name of this test is the assertion: ONE durable write. Final state
    // alone cannot distinguish one transaction from two, and two would leave a
    // crash window where the predecessor is gone and the successor is still
    // provisional — neither credential valid, which §6.7 forbids.
    expect(writeCount.n).toBe(1)

    // One read after the fact: the rotation left neither both credentials nor
    // neither of them — exactly the successor (§6.7 rotation CAS).
    const doc = await readDoc()
    expect(doc.pendingPromote).toBeNull()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: p2.credentialId,
      state: 'committed',
      committedAt: START + 5_000,
    })
    expect(store.findForAuth(c1.credentialId)).toBeNull()
  })

  it('lets only one of two concurrent rotations from the same credential commit', async () => {
    const store = await open()
    const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(c1.credentialId)

    // Two concurrent rotations started from C1 share the single provisional
    // slot, so they cannot produce two successors in the first place.
    //
    // Not CAS coverage: the loser is rejected by that shared slot, not by the
    // predecessor comparison. See the stale-predecessor test for the CAS.
    const [a, b] = await Promise.all([
      store.offerProvisional(PRINCIPAL_A, 'official'),
      store.offerProvisional(PRINCIPAL_A, 'official'),
    ])
    expect(b.credentialId).toBe(a.credentialId)
    expect(b.mutualKeyB64).toBe(a.mutualKeyB64)

    const settled = await Promise.allSettled([
      store.promoteOnReconnect(a.credentialId),
      store.promoteOnReconnect(b.credentialId),
    ])
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1)

    const doc = await readDoc()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: a.credentialId,
      state: 'committed',
    })
  })

  it('commits only one successor when two share the same predecessor', async () => {
    // Two live successors of C1 are unreachable through this store's own writes
    // (the single slot forbids them), so the file is written by hand.
    //
    // This does NOT pin the CAS, despite reaching a state that looks like it
    // should. `enqueue` serializes the two promotions, and the first
    // `applyPromote` deletes every credential of the principal — including the
    // rival provisional — so the loser fails the `no live provisional` check
    // and never reaches the CAS comparison. Verified by mutation: deleting the
    // CAS leaves this test green. The assertion on the loser's reason below is
    // what keeps that honest; the CAS is pinned by the stale-predecessor test
    // that follows, which keeps a live provisional and gives it a predecessor
    // that is no longer committed.
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeDoc({
      version: 1,
      credentials: [
        credential({ credentialId: 'c1' }),
        credential({
          credentialId: 'p2',
          predecessorId: 'c1',
          state: 'provisional',
          committedAt: null,
        }),
        credential({
          credentialId: 'p2-prime',
          predecessorId: 'c1',
          state: 'provisional',
          committedAt: null,
        }),
      ],
      pendingPromote: null,
    })
    const store = await open()

    const settled = await Promise.allSettled([
      store.promoteOnReconnect('p2'),
      store.promoteOnReconnect('p2-prime'),
    ])
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    // The mechanism, not just the count: the rival was deleted, so the loser
    // stops at the live-provisional gate. If this ever reads `stale rotation`
    // instead, the serialization or deletion behaviour changed and this test is
    // measuring something else.
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      'no live provisional'
    )

    const doc = await readDoc()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: 'p2',
      state: 'committed',
    })
  })

  it('rejects a promote whose recorded predecessor is no longer the committed credential', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeDoc({
      version: 1,
      credentials: [
        credential({ credentialId: 'c1' }),
        credential({
          credentialId: 'p-stale',
          predecessorId: 'c0',
          state: 'provisional',
          committedAt: null,
        }),
      ],
      pendingPromote: null,
    })
    const store = await open()

    await expect(store.promoteOnReconnect('p-stale')).rejects.toThrow(
      /stale rotation/
    )
    // A credential that cannot be promoted must not authenticate either: the
    // §6.7 ordering means its reconnect would fail after the accept was owed.
    expect(store.findForAuth('p-stale')).toBeNull()
    expect(store.committedFor(PRINCIPAL_A)?.credentialId).toBe('c1')
  })

  it('replays a pending promote on load before returning', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeDoc({
      version: 1,
      credentials: [
        credential({ credentialId: 'c1' }),
        credential({
          credentialId: 'p2',
          predecessorId: 'c1',
          state: 'provisional',
          createdAt: START,
          committedAt: null,
        }),
      ],
      pendingPromote: 'p2',
    })

    now = START + 1_000
    const store = await open()

    // Converged before load() resolved — /v1 never admits auth against a
    // half-applied rotation (§6.7).
    expect(store.listCommitted().map((c) => c.credentialId)).toEqual(['p2'])
    expect(store.committedFor(PRINCIPAL_A)?.credentialId).toBe('p2')
    expect(store.findForAuth('c1')).toBeNull()

    const doc = await readDoc()
    expect(doc.pendingPromote).toBeNull()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: 'p2',
      state: 'committed',
      committedAt: START + 1_000,
    })
  })

  it('sweeps expired provisionals and leaves committed credentials alone', async () => {
    const store = await open()
    const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(c1.credentialId)
    const p2 = await store.offerProvisional(PRINCIPAL_A, 'official')

    now = START + PROVISIONAL_TTL_MS + 60_000
    expect(store.findForAuth(p2.credentialId)).toBeNull()

    await store.sweepExpiredProvisionals()

    const doc = await readDoc()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]).toMatchObject({
      credentialId: c1.credentialId,
      state: 'committed',
    })
    expect(store.findForAuth(c1.credentialId)?.credentialId).toBe(
      c1.credentialId
    )
  })

  it('keeps a rotation of one principal away from another principal', async () => {
    const store = await open()
    const a1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(a1.credentialId)
    const b1 = await store.offerProvisional(
      PRINCIPAL_B,
      'attested-non-official'
    )
    await store.commitFromPair(b1.credentialId)

    const a2 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.promoteOnReconnect(a2.credentialId)

    expect(store.committedFor(PRINCIPAL_A)?.credentialId).toBe(a2.credentialId)
    expect(store.committedFor(PRINCIPAL_B)?.credentialId).toBe(b1.credentialId)
    expect(store.committedFor(PRINCIPAL_B)?.identity).toBe(
      'attested-non-official'
    )

    const doc = await readDoc()
    expect(doc.credentials.map((c) => c.credentialId).sort()).toEqual(
      [a2.credentialId, b1.credentialId].sort()
    )
  })

  it.runIf(process.platform !== 'win32')(
    'writes owner-only (0600) on every mutation',
    async () => {
      const store = await open()

      const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
      expect(await mode()).toBe(0o600)

      await loosen()
      await store.commitFromPair(c1.credentialId)
      expect(await mode()).toBe(0o600)

      const p2 = await store.offerProvisional(PRINCIPAL_A, 'official')
      await loosen()
      await store.promoteOnReconnect(p2.credentialId)
      expect(await mode()).toBe(0o600)

      await store.offerProvisional(PRINCIPAL_B, 'unverified')
      await loosen()
      now = START + PROVISIONAL_TTL_MS + 1
      await store.sweepExpiredProvisionals()
      expect(await mode()).toBe(0o600)

      await loosen()
      await store.revoke(p2.credentialId)
      expect(await mode()).toBe(0o600)

      // Journal replay on load is a write too, and it must not loosen the file.
      await writeDoc({
        version: 1,
        credentials: [
          credential({ credentialId: 'c1' }),
          credential({
            credentialId: 'p2',
            predecessorId: 'c1',
            state: 'provisional',
            committedAt: null,
          }),
        ],
        pendingPromote: 'p2',
      })
      await loosen()
      await open()
      expect(await mode()).toBe(0o600)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'leaves memory and disk on the previous state when a write fails',
    async () => {
      // `persist` is durable-first, in-memory-second, and this pins that the
      // order is the one that holds. It matters because there used to be a
      // fallible step *after* the atomic rename: `writeDocument` chmodded the
      // renamed target, so a chmod rejection made `persist` throw with the new
      // document already on disk and `this.credentials` still on the old one.
      // A later unrelated mutation would then write that stale array back and
      // resurrect a revoked credential. The chmod is gone — `write-file-atomic`
      // sets the mode on the temp file before renaming — so every remaining
      // failure lands before anything is durable.
      const store = await open()
      const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
      await store.commitFromPair(c1.credentialId)
      const before = await readDoc()

      // Deny writes to the containing directory so the temp file cannot be
      // created. The failure therefore happens before the rename.
      const dir = path.dirname(filePath)
      await fs.chmod(dir, 0o500)
      try {
        await expect(store.revoke(c1.credentialId)).rejects.toThrow()
      } finally {
        await fs.chmod(dir, 0o700)
      }

      // Disk still holds the pre-mutation document...
      expect(await readDoc()).toEqual(before)
      // ...and memory agrees with it, rather than claiming the revoke landed.
      expect(store.findForAuth(c1.credentialId)).not.toBeNull()
      expect(store.committedFor(PRINCIPAL_A)).not.toBeNull()
    }
  )

  it('revokes a credential durably', async () => {
    const store = await open()
    const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(c1.credentialId)

    await store.revoke(c1.credentialId)

    expect(store.findForAuth(c1.credentialId)).toBeNull()
    expect(store.committedFor(PRINCIPAL_A)).toBeNull()
    expect((await readDoc()).credentials).toEqual([])
  })

  it('revokes the pending successor of a revoked credential', async () => {
    const store = await open()
    const c1 = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(c1.credentialId)
    const p2 = await store.offerProvisional(PRINCIPAL_A, 'official')
    const b1 = await store.offerProvisional(PRINCIPAL_B, 'official')

    await store.revoke(c1.credentialId)

    expect(store.findForAuth(p2.credentialId)).toBeNull()
    const doc = await readDoc()
    expect(doc.credentials.map((c) => c.credentialId)).toEqual([
      b1.credentialId,
    ])
  })

  it('revokes every committed and provisional credential for an extension identity in one durable write', async () => {
    const store = await open()
    const firstInstall = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(firstInstall.credentialId)
    const successor = await store.offerProvisional(PRINCIPAL_A, 'official')
    const secondInstall = await store.offerProvisional(
      { ...PRINCIPAL_A, clientInstallationId: 'install-a2' },
      'official'
    )
    await store.commitFromPair(secondInstall.credentialId)
    const unrelated = await store.offerProvisional(PRINCIPAL_B, 'unverified')

    const writesBeforeRevoke = writeCount.n
    await expect(
      store.revokeExtensionIdentity(
        'chromium',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).resolves.toBe(3)

    expect(writeCount.n - writesBeforeRevoke).toBe(1)
    expect(store.findForAuth(firstInstall.credentialId)).toBeNull()
    expect(store.findForAuth(successor.credentialId)).toBeNull()
    expect(store.findForAuth(secondInstall.credentialId)).toBeNull()
    expect(store.findForAuth(unrelated.credentialId)).not.toBeNull()
    expect((await readDoc()).credentials.map((c) => c.credentialId)).toEqual([
      unrelated.credentialId,
    ])
  })

  it('does not revoke a credential for a different browser or Origin host', async () => {
    const store = await open()
    const credential = await store.offerProvisional(PRINCIPAL_A, 'official')

    await expect(
      store.revokeExtensionIdentity(
        'firefox',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).resolves.toBe(0)
    await expect(
      store.revokeExtensionIdentity(
        'chromium',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      )
    ).resolves.toBe(0)

    expect(store.findForAuth(credential.credentialId)).not.toBeNull()
  })

  it('authenticates a provisional credential and rejects an unknown one', async () => {
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')

    const found = store.findForAuth(offer.credentialId)
    expect(found?.state).toBe('provisional')
    expect(found?.mutualKeyB64).toBe(offer.mutualKeyB64)
    expect(store.findForAuth('nope')).toBeNull()
  })

  it('mints a fresh slot once the previous provisional expired', async () => {
    const store = await open()
    const first = await store.offerProvisional(PRINCIPAL_A, 'official')

    now = START + PROVISIONAL_TTL_MS + 1
    const second = await store.offerProvisional(PRINCIPAL_A, 'official')

    expect(second.credentialId).not.toBe(first.credentialId)
    const doc = await readDoc()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]?.credentialId).toBe(second.credentialId)
  })

  it('issues nominal witnesses only for durably committed exact credentials', async () => {
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')
    await expect(
      store.issueCommittedExtensionWitness(offer.credentialId)
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)

    now = START + 100
    await store.commitFromPair(offer.credentialId)
    const witness = await store.issueCommittedExtensionWitness(
      offer.credentialId
    )
    expect(witness).toMatchObject({
      identity: {
        kind: 'extension',
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      identityTrust: 'official',
      committedAt: START + 100,
    })
    expect(Object.isFrozen(witness)).toBe(true)
    expect(Object.isFrozen(witness.identity)).toBe(true)
    await expect(
      withLiveCommittedExtensionWitness(witness, async () => 'live')
    ).resolves.toBe('live')
    await expect(
      withLiveCommittedExtensionWitness({ ...witness }, async () => 'forged')
    ).rejects.toThrow(CommittedExtensionCredentialError.InvalidWitness)

    await store.revoke(offer.credentialId)
    await expect(
      withLiveCommittedExtensionWitness(witness, async () => 'replayed')
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)
  })

  it('keeps one authorization epoch across installations and rotation but invalidates the rotated witness', async () => {
    const store = await open()
    const first = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(first.credentialId)
    const firstWitness = await store.issueCommittedExtensionWitness(
      first.credentialId
    )

    const secondInstallPrincipal = {
      ...PRINCIPAL_A,
      clientInstallationId: 'install-a-2',
    }
    const secondInstall = await store.offerProvisional(
      secondInstallPrincipal,
      'unverified'
    )
    await store.commitFromPair(secondInstall.credentialId)
    const secondWitness = await store.issueCommittedExtensionWitness(
      secondInstall.credentialId
    )

    const rotated = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(rotated.credentialId)
    const rotatedWitness = await store.issueCommittedExtensionWitness(
      rotated.credentialId
    )

    expect(secondWitness.authorizationEpoch).toBe(
      firstWitness.authorizationEpoch
    )
    expect(rotatedWitness.authorizationEpoch).toBe(
      firstWitness.authorizationEpoch
    )
    expect(secondWitness.identityTrust).toBe('unverified')
    await expect(
      withLiveCommittedExtensionWitness(firstWitness, async () => undefined)
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)
    await expect(
      withLiveCommittedExtensionWitness(rotatedWitness, async () => undefined)
    ).resolves.toBeUndefined()
  })

  it('issues only nominal, live absence witnesses after every identity credential is gone', async () => {
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')
    const identity = {
      browser: 'chromium' as const,
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }

    await expect(
      store.issueExtensionIdentityAbsenceWitness(
        identity.browser,
        identity.extensionId
      )
    ).rejects.toThrow(CommittedExtensionCredentialError.NotAbsent)

    await store.revokeExtensionIdentity(identity.browser, identity.extensionId)
    expect(store.findForAuth(offer.credentialId)).toBeNull()
    const witness = await store.issueExtensionIdentityAbsenceWitness(
      identity.browser,
      identity.extensionId
    )
    await expect(
      withLiveExtensionIdentityAbsenceWitness(witness, identity, async () =>
        Promise.resolve('absent')
      )
    ).resolves.toBe('absent')
    await expect(
      withLiveExtensionIdentityAbsenceWitness(
        { ...witness } as ExtensionIdentityAbsenceWitness,
        identity,
        async () => Promise.resolve('forged')
      )
    ).rejects.toThrow(CommittedExtensionCredentialError.InvalidWitness)

    await store.offerProvisional(PRINCIPAL_A, 'official')
    await expect(
      withLiveExtensionIdentityAbsenceWitness(witness, identity, async () =>
        Promise.resolve('stale')
      )
    ).rejects.toThrow(CommittedExtensionCredentialError.NotAbsent)
  })

  it('holds the credential queue while an absence-guarded cleanup runs', async () => {
    const store = await open()
    const identity = {
      browser: 'chromium' as const,
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }
    const witness = await store.issueExtensionIdentityAbsenceWitness(
      identity.browser,
      identity.extensionId
    )
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const cleanup = withLiveExtensionIdentityAbsenceWitness(
      witness,
      identity,
      async () => {
        entered()
        await blocked
      }
    )
    await started

    let offerSettled = false
    const offer = store.offerProvisional(PRINCIPAL_A, 'official').then(() => {
      offerSettled = true
    })
    await Promise.resolve()
    expect(offerSettled).toBe(false)

    release()
    await cleanup
    await offer
    expect(offerSettled).toBe(true)
  })

  it('assigns a new authorization epoch after full identity revoke and re-pair', async () => {
    const store = await open()
    const first = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(first.credentialId)
    const firstWitness = await store.issueCommittedExtensionWitness(
      first.credentialId
    )

    await store.revokeExtensionIdentity(
      firstWitness.identity.browser,
      firstWitness.identity.extensionId
    )
    now = START + 1_000
    const repaired = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(repaired.credentialId)
    const repairedWitness = await store.issueCommittedExtensionWitness(
      repaired.credentialId
    )

    expect(repairedWitness.authorizationEpoch).not.toBe(
      firstWitness.authorizationEpoch
    )
  })

  it('migrates v1 credentials for one verified identity to one durable epoch', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeDoc({
      version: 1,
      credentials: [
        credential({ credentialId: 'legacy-a' }),
        credential({
          credentialId: 'legacy-a-2',
          principal: {
            ...PRINCIPAL_A,
            clientInstallationId: 'install-a-2',
          },
          identity: 'unverified',
        }),
      ],
      pendingPromote: null,
    })

    const store = await open()
    const migrated = await readDoc()
    expect(migrated.version).toBe(2)
    const epochs = migrated.credentials.map((entry) => entry.authorizationEpoch)
    expect(new Set(epochs).size).toBe(1)
    expect(epochs[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(
      (await store.issueCommittedExtensionSnapshot()).witnesses
    ).toHaveLength(2)

    const durableMigration = await fs.readFile(filePath, 'utf-8')
    await open()
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(durableMigration)
  })

  it('safely migrates early v1 absence of predecessor and pending journal fields', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const earlyCredential = credential({ credentialId: 'early-beta' })
    Reflect.deleteProperty(earlyCredential, 'predecessorId')
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, credentials: [earlyCredential] }),
      'utf-8'
    )

    const store = await open()
    expect(store.findForAuth('early-beta')).toMatchObject({
      predecessorId: null,
      state: 'committed',
    })
    expect(await readDoc()).toMatchObject({
      version: 2,
      pendingPromote: null,
    })
  })

  it('preserves and rejects a v2 document with conflicting epochs for one identity', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeDoc({
      version: 2,
      credentials: [
        credential({
          credentialId: 'conflict-a',
          authorizationEpoch: '11111111-1111-4111-8111-111111111111',
        }),
        credential({
          credentialId: 'conflict-a-2',
          principal: {
            ...PRINCIPAL_A,
            clientInstallationId: 'install-a-2',
          },
          authorizationEpoch: '22222222-2222-4222-8222-222222222222',
        }),
      ],
      pendingPromote: null,
    })
    const before = await fs.readFile(filePath, 'utf-8')

    await expect(open()).rejects.toThrow(
      CommittedExtensionCredentialError.EpochConflict
    )
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(before)
  })

  it('returns frozen credential copies that cannot mutate store liveness', async () => {
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')
    await store.commitFromPair(offer.credentialId)
    const listed = store.listCommitted()

    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.principal)).toBe(true)
    expect(() => {
      ;(listed[0] as StoredCredential).state = 'provisional'
    }).toThrow()
    expect(store.findForAuth(offer.credentialId)?.state).toBe('committed')
  })

  it('bounds credential counts and rejects non-canonical revoke identities', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: Array.from({ length: 16_385 }, () => null),
        pendingPromote: null,
      }),
      'utf-8'
    )
    await expect(open()).rejects.toThrow('mbp1 credential storage rejected')

    await fs.unlink(filePath)
    const store = await open()
    const offer = await store.offerProvisional(PRINCIPAL_A, 'official')
    await expect(
      store.revokeExtensionIdentity('chromium', 'A'.repeat(32))
    ).rejects.toThrow(CommittedExtensionCredentialError.InvalidInput)
    await expect(
      store.offerProvisional(
        {
          ...PRINCIPAL_A,
          verifiedOrigin: `chrome-extension://${'A'.repeat(32)}`,
        },
        'official'
      )
    ).rejects.toThrow(CommittedExtensionCredentialError.InvalidInput)
    expect(store.findForAuth(offer.credentialId)).not.toBeNull()
  })

  it('preserves and rejects a document containing any malformed record', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: [
          { credentialId: 'broken' },
          null,
          credential({ credentialId: 'c1' }),
        ],
        pendingPromote: null,
      }),
      'utf-8'
    )

    const before = await fs.readFile(filePath, 'utf-8')
    await expect(open()).rejects.toThrow('mbp1 credential storage rejected')
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(before)
  })

  it('starts empty only when missing and preserves unparsable state', async () => {
    const missing = await open()
    expect(missing.listCommitted()).toEqual([])

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'not json', 'utf-8')
    await expect(open()).rejects.toThrow('mbp1 credential storage rejected')
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('not json')
  })
})

describe('principalKey', () => {
  it('separates principals whose concatenated fields would collide', () => {
    const left = principalKey({
      browser: 'chromium',
      verifiedOrigin: 'a',
      clientInstallationId: 'bc',
    })
    const right = principalKey({
      browser: 'chromium',
      verifiedOrigin: 'ab',
      clientInstallationId: 'c',
    })

    expect(left).not.toBe(right)
  })

  it('treats a second browser profile as a different principal', () => {
    expect(principalKey(PRINCIPAL_A)).not.toBe(
      principalKey({ ...PRINCIPAL_A, clientInstallationId: 'install-a2' })
    )
  })
})
