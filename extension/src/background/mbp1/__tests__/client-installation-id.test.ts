import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getClientInstallationId } from '@/background/mbp1/client-installation-id'
import { principalKey } from '@/background/mbp1/credential-store'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const STORAGE_KEY = 'motrix.mbp1.clientInstallationId'

let backing: Record<string, unknown> = {}
/** Every mocked `get` awaits a macrotask, so an unserialized implementation
 * provably interleaves rather than depending on microtask counting. */
let readDelayMs = 0

const uuids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]

beforeEach(() => {
  backing = {}
  readDelayMs = 0
  let next = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    const value = uuids[next] ?? `fallback-${next}`
    next += 1
    return value as `${string}-${string}-${string}-${string}-${string}`
  })
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    // Snapshot at call time, deliver after the delay -- a real storage read
    // captures the value when it runs, not when it resolves. Delaying *before*
    // the snapshot silently closes the read-modify-write window these tests
    // exist to hold open, and a hoisted-read mutation then passes.
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

afterEach(() => {
  vi.restoreAllMocks()
})

function persisted(): Record<string, unknown> | undefined {
  return backing[STORAGE_KEY] as Record<string, unknown> | undefined
}

function setCallCount(): number {
  return (
    browser.storage.local.set as unknown as { mock: { calls: unknown[] } }
  ).mock.calls.length
}

describe('getClientInstallationId', () => {
  it('generates and persists a versioned id on first use', async () => {
    const id = await getClientInstallationId()
    expect(id).toBe(uuids[0])
    expect(persisted()).toEqual({ version: 1, clientInstallationId: uuids[0] })
  })

  it('never regenerates while a usable id is present', async () => {
    const first = await getClientInstallationId()
    const second = await getClientInstallationId()
    expect(second).toBe(first)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(setCallCount()).toBe(1)
  })

  it('survives a service-worker restart (no in-memory cache)', async () => {
    const first = await getClientInstallationId()
    // Reset module state the way a service-worker teardown would: fresh
    // module instance, same storage. If an in-memory cache were doing the
    // work above, this would regenerate.
    vi.resetModules()
    const fresh = await import('@/background/mbp1/client-installation-id')
    const second = await fresh.getClientInstallationId()
    expect(second).toBe(first)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('is usable as a Principal field (ASCII, so principalKey accepts it)', async () => {
    const id = await getClientInstallationId()
    expect(() =>
      principalKey({
        browser: 'chromium',
        verifiedOrigin: 'chrome-extension://abc',
        clientInstallationId: id,
      })
    ).not.toThrow()
  })

  describe('first-write-wins under concurrency', () => {
    it('two overlapping calls return one id and write once', async () => {
      readDelayMs = 5
      const [a, b] = await Promise.all([
        getClientInstallationId(),
        getClientInstallationId(),
      ])
      expect(a).toBe(b)
      // The whole point: the id the caller holds is the one in storage.
      expect(persisted()).toEqual({ version: 1, clientInstallationId: a })
      expect(setCallCount()).toBe(1)
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
    })

    it('five overlapping calls return one id and write once', async () => {
      readDelayMs = 2
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => getClientInstallationId())
      )
      expect(new Set(ids).size).toBe(1)
      expect(setCallCount()).toBe(1)
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
    })

    it('returns the id storage actually holds after a foreign write', async () => {
      // Models a second JS realm (an options page driving pairing directly)
      // winning the write. `storage.local` has no compare-and-swap, so the one
      // thing this module can still guarantee is that the id it hands back is
      // the id storage held when the critical section ended -- never one that
      // was already overwritten, which is what orphans a credential.
      const foreign = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      const inner = browser.storage.local.set
      browser.storage.local.set = vi.fn(
        async (items: Record<string, unknown>) => {
          await inner(items)
          backing[STORAGE_KEY] = { version: 1, clientInstallationId: foreign }
        }
      )
      expect(await getClientInstallationId()).toBe(foreign)
    })

    it('falls back to the generated id when the write silently drops', async () => {
      browser.storage.local.set = vi.fn(async () => undefined)
      expect(await getClientInstallationId()).toBe(uuids[0])
    })

    it('a later caller joining mid-write still sees the winning id', async () => {
      readDelayMs = 5
      const first = getClientInstallationId()
      await new Promise((resolve) => setTimeout(resolve, 1))
      const second = getClientInstallationId()
      expect(await second).toBe(await first)
      expect(setCallCount()).toBe(1)
    })
  })

  describe('unusable persisted records are replaced', () => {
    // Each case isolates exactly one validator branch: every other field is
    // valid, so a passing test cannot be explained by a different check.
    const cases: Array<[string, unknown]> = [
      ['a future version', { version: 2, clientInstallationId: 'abc' }],
      ['a missing version', { clientInstallationId: 'abc' }],
      ['a non-string id', { version: 1, clientInstallationId: 42 }],
      ['an empty id', { version: 1, clientInstallationId: '' }],
      // Pure ASCII, version 1, non-empty: fails only the length cap (129).
      [
        'an over-long id',
        { version: 1, clientInstallationId: 'a'.repeat(129) },
      ],
      // Version 1, length 2, non-empty, under the cap: fails only the
      // ">= 0x80" half of the character check.
      ['a non-ASCII id', { version: 1, clientInstallationId: 'ää' }],
      // Version 1, length 3, every byte < 0x80: fails only the "< 0x21" half.
      ['a control character', { version: 1, clientInstallationId: 'a\u0000b' }],
      ['an embedded space', { version: 1, clientInstallationId: 'a b' }],
      ['a bare string record', 'not-an-object'],
      ['a null record', null],
      ['an array record', []],
    ]

    for (const [label, stored] of cases) {
      it(`regenerates over ${label}`, async () => {
        backing[STORAGE_KEY] = stored
        const id = await getClientInstallationId()
        expect(id).toBe(uuids[0])
        expect(persisted()).toEqual({
          version: 1,
          clientInstallationId: uuids[0],
        })
      })
    }

    it('accepts a boundary-length id at exactly 128 characters', async () => {
      const long = 'a'.repeat(128)
      backing[STORAGE_KEY] = { version: 1, clientInstallationId: long }
      expect(await getClientInstallationId()).toBe(long)
      expect(crypto.randomUUID).not.toHaveBeenCalled()
    })

    it('accepts the printable-ASCII boundary characters', async () => {
      const edges = '!~'
      backing[STORAGE_KEY] = { version: 1, clientInstallationId: edges }
      expect(await getClientInstallationId()).toBe(edges)
      expect(crypto.randomUUID).not.toHaveBeenCalled()
    })
  })
})
