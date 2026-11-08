import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mbp1CredentialStore, type StoredCredential } from '../credential-store'
import {
  concatBytes,
  enc,
  fromBase64Url,
  hmacSha256,
  toBase64Url,
} from './canonical'
import { buildRT, reconnectMacClient } from './reconnect-mac'
import { ReconnectSession } from './reconnect-session'
import { bindSafariResume } from './safari-installation'
import {
  deriveTicketKey,
  TicketReplayCache,
  ticketMacInput,
} from './ticket-verify'

const oldOrigin = 'safari-web-extension://41cf2a73-eb74-4f1d-a74b-da20e9f24d8b'
const newOrigin = 'safari-web-extension://dc0ebd48-d655-4c58-baca-87b4960e6534'
const instanceId = 'fixture-instance'
const secret = new Uint8Array(32).fill(17)
const publicKey = toBase64Url(ed25519.getPublicKey(secret))
const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function fixture(
  enrolled = true,
  identity: 'official' | 'unverified' = 'official'
) {
  const dir = await mkdtemp(join(tmpdir(), 'motrix-safari-continuity-'))
  folders.push(dir)
  const file = join(dir, 'credentials.json')
  const store = await Mbp1CredentialStore.load(file)
  const principal = {
    browser: 'safari' as const,
    verifiedOrigin: oldOrigin,
    clientInstallationId: 'installation-a',
    ...(enrolled ? { safariInstallationKey: publicKey } : {}),
  }
  const offer = await store.offerProvisional(principal, identity)
  await store.commitFromPair(offer.credentialId)
  const credential = store.findForAuth(offer.credentialId)
  if (!credential) throw new Error('Missing fixture credential')
  return { file, store, credential }
}

function ticket(overrides: Record<string, unknown> = {}) {
  const fields = {
    v: 1,
    purpose: 'mbp1-attestation',
    protocolVersion: 1,
    serverGeneration: 'generation',
    browser: 'safari',
    callerId: 'app.motrix.safari.extension',
    exp: Math.floor(Date.now() / 1000) + 30,
    bindingPub: ed25519.getPublicKey(secret),
    ...overrides,
  }
  return {
    ...fields,
    bindingPub: toBase64Url(fields.bindingPub),
    mac: toBase64Url(
      hmacSha256(deriveTicketKey('local-token'), ticketMacInput(fields))
    ),
  }
}

async function resume(
  store: Mbp1CredentialStore,
  credential: StoredCredential,
  options: {
    origin?: string
    signingKey?: Uint8Array
    proof?: boolean
    nmTicket?: unknown
    replay?: TicketReplayCache
    mutate?: (frame: Record<string, unknown>) => void
  } = {}
) {
  const origin = options.origin ?? newOrigin
  const frames: Record<string, unknown>[] = []
  let authenticated: StoredCredential | null = null
  const s = new Uint8Array(32).fill(23)
  const c = new Uint8Array(32).fill(37)
  const session = new ReconnectSession({
    browser: 'safari',
    verifiedOrigin: origin,
    instanceId,
    credentials: store,
    safariTicketContext: {
      localToken: 'local-token',
      serverGeneration: 'generation',
      replay: options.replay ?? new TicketReplayCache(),
    },
    now: Date.now,
    random: () => s,
    close: () => {},
    sendText: (frame) => frames.push(frame as Record<string, unknown>),
    onAuthenticated: (_channel, value) => {
      authenticated = value
    },
  })
  session.start()
  let rt = buildRT({
    protocolVersion: 1,
    credentialId: credential.credentialId,
    browser: 'safari',
    verifiedOrigin: origin,
    instanceId,
  })
  const key = options.signingKey ?? secret
  const pub = toBase64Url(ed25519.getPublicKey(key))
  if (options.proof !== false) rt = bindSafariResume(rt, pub, options.nmTicket)
  const frame: Record<string, unknown> = {
    type: 'reconnectResponse',
    credentialId: credential.credentialId,
    C: toBase64Url(c),
    mac: toBase64Url(
      reconnectMacClient(fromBase64Url(credential.mutualKeyB64), s, c, rt)
    ),
    ...(options.proof === false
      ? {}
      : {
          safariResume: {
            installationKey: pub,
            proof: toBase64Url(
              ed25519.sign(
                concatBytes(enc('MBP1/safari-resume-proof/v1'), s, c, rt),
                key
              )
            ),
            ...(options.nmTicket === undefined
              ? {}
              : { nmTicket: options.nmTicket }),
          },
        }),
  }
  options.mutate?.(frame)
  const json = JSON.stringify(frame)
  await session.handleText(json, Buffer.byteLength(json))
  session.dispose('socket-closed')
  return { frames, authenticated }
}

describe('Safari origin continuity', () => {
  it('survives repeated browser and backend restarts while preserving routing and revocation identity', async () => {
    const f = await fixture()
    const first = await resume(f.store, f.credential)
    expect(first.authenticated).toMatchObject({
      principal: f.credential.principal,
      authorizationEpoch: f.credential.authorizationEpoch,
    })
    const reloaded = await Mbp1CredentialStore.load(f.file)
    const second = await resume(reloaded, f.credential, {
      origin: 'safari-web-extension://080fc68d-07a6-46aa-8525-3debc6d0ee01',
    })
    expect(second.frames.at(-1)?.type).toBe('reconnectAccept')
  })

  it.each([oldOrigin, newOrigin])(
    'rejects proof stripping even with a valid mutual-key MAC (%s)',
    async (origin) => {
      const f = await fixture()
      const result = await resume(f.store, f.credential, {
        origin,
        proof: false,
      })
      expect(result.frames.at(-1)).toEqual({
        type: 'pairError',
        code: 'authFailed',
      })
      expect(result.authenticated).toBeNull()
    }
  )

  it('rejects a stolen mutual key used with another installation key', async () => {
    const f = await fixture()
    expect(
      (
        await resume(f.store, f.credential, {
          signingKey: new Uint8Array(32).fill(18),
        })
      ).authenticated
    ).toBeNull()
  })

  it('rejects a forged signature even when the credential MAC is valid', async () => {
    const f = await fixture()
    const result = await resume(f.store, f.credential, {
      mutate: (frame) => {
        ;(frame.safariResume as { proof: string }).proof = toBase64Url(
          new Uint8Array(64)
        )
      },
    })
    expect(result.authenticated).toBeNull()
  })

  it('requires fresh native attestation to migrate a legacy official credential across origins', async () => {
    const f = await fixture(false)
    expect((await resume(f.store, f.credential)).authenticated).toBeNull()
    expect(
      f.store.findForAuth(f.credential.credentialId)?.principal
        .safariInstallationKey
    ).toBeUndefined()
    const result = await resume(f.store, f.credential, { nmTicket: ticket() })
    expect(result.authenticated).toMatchObject({
      principal: {
        verifiedOrigin: oldOrigin,
        safariInstallationKey: publicKey,
      },
    })
    const loaded = await Mbp1CredentialStore.load(f.file)
    expect(
      (
        await resume(
          loaded,
          loaded.findForAuth(f.credential.credentialId) as StoredCredential
        )
      ).authenticated
    ).not.toBeNull()
  })

  it.each([
    { serverGeneration: 'old-generation' },
    { callerId: 'another.extension' },
    { browser: 'firefox' },
    { exp: 1 },
  ])('rejects unusable native migration evidence: %j', async (overrides) => {
    const f = await fixture(false)
    expect(
      (await resume(f.store, f.credential, { nmTicket: ticket(overrides) }))
        .authenticated
    ).toBeNull()
  })

  it('does not use official native evidence to raise an unverified legacy identity', async () => {
    const f = await fixture(false, 'unverified')
    expect(
      (await resume(f.store, f.credential, { nmTicket: ticket() }))
        .authenticated
    ).toBeNull()
  })

  it('can enroll a remote legacy credential only while its original origin still matches', async () => {
    const f = await fixture(false, 'unverified')
    expect(
      (await resume(f.store, f.credential, { origin: oldOrigin })).authenticated
    ).not.toBeNull()
    const current = f.store.findForAuth(
      f.credential.credentialId
    ) as StoredCredential
    expect((await resume(f.store, current)).authenticated).not.toBeNull()
  })

  it('does not resurrect a revoked credential during continuity enrollment', async () => {
    const f = await fixture(false)
    await f.store.revokeExtensionIdentity(
      'safari',
      oldOrigin.slice('safari-web-extension://'.length)
    )
    await expect(
      f.store.bindSafariInstallation(f.credential, publicKey)
    ).rejects.toThrow()
    expect(
      (await resume(f.store, f.credential, { nmTicket: ticket() }))
        .authenticated
    ).toBeNull()
  })
  it('consumes a migration ticket once even when another valid credential and signature are supplied', async () => {
    const f = await fixture(false)
    const replay = new TicketReplayCache()
    const nmTicket = ticket()
    expect(
      (await resume(f.store, f.credential, { nmTicket, replay })).authenticated
    ).not.toBeNull()
    const next = await f.store.offerProvisional(
      {
        browser: 'safari',
        verifiedOrigin: oldOrigin,
        clientInstallationId: 'installation-b',
      },
      'official'
    )
    await f.store.commitFromPair(next.credentialId)
    const other = f.store.findForAuth(next.credentialId) as StoredCredential
    expect(
      (await resume(f.store, other, { nmTicket, replay })).authenticated
    ).toBeNull()
  })

  it('rechecks revocation after signature verification and before sending an accept', async () => {
    const f = await fixture(false)
    const bind = f.store.bindSafariInstallation.bind(f.store)
    vi.spyOn(f.store, 'bindSafariInstallation').mockImplementation(
      async (expected, key) => {
        await f.store.revoke(expected.credentialId)
        await bind(expected, key)
      }
    )
    const result = await resume(f.store, f.credential, { nmTicket: ticket() })
    expect(result.authenticated).toBeNull()
    expect(result.frames.at(-1)).toEqual({
      type: 'pairError',
      code: 'authFailed',
    })
    expect(f.store.findForAuth(f.credential.credentialId)).toBeNull()
  })
})
