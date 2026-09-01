import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommittedExtensionCredentialError,
  type CommittedExtensionCredentialSnapshot,
  type CommittedExtensionCredentialWitness,
  type CredentialPrincipal,
  type ExtensionIdentityAbsenceWitness,
  type IdentityTriState,
  Mbp1CredentialStore,
} from './credential-store'
import {
  type ExtensionPairingCleanupLease,
  type ExtensionPairingProjection,
  ExtensionPairingProjectionError,
  ExtensionPairingProjectionService,
  type ExtensionPairingProjectionStore,
  type ExtensionPairingProjectionStoreSnapshot,
} from './extension-pairing-projection'

const START = 1_700_000_000_000

const PRINCIPAL_A: CredentialPrincipal = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientInstallationId: 'install-a',
}

const PRINCIPAL_A_SECOND_INSTALL: CredentialPrincipal = {
  ...PRINCIPAL_A,
  clientInstallationId: 'install-a-2',
}

const PRINCIPAL_B: CredentialPrincipal = {
  browser: 'firefox',
  verifiedOrigin: 'moz-extension://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  clientInstallationId: 'install-b',
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

class MemoryProjectionStore implements ExtensionPairingProjectionStore {
  revision = 0
  records: unknown = []
  saveCalls = 0
  failNextSave = false
  failLoad = false
  lastSaveWasDeepFrozen = false
  private blockedSave:
    | {
        readonly entered: () => void
        readonly wait: Promise<void>
      }
    | undefined

  async load(): Promise<ExtensionPairingProjectionStoreSnapshot> {
    if (this.failLoad) throw new Error('untrusted load detail')
    return { revision: this.revision, records: clone(this.records) }
  }

  async save(
    next: readonly ExtensionPairingProjection[],
    expectedRevision: number
  ): Promise<number> {
    this.saveCalls += 1
    this.lastSaveWasDeepFrozen =
      Object.isFrozen(next) &&
      next.every(
        (record) => Object.isFrozen(record) && Object.isFrozen(record.identity)
      )
    const blocked = this.blockedSave
    this.blockedSave = undefined
    if (blocked) {
      blocked.entered()
      await blocked.wait
    }
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('untrusted persistence detail')
    }
    if (expectedRevision !== this.revision) throw new Error('stale revision')
    this.records = clone(next)
    this.revision += 1
    return this.revision
  }

  blockNextSave(): { entered: Promise<void>; release: () => void } {
    let announce!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      announce = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.blockedSave = { entered: announce, wait }
    return { entered, release }
  }
}

interface PairResult {
  readonly credentialId: string
  readonly witness: CommittedExtensionCredentialWitness
}

describe('ExtensionPairingProjectionService', () => {
  let directory: string
  let credentialPath: string
  let credentialStore: Mbp1CredentialStore
  let projectionStore: MemoryProjectionStore
  let service: ExtensionPairingProjectionService
  let now: number

  const pair = async (
    principal: CredentialPrincipal,
    identityTrust: IdentityTriState,
    committedAt: number
  ): Promise<PairResult> => {
    now = committedAt - 1
    const offer = await credentialStore.offerProvisional(
      principal,
      identityTrust
    )
    now = committedAt
    await credentialStore.commitFromPair(offer.credentialId)
    return {
      credentialId: offer.credentialId,
      witness: await credentialStore.issueCommittedExtensionWitness(
        offer.credentialId
      ),
    }
  }

  const absenceFor = (
    identity: CommittedExtensionCredentialWitness['identity']
  ): Promise<ExtensionIdentityAbsenceWitness> =>
    credentialStore.issueExtensionIdentityAbsenceWitness(
      identity.browser,
      identity.extensionId
    )

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-pairing-projection-service-')
    )
    credentialPath = path.join(directory, 'mbp1-credentials.json')
    now = START
    credentialStore = await Mbp1CredentialStore.load(credentialPath, {
      now: () => now,
    })
    projectionStore = new MemoryProjectionStore()
    service = new ExtensionPairingProjectionService(projectionStore, {
      now: () => now,
    })
    await service.load()
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('rejects copied, forged, and self-reported witnesses without writing', async () => {
    const { witness } = await pair(PRINCIPAL_A, 'official', START + 100)
    const copies = [
      { ...witness },
      {
        ...witness,
        state: 'committed',
        credentialId: 'self-reported',
      },
      {
        identity: witness.identity,
        identityTrust: 'official',
        authorizationEpoch: witness.authorizationEpoch,
        createdAt: witness.createdAt,
        committedAt: witness.committedAt,
        verifiedOrigin: witness.verifiedOrigin,
      },
    ]

    for (const copy of copies) {
      await expect(
        service.recordCommitted(
          copy as unknown as CommittedExtensionCredentialWitness
        )
      ).rejects.toThrow(CommittedExtensionCredentialError.InvalidWitness)
    }
    expect(projectionStore.saveCalls).toBe(0)
    expect(service.list()).toEqual([])
  })

  it('creates a tokenless record only after durable credential commit', async () => {
    now = START + 50
    const provisional = await credentialStore.offerProvisional(
      PRINCIPAL_A,
      'official'
    )
    await expect(
      credentialStore.issueCommittedExtensionWitness(provisional.credentialId)
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)

    now = START + 100
    await credentialStore.commitFromPair(provisional.credentialId)
    const witness = await credentialStore.issueCommittedExtensionWitness(
      provisional.credentialId
    )
    const record = await service.recordCommitted(witness)

    expect(record).toEqual({
      identity: witness.identity,
      identityTrust: 'official',
      authorizationEpoch: witness.authorizationEpoch,
      status: 'ready',
      pairedAt: START + 100,
      lastActiveAt: null,
    })
    const serialized = JSON.stringify(service.list())
    expect(serialized).not.toMatch(/token|bearer|credentialId|mutualKey/iu)
    expect(Object.keys(record).sort()).toEqual([
      'authorizationEpoch',
      'identity',
      'identityTrust',
      'lastActiveAt',
      'pairedAt',
      'status',
    ])
  })

  it('preserves pairedAt across reconnects and avoids redundant writes', async () => {
    const { witness } = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(witness)
    await service.recordCommitted(witness)
    expect(projectionStore.saveCalls).toBe(1)

    await service.recordAuthenticated(witness, START + 300)
    await service.recordAuthenticated(witness, START + 200)

    expect(service.list()[0]).toMatchObject({
      pairedAt: START + 100,
      lastActiveAt: START + 300,
    })
    expect(projectionStore.saveCalls).toBe(2)
  })

  it('requires authenticatedAt to be at or after committedAt', async () => {
    const { witness } = await pair(PRINCIPAL_A, 'official', START + 100)

    await expect(
      service.recordAuthenticated(witness, START + 99)
    ).rejects.toThrow(ExtensionPairingProjectionError.InvalidTime)
    expect(projectionStore.saveCalls).toBe(0)
  })

  it('invalidates an old witness after revoke', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(paired.witness)
    await credentialStore.revoke(paired.credentialId)

    await expect(
      service.recordAuthenticated(paired.witness, START + 200)
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)
    expect(service.list()[0]?.lastActiveAt).toBeNull()
  })

  it('holds credential liveness until the projection mutation is durable', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    const gate = projectionStore.blockNextSave()
    const recording = service.recordCommitted(paired.witness)
    await gate.entered

    let revokeFinished = false
    const revoking = credentialStore.revoke(paired.credentialId).then(() => {
      revokeFinished = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(revokeFinished).toBe(false)

    gate.release()
    await recording
    await revoking
    await expect(
      service.recordAuthenticated(paired.witness, START + 200)
    ).rejects.toThrow(CommittedExtensionCredentialError.NotCommitted)
  })

  it('keeps the authorization epoch and pairedAt through credential rotation', async () => {
    const first = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(first.witness)
    const rotated = await pair(PRINCIPAL_A, 'official', START + 500)

    expect(rotated.witness.authorizationEpoch).toBe(
      first.witness.authorizationEpoch
    )
    await expect(service.recordCommitted(first.witness)).rejects.toThrow(
      CommittedExtensionCredentialError.NotCommitted
    )
    await service.recordCommitted(rotated.witness)
    expect(service.list()[0]?.pairedAt).toBe(START + 100)
  })

  it('folds multiple installations by verified transport identity and keeps the most conservative trust', async () => {
    const first = await pair(PRINCIPAL_A, 'official', START + 100)
    const second = await pair(
      PRINCIPAL_A_SECOND_INSTALL,
      'unverified',
      START + 200
    )
    expect(second.witness.authorizationEpoch).toBe(
      first.witness.authorizationEpoch
    )

    await service.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )

    expect(service.list()).toEqual([
      {
        identity: first.witness.identity,
        identityTrust: 'unverified',
        authorizationEpoch: first.witness.authorizationEpoch,
        status: 'ready',
        pairedAt: START + 100,
        lastActiveAt: null,
      },
    ])
  })

  it('derives the Firefox management key only from verified Origin', async () => {
    const { witness } = await pair(PRINCIPAL_B, 'official', START + 100)

    expect(witness.identity).toEqual({
      kind: 'extension',
      browser: 'firefox',
      extensionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    expect(witness).not.toHaveProperty('claimedExtensionId')
  })

  it('reconciles additions and stale deletions while isolating identities', async () => {
    const a = await pair(PRINCIPAL_A, 'official', START + 100)
    const b = await pair(PRINCIPAL_B, 'unverified', START + 200)
    const oldSnapshot = await credentialStore.issueCommittedExtensionSnapshot()
    await service.reconcileCommitted(oldSnapshot)
    expect(service.list()).toHaveLength(2)

    await credentialStore.revokeExtensionIdentity(
      'chromium',
      a.witness.identity.extensionId
    )
    await expect(service.reconcileCommitted(oldSnapshot)).rejects.toThrow(
      CommittedExtensionCredentialError.NotCommitted
    )
    await service.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )

    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]?.identity).toEqual(b.witness.identity)
  })

  it('persists cleanup-pending before revoke and gives a full re-pair a new epoch and pairedAt', async () => {
    const first = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(first.witness)

    const lease = await service.prepareCleanup(first.witness)
    expect(service.list()[0]?.status).toBe('cleanup-pending')
    expect(service.listReady()).toEqual([])
    expect(service.canAdmitIdentity(first.witness.identity)).toBe(false)

    await credentialStore.revokeExtensionIdentity(
      first.witness.identity.browser,
      first.witness.identity.extensionId
    )
    await service.completeCleanup(
      lease,
      await absenceFor(first.witness.identity)
    )
    expect(service.list()).toEqual([])

    const repaired = await pair(PRINCIPAL_A, 'official', START + 900)
    expect(repaired.witness.authorizationEpoch).not.toBe(
      first.witness.authorizationEpoch
    )
    await service.recordCommitted(repaired.witness)
    expect(service.list()[0]?.pairedAt).toBe(START + 900)
  })

  it('keeps a durable pending revoke closed across restart until an explicit retry completes', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(paired.witness)
    await service.prepareCleanup(paired.witness)

    const restarted = new ExtensionPairingProjectionService(projectionStore)
    await restarted.load()
    expect(restarted.canAdmitIdentity(paired.witness.identity)).toBe(false)
    await restarted.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )

    expect(restarted.list()[0]).toMatchObject({
      status: 'cleanup-pending',
      pairedAt: START + 100,
    })
    expect(restarted.canAdmitIdentity(paired.witness.identity)).toBe(false)

    const recoveredLease = await restarted.prepareIdentityCleanup(
      paired.witness.identity
    )
    await credentialStore.revokeExtensionIdentity(
      paired.witness.identity.browser,
      paired.witness.identity.extensionId
    )
    await restarted.completeCleanup(
      recoveredLease,
      await absenceFor(paired.witness.identity)
    )
    expect(restarted.list()).toEqual([])
  })

  it('does not let generic reconcile override pending cleanup and requires nominal explicit cancellation', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(paired.witness)
    const lease = await service.prepareCleanup(paired.witness)

    await service.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )
    expect(service.list()[0]?.status).toBe('cleanup-pending')
    expect(service.canAdmitIdentity(paired.witness.identity)).toBe(false)

    await service.cancelCleanup(lease, paired.witness)
    expect(service.list()[0]).toMatchObject({
      status: 'ready',
      pairedAt: START + 100,
    })
    expect(service.canAdmitIdentity(paired.witness.identity)).toBe(true)
  })

  it('finishes a durable pending cleanup after restart without its old lease', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(paired.witness)
    await service.prepareCleanup(paired.witness)
    await credentialStore.revokeExtensionIdentity(
      paired.witness.identity.browser,
      paired.witness.identity.extensionId
    )

    const restarted = new ExtensionPairingProjectionService(projectionStore)
    await restarted.load()
    expect(restarted.list()[0]?.status).toBe('cleanup-pending')
    await restarted.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )
    expect(restarted.list()[0]?.status).toBe('cleanup-pending')

    const recoveredLease = await restarted.prepareIdentityCleanup(
      paired.witness.identity
    )
    await restarted.completeCleanup(
      recoveredLease,
      await absenceFor(paired.witness.identity)
    )
    expect(restarted.list()).toEqual([])
  })

  it('degrades and keeps the durable previous row when cleanup persistence fails', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(paired.witness)
    const durableBefore = clone(projectionStore.records)
    projectionStore.failNextSave = true

    await expect(service.prepareCleanup(paired.witness)).rejects.toThrow(
      ExtensionPairingProjectionError.PersistenceFailed
    )

    expect(service.getHealth()).toBe('degraded')
    expect(service.list()).toEqual([])
    expect(projectionStore.records).toEqual(durableBefore)
    expect(service.canAdmitIdentity(paired.witness.identity)).toBe(false)
  })

  it('degrades instead of reusing a stale row when a new epoch appears without cleanup', async () => {
    const first = await pair(PRINCIPAL_A, 'official', START + 100)
    await service.recordCommitted(first.witness)
    await credentialStore.revokeExtensionIdentity(
      first.witness.identity.browser,
      first.witness.identity.extensionId
    )
    const repaired = await pair(PRINCIPAL_A, 'official', START + 800)

    await expect(service.recordCommitted(repaired.witness)).rejects.toThrow(
      ExtensionPairingProjectionError.CleanupRequired
    )
    expect(service.getHealth()).toBe('degraded')
    expect(service.list()).toEqual([])
  })

  it('serializes concurrent updates without losing either identity', async () => {
    const a = await pair(PRINCIPAL_A, 'official', START + 100)
    const b = await pair(PRINCIPAL_B, 'unverified', START + 200)

    await Promise.all([
      service.recordCommitted(a.witness),
      service.recordCommitted(b.witness),
    ])

    expect(service.list().map((record) => record.identity)).toEqual([
      a.witness.identity,
      b.witness.identity,
    ])
    expect(projectionStore.saveCalls).toBe(2)
  })

  it('deletes only the identity named by a nominal cleanup lease', async () => {
    const a = await pair(PRINCIPAL_A, 'official', START + 100)
    const b = await pair(PRINCIPAL_B, 'official', START + 200)
    await service.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )

    const lease = await service.prepareCleanup(a.witness)
    await credentialStore.revokeExtensionIdentity(
      a.witness.identity.browser,
      a.witness.identity.extensionId
    )
    await service.completeCleanup(lease, await absenceFor(a.witness.identity))
    expect(service.list()[0]?.identity).toEqual(b.witness.identity)

    await expect(
      service.completeCleanup(
        {
          identity: b.witness.identity,
          authorizationEpoch: b.witness.authorizationEpoch,
        } as ExtensionPairingCleanupLease,
        {} as ExtensionIdentityAbsenceWitness
      )
    ).rejects.toThrow(ExtensionPairingProjectionError.InvalidCleanupLease)
  })

  it('preserves an existing pairedAt forever during same-epoch reconcile', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    projectionStore.records = [
      {
        identity: paired.witness.identity,
        identityTrust: 'official',
        authorizationEpoch: paired.witness.authorizationEpoch,
        status: 'ready',
        pairedAt: START + 500,
        lastActiveAt: null,
      },
    ] satisfies ExtensionPairingProjection[]
    service = new ExtensionPairingProjectionService(projectionStore)
    await service.load()

    await service.reconcileCommitted(
      await credentialStore.issueCommittedExtensionSnapshot()
    )
    expect(service.list()[0]?.pairedAt).toBe(START + 500)
  })

  it.each([
    ['future fields', [{ unexpected: true }]],
    ['too many rows', Array.from({ length: 4_097 }, () => null)],
  ])('fails closed on %s in storage', async (_name, records) => {
    projectionStore.records = records
    const candidate = new ExtensionPairingProjectionService(projectionStore)

    await expect(candidate.load()).rejects.toThrow(
      ExtensionPairingProjectionError.StorageRejected
    )
    expect(candidate.getHealth()).toBe('degraded')
    expect(candidate.list()).toEqual([])
  })

  it('redacts load failures and enters degraded state', async () => {
    projectionStore.failLoad = true
    const candidate = new ExtensionPairingProjectionService(projectionStore)

    await expect(candidate.load()).rejects.toThrow(
      ExtensionPairingProjectionError.PersistenceFailed
    )
    expect(candidate.getHealth()).toBe('degraded')
  })

  it('returns frozen copies and gives the store a deeply frozen snapshot', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    const created = await service.recordCommitted(paired.witness)
    const listed = service.list()

    expect(Object.isFrozen(created)).toBe(true)
    expect(Object.isFrozen(created.identity)).toBe(true)
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0]?.identity)).toBe(true)
    expect(projectionStore.lastSaveWasDeepFrozen).toBe(true)
    expect(() => {
      ;(listed[0] as { pairedAt: number }).pairedAt = 0
    }).toThrow()
    expect(service.list()[0]?.pairedAt).toBe(START + 100)
  })

  it('drains admitted work while rejecting new work after stop is requested', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    const gate = projectionStore.blockNextSave()
    const pending = service.recordCommitted(paired.witness)
    await gate.entered

    const drained = service.stopAndDrain()
    await expect(service.load()).rejects.toThrow(
      ExtensionPairingProjectionError.Stopped
    )
    gate.release()
    await expect(pending).resolves.toMatchObject({ pairedAt: START + 100 })
    await drained

    expect(service.getHealth()).toBe('stopped')
    await expect(service.recordCommitted(paired.witness)).rejects.toThrow(
      ExtensionPairingProjectionError.Stopped
    )
  })

  it('rejects a copied complete snapshot and a snapshot made stale by mutation', async () => {
    const paired = await pair(PRINCIPAL_A, 'official', START + 100)
    const snapshot = await credentialStore.issueCommittedExtensionSnapshot()

    await expect(
      service.reconcileCommitted({
        witnesses: snapshot.witnesses,
      } as unknown as CommittedExtensionCredentialSnapshot)
    ).rejects.toThrow(CommittedExtensionCredentialError.InvalidWitness)

    await credentialStore.revoke(paired.credentialId)
    await expect(service.reconcileCommitted(snapshot)).rejects.toThrow(
      CommittedExtensionCredentialError.NotCommitted
    )
  })
})
