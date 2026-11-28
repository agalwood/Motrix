import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AuthenticatedBridgeClient } from '@core/bridge/client-authorization'
import { Mbp1CredentialStore } from '@core/bridge/credential-store'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type NasExtensionApproval,
  NasExtensionBindings,
} from './extension-bindings'
import { type NasIdentity, runAsNasGatewayUser, runAsNasUser } from './identity'
import { nasPairingFile } from './pairing-file'

const alice: NasIdentity = {
  platform: 'fnos',
  userId: '1000',
  username: 'alice',
  administrator: true,
  accountRevision: 'generation-one',
}
const bob: NasIdentity = { ...alice, userId: '1001', username: 'bob' }
const principal = {
  browser: 'chromium' as const,
  verifiedOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  clientInstallationId: 'installation',
}
const audience = {
  browser: principal.browser,
  verifiedOrigin: principal.verifiedOrigin,
  pairingNonce: 'pair-request',
}
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  const root = await mkdtemp('/tmp/motrix-nas-extension-binding-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const credentialFile = path.join(root, 'credentials.json')
  const bindingFile = path.join(root, 'bindings.json')
  const credentials = await Mbp1CredentialStore.load(credentialFile)
  const file = nasPairingFile(bindingFile)
  const storage = { read: vi.fn(file.read), write: vi.fn(file.write) }
  const accounts = {
    platform: 'fnos' as const,
    resolve: vi.fn(
      async (identity: NasIdentity): Promise<NasIdentity | null> => ({
        ...identity,
        accountRevision: 'generation-one',
      })
    ),
  }
  const store = new NasExtensionBindings(credentials, accounts, storage)
  await store.load()
  const issuer = (approval: NasExtensionApproval) =>
    store.issuer(approval, audience)
  const approve = (owner = alice) =>
    runAsNasGatewayUser(owner, () => store.approve(audience))
  const reference = (credentialId: string): AuthenticatedBridgeClient => ({
    identity: {
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    },
    credential: {
      kind: 'extension',
      credentialId,
      authorizationEpoch:
        credentials.findForAuth(credentialId)!.authorizationEpoch!,
    },
  })
  return {
    root,
    credentialFile,
    bindingFile,
    credentials,
    storage,
    accounts,
    store,
    approve,
    issuer,
    reference,
  }
}

it('requires a gateway approval capability and cannot accept an internal identity or copied token', async () => {
  const f = await fixture()
  await expect(f.store.approve(audience)).rejects.toThrow('approval')
  await expect(
    runAsNasUser(alice, () => f.store.approve(audience))
  ).rejects.toThrow('approval')
  await expect(f.approve({ ...alice, administrator: false })).rejects.toThrow()
  expect(() => f.issuer({} as NasExtensionApproval)).toThrow('approval')
  expect(f.storage.write).not.toHaveBeenCalled()
})

it('persists the owner before the provisional credential is visible and restores it across restart', async () => {
  const f = await fixture()
  const write = f.storage.write.getMockImplementation()!
  f.storage.write.mockImplementationOnce(async (value) => {
    const metadata = JSON.parse(value).bindings[0]
    expect(f.credentials.findForAuth(metadata.credentialId)).toBeNull()
    expect(await readFile(f.credentialFile).catch(() => null)).toBeNull()
    await write(value)
  })
  const approval = await f.approve()
  const issuer = f.issuer(approval)
  const offer = await issuer.offerProvisional(principal, 'official')
  const reference = f.reference(offer.credentialId)
  expect(f.store.ownerOf(reference)).toEqual(alice)
  await issuer.commitFromPair(offer.credentialId)
  const restoredCredentials = await Mbp1CredentialStore.load(f.credentialFile)
  const restored = new NasExtensionBindings(
    restoredCredentials,
    f.accounts,
    nasPairingFile(f.bindingFile)
  )
  await restored.load()
  expect(restored.ownerOf(reference)).toEqual(alice)
  expect((await stat(f.bindingFile)).mode & 0o777).toBe(0o600)
  expect(
    (await readFile(f.bindingFile, 'utf8')).includes(offer.mutualKeyB64)
  ).toBe(false)
  expect(
    restored.ownerOf({
      ...reference,
      identity: { kind: 'extension', browser: 'firefox', extensionId: 'other' },
    })
  ).toBeUndefined()
})

it('refuses to publish a credential if its owner cannot be saved', async () => {
  const f = await fixture()
  const approval = await f.approve()
  f.storage.write.mockRejectedValueOnce(new Error('disk full'))
  await expect(
    f.issuer(approval).offerProvisional(principal, 'official')
  ).rejects.toThrow('disk full')
  expect(await readFile(f.credentialFile).catch(() => null)).toBeNull()
  const offer = await f.issuer(approval).offerProvisional(principal, 'official')
  expect(f.store.ownerOf(f.reference(offer.credentialId))).toEqual(alice)
})

it('keeps the owner on same-principal re-offers and cannot transfer an existing secret to another administrator', async () => {
  const f = await fixture()
  const first = f.issuer(await f.approve())
  const second = f.issuer(await f.approve(bob))
  const offer = await first.offerProvisional(principal, 'official')
  expect(
    (await first.offerProvisional(principal, 'official')).credentialId
  ).toBe(offer.credentialId)
  await expect(second.offerProvisional(principal, 'official')).rejects.toThrow(
    'approval'
  )
  expect(f.store.ownerOf(f.reference(offer.credentialId))).toEqual(alice)
  // An explicit replacement after the first commit has a fresh credential.
  await first.commitFromPair(offer.credentialId)
  const replacement = await second.offerProvisional(principal, 'official')
  expect(replacement.credentialId).not.toBe(offer.credentialId)
  expect(f.store.ownerOf(f.reference(replacement.credentialId))).toEqual(bob)
})

it('never repairs a lost owner by attaching the old credential to a new approver', async () => {
  const f = await fixture()
  const original = await f
    .issuer(await f.approve())
    .offerProvisional(principal, 'official')
  await rm(f.bindingFile)
  await f.store.load()
  expect(f.store.ownerOf(f.reference(original.credentialId))).toBeUndefined()
  await expect(
    f.issuer(await f.approve(bob)).offerProvisional(principal, 'official')
  ).rejects.toThrow('approval')
  expect(await readFile(f.bindingFile).catch(() => null)).toBeNull()
})

it.each([
  null,
  { ...alice, administrator: false },
  { ...alice, accountRevision: 'changed' },
])(
  'revalidates a claimed approval before issuing a credential: %j',
  async (current) => {
    const f = await fixture()
    const approval = await f.approve()
    f.accounts.resolve.mockResolvedValue(current)
    await expect(
      f.issuer(approval).offerProvisional(principal, 'official')
    ).rejects.toThrow()
    expect(f.storage.write).not.toHaveBeenCalled()
    expect(await readFile(f.credentialFile).catch(() => null)).toBeNull()
  }
)

it('does not publish a credential when its prompt expires while binding persistence is pending', async () => {
  const f = await fixture()
  const approval = await f.approve()
  const write = f.storage.write.getMockImplementation()!
  f.storage.write.mockImplementationOnce(async (value) => {
    await write(value)
    f.store.release(approval)
  })
  await expect(
    f.issuer(approval).offerProvisional(principal, 'official')
  ).rejects.toThrow('approval')
  expect(await readFile(f.credentialFile).catch(() => null)).toBeNull()
  expect(() => f.issuer(approval)).toThrow('approval')
  // The harmless orphan owner is removed by the next successful fresh offer.
  const next = await f
    .issuer(await f.approve(bob))
    .offerProvisional(principal, 'official')
  expect(
    JSON.parse(await readFile(f.bindingFile, 'utf8')).bindings.map(
      (row: { credentialId: string }) => row.credentialId
    )
  ).toEqual([next.credentialId])
})

it('allows only the same revalidated gateway account to retrieve a claimed code', async () => {
  const f = await fixture()
  const approval = await f.approve()
  expect(
    await runAsNasGatewayUser(alice, () =>
      f.store.approvedByCurrentOperator(approval)
    )
  ).toBe(true)
  expect(
    await runAsNasGatewayUser(bob, () =>
      f.store.approvedByCurrentOperator(approval)
    )
  ).toBe(false)
  expect(
    await runAsNasUser(alice, () => f.store.approvedByCurrentOperator(approval))
  ).toBe(false)
  f.store.release(approval)
  expect(
    await runAsNasGatewayUser(alice, () =>
      f.store.approvedByCurrentOperator(approval)
    )
  ).toBe(false)
})

it('cannot commit a pending rotation after its approving account is disabled', async () => {
  const f = await fixture()
  const first = f.issuer(await f.approve())
  const predecessor = await first.offerProvisional(principal, 'official')
  await first.commitFromPair(predecessor.credentialId)
  const next = f.issuer(await f.approve(bob))
  const offered = await next.offerProvisional(principal, 'official')
  f.accounts.resolve.mockResolvedValue(null)
  await expect(next.commitFromPair(offered.credentialId)).rejects.toThrow()
  expect(f.credentials.findForAuth(predecessor.credentialId)?.state).toBe(
    'committed'
  )
  expect(f.credentials.findForAuth(offered.credentialId)?.state).toBe(
    'provisional'
  )
})

it('confines an approval to its exact browser origin and pending nonce', async () => {
  const f = await fixture()
  const approval = await f.approve()
  expect(() =>
    f.store.issuer(approval, { ...audience, pairingNonce: 'another-request' })
  ).toThrow('approval')
  expect(() =>
    f.store.issuer(approval, { ...audience, browser: 'firefox' })
  ).toThrow('approval')
  await expect(
    f.issuer(approval).offerProvisional(
      {
        ...principal,
        verifiedOrigin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba',
      },
      'official'
    )
  ).rejects.toThrow('approval')
  expect(f.storage.write).not.toHaveBeenCalled()
})
