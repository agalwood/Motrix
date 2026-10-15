import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { CredentialStore } from '@/background/mbp1/credential-store'
import {
  type Pin,
  PinStore,
  RemotePinStoreUnsupportedError,
  UnsupportedPinStoreVersionError,
} from '@/background/mbp1/pin-store'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.mbp1.pins'

let backing: Record<string, unknown> = {}
let readDelayMs = 0

beforeEach(() => {
  backing = {}
  readDelayMs = 0
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    // Snapshot at call time, deliver after the delay -- a real storage read
    // captures the value when it runs, not when it resolves. Delaying before
    // the snapshot would silently close the read-modify-write window the
    // serialization tests below exist to hold open.
    const snapshot: Record<string, unknown> = {}
    for (const key of typeof k === 'string' ? [k] : k) {
      if (key in backing) snapshot[key] = backing[key]
    }
    await new Promise((resolve) => setTimeout(resolve, readDelayMs))
    return snapshot
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

/** The raw persisted record, to assert on shape the public API hides. */
function persisted(): { version: unknown; pins: Record<string, unknown> } {
  return backing[STORAGE_KEY] as never
}

const P1: Pin = { port: 16803, instanceId: 'inst-x' }
const P2: Pin = { port: 16805, instanceId: 'inst-y' }

describe('PinStore', () => {
  it('is explicitly local-authority-only', async () => {
    const local = new PinStore(LOCAL_BACKEND_AUTHORITY)
    await local.commit('c1', P1)
    expect(await local.get('c1')).toEqual(P1)

    expect(
      () =>
        new PinStore(
          createRemoteBackendAuthority({
            endpointId: 'server-a',
            wsBase: 'wss://motrix.example',
          })
        )
    ).toThrow(RemotePinStoreUnsupportedError)
    // Rejecting the remote dependency cannot alter the local pin namespace.
    expect(await local.get('c1')).toEqual(P1)
  })

  it('round-trips a pin keyed by credentialId', async () => {
    const s = new PinStore()
    expect(await s.get('c1')).toBeNull()
    await s.commit('c1', { port: 16803, instanceId: 'inst-x' })
    expect(await s.get('c1')).toEqual({ port: 16803, instanceId: 'inst-x' })
    await s.clear('c1')
    expect(await s.get('c1')).toBeNull()
  })

  it('persists a versioned, credentialId-keyed map', async () => {
    const s = new PinStore()
    await s.commit('c1', P1)
    expect(persisted()).toEqual({ version: 1, pins: { c1: P1 } })
  })

  it('keeps pins for different credentials independent', async () => {
    const s = new PinStore()
    await s.commit('c1', P1)
    await s.commit('c2', P2)
    expect(await s.get('c1')).toEqual(P1)
    expect(await s.get('c2')).toEqual(P2)
    await s.clear('c1')
    expect(await s.get('c1')).toBeNull()
    expect(await s.get('c2')).toEqual(P2)
  })

  it('replaces an existing pin on re-commit (the instance moved ports)', async () => {
    const s = new PinStore()
    await s.commit('c1', P1)
    await s.commit('c1', { port: 16802, instanceId: 'inst-x' })
    expect(await s.get('c1')).toEqual({ port: 16802, instanceId: 'inst-x' })
    expect(Object.keys(persisted().pins)).toEqual(['c1'])
  })

  it('drops the storage key once the last pin is cleared', async () => {
    const s = new PinStore()
    await s.commit('c1', P1)
    await s.clear('c1')
    expect(STORAGE_KEY in backing).toBe(false)
  })

  describe('clear tolerates ids that never had a pin', () => {
    it('is a no-op on an unknown credentialId', async () => {
      const s = new PinStore()
      await expect(s.clear('never-pinned')).resolves.toBeUndefined()
      expect(browser.storage.local.set).not.toHaveBeenCalled()
      expect(browser.storage.local.remove).not.toHaveBeenCalled()
    })

    it('leaves every other pin intact', async () => {
      const s = new PinStore()
      await s.commit('c1', P1)
      await s.clear('never-pinned')
      expect(await s.get('c1')).toEqual(P1)
    })
  })

  describe('§12 post-auth prune: clearing over prunePrincipalExcept ids', () => {
    const principal = {
      browser: 'chromium',
      verifiedOrigin: 'chrome-extension://abc',
      clientInstallationId: 'inst-1',
    }

    async function commitCredential(
      creds: CredentialStore,
      credentialId: string
    ): Promise<void> {
      await creds.writeProvisionalUnacked(principal, {
        credentialId,
        mutualKey: `k-${credentialId}`,
      })
      await creds.markCommitUncertain(credentialId)
      await creds.commitAndActivate(credentialId, principal)
    }

    it('clears exactly the pruned credentials and keeps the live one', async () => {
      const creds = new CredentialStore()
      const pins = new PinStore()
      // c-old authenticated once and got a pin; c-mid never did; c-new is the
      // rotation the authenticated session just proved live.
      await commitCredential(creds, 'c-old')
      await commitCredential(creds, 'c-mid')
      await commitCredential(creds, 'c-new')
      await pins.commit('c-old', P1)
      await pins.commit('c-new', P2)

      const pruned = await creds.prunePrincipalExcept(principal, 'c-new')
      expect(new Set(pruned)).toEqual(new Set(['c-old', 'c-mid']))

      // The caller's obligation, exactly as prunePrincipalExcept's own JSDoc states it.
      for (const credentialId of pruned) await pins.clear(credentialId)

      expect(await pins.get('c-old')).toBeNull()
      expect(await pins.get('c-mid')).toBeNull()
      expect(await pins.get('c-new')).toEqual(P2)
    })

    it('leaves no orphan behind when nothing was pinned', async () => {
      const creds = new CredentialStore()
      const pins = new PinStore()
      await commitCredential(creds, 'c-old')
      await commitCredential(creds, 'c-new')
      const pruned = await creds.prunePrincipalExcept(principal, 'c-new')
      for (const credentialId of pruned) await pins.clear(credentialId)
      expect(STORAGE_KEY in backing).toBe(false)
    })
  })

  describe('unreadable persisted state', () => {
    it('ignores and preserves a future version wholesale', async () => {
      const future = {
        version: 2,
        pins: { c1: P1 },
        futureRoutingProof: 'opaque',
      }
      backing[STORAGE_KEY] = future
      expect(await new PinStore().get('c1')).toBeNull()
      expect(backing[STORAGE_KEY]).toBe(future)
      expect(browser.storage.local.set).not.toHaveBeenCalled()
      expect(browser.storage.local.remove).not.toHaveBeenCalled()
    })

    it('rejects commit without overwriting a future version', async () => {
      const future = { version: 2, pins: { c1: P1 } }
      backing[STORAGE_KEY] = future

      await expect(new PinStore().commit('c2', P2)).rejects.toBeInstanceOf(
        UnsupportedPinStoreVersionError
      )
      expect(backing[STORAGE_KEY]).toBe(future)
      expect(browser.storage.local.set).not.toHaveBeenCalled()
      expect(browser.storage.local.remove).not.toHaveBeenCalled()
    })

    it('rejects even a no-op clear without overwriting a future version', async () => {
      const future = { version: 2, pins: { c1: P1 } }
      backing[STORAGE_KEY] = future

      await expect(new PinStore().clear('never-pinned')).rejects.toBeInstanceOf(
        UnsupportedPinStoreVersionError
      )
      expect(backing[STORAGE_KEY]).toBe(future)
      expect(browser.storage.local.set).not.toHaveBeenCalled()
      expect(browser.storage.local.remove).not.toHaveBeenCalled()
    })

    it('ignores a missing version', async () => {
      backing[STORAGE_KEY] = { pins: { c1: P1 } }
      expect(await new PinStore().get('c1')).toBeNull()
    })

    it('ignores a pins field that is an array', async () => {
      backing[STORAGE_KEY] = { version: 1, pins: [P1] }
      expect(await new PinStore().get('0')).toBeNull()
    })

    it('ignores an empty credentialId key', async () => {
      backing[STORAGE_KEY] = { version: 1, pins: { '': P1, c1: P1 } }
      const s = new PinStore()
      expect(await s.get('')).toBeNull()
      expect(await s.get('c1')).toEqual(P1)
    })

    it('treats a __proto__ credentialId as data, not as a prototype', async () => {
      // §6.7 makes `credentialId` server-chosen, so a paired Motrix can offer
      // `"__proto__"`. On a normal accumulator the read path's assignment would
      // be a Set that invokes `Object.prototype`'s setter and replaces the
      // map's prototype, after which `get('port')` inherits a *number* typed as
      // `Pin` and the discovery fast path dials `undefined`.
      backing[STORAGE_KEY] = {
        version: 1,
        pins: JSON.parse('{"__proto__": {"port": 16803, "instanceId": "x"}}'),
      }
      const s = new PinStore()
      // Nothing leaks through a prototype chain...
      expect(await s.get('port')).toBeNull()
      expect(await s.get('instanceId')).toBeNull()
      // ...and the odd key is still stored and retrievable as itself.
      expect(await s.get('__proto__')).toEqual({
        port: 16803,
        instanceId: 'x',
      })
    })

    // Each case keeps every other field valid, so a passing assertion cannot
    // be explained by a different branch of the validator.
    const badPins: Array<[string, unknown]> = [
      ['port 0 (below the range)', { port: 0, instanceId: 'inst-x' }],
      ['port 65536 (above the range)', { port: 65_536, instanceId: 'inst-x' }],
      ['a fractional port', { port: 16_803.5, instanceId: 'inst-x' }],
      ['a stringified port', { port: '16803', instanceId: 'inst-x' }],
      ['a NaN port', { port: Number.NaN, instanceId: 'inst-x' }],
      ['a missing port', { instanceId: 'inst-x' }],
      ['an empty instanceId', { port: 16_803, instanceId: '' }],
      [
        'an over-long instanceId',
        { port: 16_803, instanceId: 'a'.repeat(129) },
      ],
      ['a non-string instanceId', { port: 16_803, instanceId: 7 }],
      [
        // §8: ReconnectFlow feeds a pinned instanceId straight into enc(),
        // which throws on non-ASCII input — this must be dropped here rather
        // than surfacing as a crash on reconnect.
        'a non-ASCII instanceId',
        { port: 16_803, instanceId: 'café' },
      ],
      ['a missing instanceId', { port: 16_803 }],
      ['a null pin', null],
      ['a string pin', 'inst-x:16803'],
    ]

    for (const [label, bad] of badPins) {
      it(`drops only the bad entry: ${label}`, async () => {
        backing[STORAGE_KEY] = { version: 1, pins: { good: P1, bad } }
        const s = new PinStore()
        expect(await s.get('bad')).toBeNull()
        // One corrupted pin must cost one extra sweep, not a sweep for every
        // credential the user has.
        expect(await s.get('good')).toEqual(P1)
      })
    }

    const okPins: Array<[string, Pin]> = [
      ['the lowest port', { port: 1, instanceId: 'i' }],
      ['the highest port', { port: 65_535, instanceId: 'i' }],
      [
        'an instanceId at exactly the cap',
        { port: 16_803, instanceId: 'a'.repeat(128) },
      ],
    ]

    for (const [label, ok] of okPins) {
      it(`accepts ${label}`, async () => {
        backing[STORAGE_KEY] = { version: 1, pins: { c1: ok } }
        expect(await new PinStore().get('c1')).toEqual(ok)
      })
    }
  })

  describe('serialized mutation', () => {
    it('does not lose a pin when two commits overlap', async () => {
      const s = new PinStore()
      readDelayMs = 5
      await Promise.all([s.commit('c1', P1), s.commit('c2', P2)])
      expect(await s.get('c1')).toEqual(P1)
      expect(await s.get('c2')).toEqual(P2)
    })

    it('does not resurrect a pin when a clear overlaps a commit', async () => {
      const s = new PinStore()
      await s.commit('c1', P1)
      await s.commit('c2', P2)
      readDelayMs = 5
      await Promise.all([s.clear('c1'), s.commit('c2', P1)])
      expect(await s.get('c1')).toBeNull()
      expect(await s.get('c2')).toEqual(P1)
    })

    it('keeps five overlapping commits', async () => {
      const s = new PinStore()
      readDelayMs = 2
      const ids = ['a', 'b', 'c', 'd', 'e']
      await Promise.all(
        ids.map((id, index) =>
          s.commit(id, { port: 16_802 + index, instanceId: `i-${id}` })
        )
      )
      for (const [index, id] of ids.entries()) {
        expect(await s.get(id)).toEqual({
          port: 16_802 + index,
          instanceId: `i-${id}`,
        })
      }
    })

    it('serializes accidental multiple PinStore instances', async () => {
      readDelayMs = 5
      await Promise.all([
        new PinStore().commit('c1', P1),
        new PinStore().commit('c2', P2),
      ])
      expect(await new PinStore().get('c1')).toEqual(P1)
      expect(await new PinStore().get('c2')).toEqual(P2)
    })
  })
})
