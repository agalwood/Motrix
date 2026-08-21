import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialPrincipal, StoredCredential } from './credential-store'
import {
  Mbp1CredentialStore,
  PROVISIONAL_TTL_MS,
  principalKey,
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
    expect(doc.version).toBe(1)
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
    // That shared slot, plus the live-provisional state check, is what makes
    // the loser reject here — NOT the predecessor CAS. Verified by mutation:
    // deleting the CAS leaves this test green. The CAS is pinned by
    // `rejects a promote whose recorded predecessor is no longer the committed
    // credential`, which is the only test that fails without it. Do not read
    // this one as CAS coverage.
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
    // Two live successors of C1 are unreachable through this store's own
    // writes (the single slot forbids them), so the file is written by hand to
    // pin the CAS itself: whichever rotation lands second must observe the
    // changed current id rather than commit a second successor.
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
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1)

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

  it('ignores malformed on-disk records', async () => {
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

    const store = await open()

    expect(store.listCommitted().map((c) => c.credentialId)).toEqual(['c1'])
  })

  it('starts empty when the file is missing or unparsable', async () => {
    const missing = await open()
    expect(missing.listCommitted()).toEqual([])

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'not json', 'utf-8')
    const corrupt = await open()
    expect(corrupt.listCommitted()).toEqual([])
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
