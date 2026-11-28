import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { Mbp1CredentialStore } from '@core/bridge/credential-store'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import type { PairingPromptTimeSource } from '@core/bridge/pairing-prompt-controller'
import { pairRequestKey } from '@shared/protocol/bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeEventBus } from '../../core/bridge/bridge-event-bus'
import { NasExtensionBindings } from '../platform/nas/extension-bindings'
import {
  type NasIdentity,
  runAsNasGatewayUser,
  runAsNasUser,
} from '../platform/nas/identity'
import { ServerExtensionPairingPromptAdapter } from './extension-pairing-prompt-adapter'

const REQUEST: PairDialogRequest = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  pairingNonce: 'nonce-a',
  code: 'ABCD-EFGH',
}

function fakeTime(start = 1_700_000_000_000): {
  source: PairingPromptTimeSource
  advance(ms: number): void
} {
  let now = start
  let scheduled: (() => void) | null = null
  let deadline = Infinity
  return {
    source: {
      now: () => now,
      schedule: (callback, delayMs) => {
        scheduled = callback
        deadline = now + delayMs
        return () => {
          scheduled = null
        }
      },
    },
    advance(ms) {
      now += ms
      if (now < deadline) return
      const callback = scheduled
      scheduled = null
      callback?.()
    },
  }
}

describe('ServerExtensionPairingPromptAdapter', () => {
  it('publishes the code synchronously and exposes the same pending snapshot', async () => {
    const bus = new BridgeEventBus()
    const requested = vi.fn()
    bus.on('PairRequested', requested)
    const adapter = new ServerExtensionPairingPromptAdapter(bus, {
      publicAuthority: 'motrix.example',
    })

    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    await expect(queued.handle.published).resolves.toBe('delivered')
    expect(requested).toHaveBeenCalledExactlyOnceWith({
      kind: 'extension',
      pairingNonce: 'nonce-a',
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browser: 'chromium',
      identity: 'official',
      code: 'ABCD-EFGH',
      verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originHost: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attestationClass: 'official',
      publicAuthority: 'motrix.example',
    })
    expect(adapter.listPending()).toEqual([
      expect.objectContaining({
        code: 'ABCD-EFGH',
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      }),
    ])

    await adapter.dispose()
  })

  it('maps an operator dismissal to one code-free denied terminal event', async () => {
    const bus = new BridgeEventBus()
    const settled = vi.fn()
    bus.on('PairRequestSettled', settled)
    const adapter = new ServerExtensionPairingPromptAdapter(bus)
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    expect(
      adapter.settle({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      })
    ).toEqual({ ok: true })
    await expect(queued.handle.terminal).resolves.toBe('denied')
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      key: pairRequestKey({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      }),
      outcome: 'denied',
    })
    expect(JSON.stringify(settled.mock.calls)).not.toContain(REQUEST.code)
    expect(adapter.listPending()).toEqual([])
    expect(
      adapter.settle({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      })
    ).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('expires without placing the code in the terminal event', async () => {
    const clock = fakeTime()
    const bus = new BridgeEventBus()
    const expired = vi.fn()
    bus.on('PairRequestExpired', expired)
    const adapter = new ServerExtensionPairingPromptAdapter(bus, {
      ttlMs: 1_000,
      timeSource: clock.source,
    })
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    clock.advance(1_000)
    await expect(queued.handle.terminal).resolves.toBe('expired')
    expect(expired).toHaveBeenCalledOnce()
    expect(JSON.stringify(expired.mock.calls)).not.toContain(REQUEST.code)
    expect(adapter.listPending()).toEqual([])
  })

  it('classifies a throwing operator publisher as failed', async () => {
    const bus = new BridgeEventBus()
    bus.on('PairRequested', () => {
      throw new Error('secret delivery path')
    })
    const adapter = new ServerExtensionPairingPromptAdapter(bus)
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    await expect(queued.handle.published).resolves.toBe('failed')
    expect(adapter.listPending()).toHaveLength(1)
    await adapter.dispose()
    await expect(queued.handle.terminal).resolves.toBe('aborted')
  })
})

describe('NAS Extension code claims', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })
  const alice: NasIdentity = {
    platform: 'fnos',
    userId: '1000',
    username: 'alice',
    administrator: true,
    accountRevision: 'generation-one',
  }
  const bob: NasIdentity = { ...alice, userId: '1001', username: 'bob' }
  const params = {
    browser: REQUEST.browser,
    pairingNonce: REQUEST.pairingNonce,
    extensionId: REQUEST.claimedExtensionId,
    expectedUsername: 'alice',
  }
  async function fixture() {
    const root = await mkdtemp('/tmp/motrix-nas-claim-')
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const credentials = await Mbp1CredentialStore.load(
      path.join(root, 'credentials.json')
    )
    const accounts = {
      platform: 'fnos' as const,
      resolve: vi.fn(
        async (owner: NasIdentity): Promise<NasIdentity | null> => ({
          ...owner,
        })
      ),
    }
    const bindings = new NasExtensionBindings(credentials, accounts, {
      read: async () => null,
      write: async () => {},
    })
    await bindings.load()
    const clock = fakeTime()
    const bus = new BridgeEventBus()
    const requested = vi.fn()
    bus.on('PairRequested', requested)
    const adapter = new ServerExtensionPairingPromptAdapter(bus, {
      nasBindings: bindings,
      timeSource: clock.source,
    })
    cleanup.push(() => adapter.dispose())
    const queued = adapter.queueMbp1Prompt(REQUEST)
    if (!queued.ok) throw new Error('Prompt not queued')
    const claim = (owner = alice) =>
      runAsNasGatewayUser(owner, () =>
        adapter.claim({ ...params, expectedUsername: owner.username! })
      )
    return {
      adapter,
      bindings,
      credentials,
      accounts,
      clock,
      requested,
      queued,
      claim,
    }
  }

  it('publishes only metadata and reveals a code solely to its explicit, revalidated claimant', async () => {
    const f = await fixture()
    await expect(f.queued.handle.published).resolves.toBe('delivered')
    expect(f.adapter.listPending()[0]).toMatchObject({
      kind: 'extension-claim',
    })
    expect(JSON.stringify(f.requested.mock.calls)).not.toContain(REQUEST.code)
    expect(JSON.stringify(f.adapter.listPending())).not.toContain(REQUEST.code)
    await expect(f.adapter.claim(params)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
    await expect(
      runAsNasUser(alice, () => f.adapter.claim(params))
    ).resolves.toMatchObject({ ok: false })
    await expect(f.claim()).resolves.toEqual({
      ok: true,
      code: REQUEST.code,
      expiresInMs: 120_000,
    })
    await expect(f.claim(bob)).resolves.toMatchObject({ ok: false })
    f.clock.advance(30_000)
    await expect(f.claim()).resolves.toMatchObject({
      ok: true,
      expiresInMs: 90_000,
    })
    f.accounts.resolve.mockResolvedValue(null)
    await expect(f.claim()).resolves.toMatchObject({ ok: false })
    expect(JSON.stringify(f.adapter.listPending())).not.toContain(REQUEST.code)
  })

  it('rejects a cached displayed account that differs from the gateway account', async () => {
    const f = await fixture()
    await expect(
      runAsNasGatewayUser(bob, () => f.adapter.claim(params))
    ).resolves.toMatchObject({ ok: false })
    await expect(f.claim()).resolves.toMatchObject({ ok: true })
  })

  it('admits one concurrent claimant and releases an approval that completes after expiry', async () => {
    const f = await fixture()
    let resolve!: (value: NasIdentity) => void
    f.accounts.resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const release = vi.spyOn(f.bindings, 'release')
    const pending = f.claim()
    await expect(f.claim(bob)).resolves.toMatchObject({ ok: false })
    f.clock.advance(120_000)
    resolve(alice)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(release).toHaveBeenCalledOnce()
    expect(f.adapter.listPending()).toEqual([])
    await expect(f.claim()).resolves.toMatchObject({ ok: false })
  })

  it('requires the exact live claim before offering and revalidates the account before commit', async () => {
    const f = await fixture()
    const audience = {
      browser: REQUEST.browser,
      verifiedOrigin: REQUEST.verifiedOrigin,
      pairingNonce: REQUEST.pairingNonce,
    }
    const principal = {
      browser: audience.browser,
      verifiedOrigin: audience.verifiedOrigin,
      clientInstallationId: 'installation',
    }
    const { issuer } = f.adapter.issuerFor(audience)
    expect(() => issuer.offerProvisional(principal, 'official')).toThrow(
      'not claimed'
    )
    await f.claim()
    expect(() => issuer.offerProvisional(principal, 'official')).toThrow(
      'not claimed'
    )
    expect(f.queued.handle.settle('paired').ok).toBe(true)
    expect(() =>
      f.adapter
        .issuerFor({ ...audience, pairingNonce: 'other' })
        .issuer.offerProvisional(principal, 'official')
    ).toThrow('not claimed')
    const offer = await issuer.offerProvisional(principal, 'official')
    expect(f.credentials.findForAuth(offer.credentialId)).not.toBeNull()
    f.accounts.resolve.mockResolvedValue({ ...alice, administrator: false })
    await expect(
      issuer.commitFromPair(offer.credentialId)
    ).rejects.toBeDefined()
    f.clock.advance(120_000)
    await expect(issuer.commitFromPair(offer.credentialId)).rejects.toThrow(
      'not claimed'
    )
  })

  it.each(['socket-close', 'runtime-disposal'] as const)(
    'releases a proven claim on %s before credential commit',
    async (reason) => {
      const f = await fixture()
      const scope = f.adapter.issuerFor({
        browser: REQUEST.browser,
        verifiedOrigin: REQUEST.verifiedOrigin,
        pairingNonce: REQUEST.pairingNonce,
      })
      const release = vi.spyOn(f.bindings, 'release')
      await f.claim()
      f.queued.handle.settle('paired')
      expect(release).not.toHaveBeenCalled()
      expect(f.adapter.listPending()).toEqual([])
      if (reason === 'socket-close') scope.release()
      else await f.adapter.dispose()
      scope.release()
      expect(release).toHaveBeenCalledOnce()
      expect(() =>
        scope.issuer.offerProvisional(
          {
            browser: REQUEST.browser,
            verifiedOrigin: REQUEST.verifiedOrigin,
            clientInstallationId: 'installation',
          },
          'official'
        )
      ).toThrow('not claimed')
    }
  )
})
