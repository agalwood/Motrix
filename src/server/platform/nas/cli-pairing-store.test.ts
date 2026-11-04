import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AuthenticatedBridgeClient,
  cliCredentialFingerprint,
} from '@core/bridge/client-authorization'
import { type PairedClient, PairingService } from '@core/bridge/pairing-service'
import { ErrorCodes } from '@motrix/mdxp'
import { afterEach, expect, it, vi } from 'vitest'
import { NasCliPairingStore } from './cli-pairing-store'
import { NasClientAuthorization } from './client-authorization'
import {
  currentNasApprover,
  currentNasUser,
  type NasIdentity,
  runAsNasGatewayUser,
  runAsNasUser,
} from './identity'
import { nasPairingFile } from './pairing-file'

const alice: NasIdentity = {
  platform: 'fnos',
  userId: '1000',
  username: 'alice',
  administrator: true,
}
const bob: NasIdentity = { ...alice, userId: '1001', username: 'bob' }
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  )
})

function reference(client: PairedClient): AuthenticatedBridgeClient {
  return {
    identity: client.identity,
    credential: {
      kind: 'paired-cli',
      fingerprint: cliCredentialFingerprint(client.token),
    },
  }
}

async function fixture() {
  let document: string | null = null
  const storage = {
    read: vi.fn(async () => document),
    write: vi.fn(async (value: string) => {
      document = value
    }),
  }
  const store = new NasCliPairingStore('fnos', storage)
  const pairing = new PairingService(store)
  await pairing.load()
  const issue = (owner = alice, id = 'client') =>
    runAsNasGatewayUser(owner, () =>
      pairing.issueToken({ kind: 'cli', id }, 'CLI')
    )
  return { store, pairing, storage, issue, document: () => document }
}

it('requires an administrator owner and atomically restores it with the credential', async () => {
  const f = await fixture()
  await expect(
    f.pairing.issueToken({ kind: 'cli', id: 'unbound' }, 'CLI')
  ).rejects.toThrow('approval required')
  await expect(f.issue({ ...alice, administrator: false })).rejects.toThrow(
    'approval required'
  )
  await expect(f.issue({ ...alice, platform: 'qnap' })).rejects.toThrow(
    'approval required'
  )
  expect(f.document()).toBeNull()
  const paired = await f.issue()
  expect(f.store.ownerOf(reference(paired))).toEqual(alice)
  const restored = new NasCliPairingStore('fnos', f.storage)
  expect(await restored.load()).toEqual([paired])
  expect(restored.ownerOf(reference(paired))).toEqual(alice)
  expect(
    restored.ownerOf({
      ...reference(paired),
      identity: { kind: 'cli', id: 'other' },
    })
  ).toBeUndefined()
  expect(
    restored.ownerOf({
      identity: paired.identity,
      credential: { kind: 'local' },
    })
  ).toBeUndefined()
})

it('keeps concurrent approvers separate and background activity cannot reassign ownership', async () => {
  const f = await fixture()
  const [first, second] = await Promise.all([
    f.issue(alice, 'first'),
    f.issue(bob, 'second'),
  ])
  expect(f.store.ownerOf(reference(first))).toEqual(alice)
  expect(f.store.ownerOf(reference(second))).toEqual(bob)
  await f.store.save([{ ...first, lastActiveAt: Date.now() }, second])
  expect(f.store.ownerOf(reference(first))).toEqual(alice)
  await f.pairing.revoke(first.identity, 'test')
  expect(f.store.ownerOf(reference(first))).toBeUndefined()
  expect(f.store.ownerOf(reference(second))).toEqual(bob)
})

it('does not publish a rotated token or owner when persistence fails', async () => {
  const f = await fixture()
  const first = await f.issue()
  const before = f.document()
  f.storage.write.mockRejectedValueOnce(new Error('disk full'))
  await expect(f.issue(bob)).rejects.toThrow('disk full')
  expect(f.pairing.findByToken(first.token)).toEqual(first)
  expect(f.store.ownerOf(reference(first))).toEqual(alice)
  expect(f.document()).toBe(before)
})

it('fails closed on malformed or unbound documents', async () => {
  const f = await fixture()
  const first = await f.issue()
  for (const invalid of [
    '{',
    JSON.stringify([first]),
    JSON.stringify({
      version: 1,
      clients: [
        { client: first, owner: bob },
        { client: first, owner: alice },
      ],
    }),
  ]) {
    f.storage.read.mockResolvedValueOnce(invalid)
    await expect(f.store.load()).rejects.toThrow()
    expect(f.store.ownerOf(reference(first))).toBeUndefined()
  }
})

it('stores the owner and bearer credential in an owner-only file', async () => {
  const root = await mkdtemp('/tmp/motrix-nas-pairing-')
  directories.push(root)
  const file = path.join(root, 'pairing.json')
  await writeFile(file, JSON.stringify({ version: 1, clients: [] }), {
    mode: 0o644,
  })
  const store = new NasCliPairingStore('fnos', nasPairingFile(file))
  const pairing = new PairingService(store)
  await pairing.load()
  const paired = await runAsNasGatewayUser(alice, () =>
    pairing.issueToken({ kind: 'cli', id: 'client' }, 'CLI')
  )
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  const restored = new NasCliPairingStore('fnos', nasPairingFile(file))
  await restored.load()
  expect(restored.ownerOf(reference(paired))).toEqual(alice)
})

it.each([
  null,
  { ...alice, administrator: false },
  bob,
  { ...alice, username: 'replacement' },
  { ...alice, platform: 'qnap' as const },
  { ...alice, accountRevision: 'replacement' },
])('rejects a deleted, demoted or changed account: %j', async (current) => {
  const f = await fixture()
  const paired = await f.issue()
  const authority = new NasClientAuthorization(f.store, {
    platform: 'fnos',
    resolve: async () => current,
  })
  const operation = vi.fn(async () => 'private')
  await expect(
    authority.run(reference(paired), operation)
  ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
  expect(operation).not.toHaveBeenCalled()
})

it('revalidates every call and propagates the current account only inside the operation', async () => {
  const f = await fixture()
  const paired = await f.issue()
  const resolve = vi.fn(async () => alice)
  const authority = new NasClientAuthorization(f.store, {
    platform: 'fnos',
    resolve,
  })
  for (let i = 0; i < 2; i++)
    expect(
      await authority.run(reference(paired), async () => currentNasUser())
    ).toEqual(alice)
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(currentNasUser()).toBeUndefined()
  resolve.mockRejectedValueOnce(new Error('vendor offline'))
  await expect(
    authority.run(reference(paired), async () => 'private')
  ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
})

it('rejects an old request when re-pairing changes the owner during account lookup', async () => {
  const f = await fixture()
  const old = await f.issue()
  let release!: (value: NasIdentity) => void
  const lookup = new Promise<NasIdentity>((resolve) => {
    release = resolve
  })
  const authority = new NasClientAuthorization(f.store, {
    platform: 'fnos',
    resolve: () => lookup,
  })
  const operation = vi.fn(async () => 'private')
  const pending = authority.run(reference(old), operation)
  const assertion = expect(pending).rejects.toMatchObject({
    code: ErrorCodes.PermissionDenied,
  })
  const next = await f.issue(bob)
  release(alice)
  await assertion
  expect(operation).not.toHaveBeenCalled()
  expect(f.store.ownerOf(reference(old))).toBeUndefined()
  expect(f.store.ownerOf(reference(next))).toEqual(bob)
})

it('bounds account lookup even when the platform ignores cancellation', async () => {
  const f = await fixture()
  const paired = await f.issue()
  let signal: AbortSignal | undefined
  const authority = new NasClientAuthorization(
    f.store,
    {
      platform: 'fnos',
      resolve: (_identity, abort) => {
        signal = abort
        return new Promise(() => {})
      },
    },
    10
  )
  const operation = vi.fn(async () => 'private')
  await expect(
    authority.run(reference(paired), operation)
  ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
  expect(signal?.aborted).toBe(true)
  expect(operation).not.toHaveBeenCalled()
})

it('denies credential minting from internal work and an already paired administrator', async () => {
  const f = await fixture()
  const issue = () => f.pairing.issueToken({ kind: 'cli', id: 'other' }, 'CLI')
  await expect(runAsNasUser(alice, issue)).rejects.toThrow('approval required')
  const first = await f.issue()
  const authority = new NasClientAuthorization(f.store, {
    platform: 'fnos',
    resolve: async () => alice,
  })
  await expect(
    runAsNasGatewayUser(bob, () =>
      authority.run(reference(first), async () => {
        expect(currentNasApprover()).toBeUndefined()
        return issue()
      })
    )
  ).rejects.toThrow('approval required')
  expect(await f.store.load()).toEqual([first])
})
