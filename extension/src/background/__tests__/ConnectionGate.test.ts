import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionGate } from '@/background/ConnectionGate'
import {
  backendAuthorityKey,
  createRemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

let backing: Record<string, unknown>

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

function remote(id: string, host: string): ConnectionGate {
  return ConnectionGate.forAuthority(
    createRemoteBackendAuthority({ endpointId: id, wsBase: `wss://${host}` })
  )
}

describe('ConnectionGate', () => {
  it('defaults to open when nothing is stored', async () => {
    const gate = new ConnectionGate()
    expect(await gate.shouldAutoConnect()).toBe(true)
    expect((await gate.get()).reason).toBeNull()
  })

  it('pausePending blocks shouldAutoConnect within TTL', async () => {
    const gate = new ConnectionGate()
    await gate.pausePending(60_000)
    expect(await gate.shouldAutoConnect()).toBe(false)
    const state = await gate.get()
    expect(state.reason).toBe('pair-pending')
    expect(state.pausedUntil).toBeGreaterThan(Date.now())
  })

  it('pausePending TTL expires — gate re-opens', async () => {
    const gate = new ConnectionGate()
    await gate.pausePending(-1)
    expect(await gate.shouldAutoConnect()).toBe(true)
  })

  it('rejects a non-finite pending TTL', async () => {
    const gate = new ConnectionGate()
    await expect(gate.pausePending(Number.POSITIVE_INFINITY)).rejects.toThrow(
      'TTL must be finite'
    )
    expect(await gate.shouldAutoConnect()).toBe(true)
  })

  it('pauseDenied blocks until explicit clear()', async () => {
    const gate = new ConnectionGate()
    await gate.pauseDenied('user denied')
    expect(await gate.shouldAutoConnect()).toBe(false)
    const state = await gate.get()
    expect(state.reason).toBe('denied')
    expect(state.lastError).toBe('user denied')
    expect(state.pausedUntil).toBe(Number.POSITIVE_INFINITY)
  })

  it('clear() releases only the selected authority', async () => {
    const local = new ConnectionGate()
    const serverA = remote('a', 'a.example')
    const serverB = remote('b', 'b.example')
    await Promise.all([
      local.pauseDenied('local denied'),
      serverA.pauseDenied('A denied'),
      serverB.pausePending(60_000),
    ])

    await serverA.clear()

    expect(await local.shouldAutoConnect()).toBe(false)
    expect(await serverA.shouldAutoConnect()).toBe(true)
    expect(await serverB.shouldAutoConnect()).toBe(false)
    expect((await local.get()).lastError).toBe('local denied')
  })

  it('serializes writes from separate gate instances without losing a scope', async () => {
    const serverA = remote('a', 'a.example')
    const serverB = remote('b', 'b.example')
    await Promise.all([
      serverA.pauseDenied('A denied'),
      serverB.pauseDenied('B denied'),
    ])

    expect((await serverA.get()).lastError).toBe('A denied')
    expect((await serverB.get()).lastError).toBe('B denied')
    const stored = backing['motrix.connectionGate'] as {
      version: number
      states: unknown[]
    }
    expect(stored.version).toBe(2)
    expect(stored.states).toHaveLength(2)
  })

  it('a URL change creates a distinct gate scope', async () => {
    const oldUrl = remote('server', 'old.example')
    const newUrl = remote('server', 'new.example')
    await oldUrl.pauseDenied('old denied')

    expect(await oldUrl.shouldAutoConnect()).toBe(false)
    expect(await newUrl.shouldAutoConnect()).toBe(true)
  })

  it.each([undefined, null, {}, { kind: 'local' }])(
    'rejects an explicitly invalid authority instead of falling back to local: %j',
    (authority) => {
      expect(() =>
        ConnectionGate.forAuthority(
          authority as Parameters<typeof ConnectionGate.forAuthority>[0]
        )
      ).toThrow('must be created by its module factory')
    }
  )

  it('rejects explicit undefined through the constructor as well', () => {
    expect(() => new ConnectionGate(undefined as never)).toThrow(
      'must be created by its module factory'
    )
  })

  it('migrates the unversioned gate into local only', async () => {
    backing['motrix.connectionGate'] = {
      reason: 'denied',
      pausedUntil: Number.POSITIVE_INFINITY,
      lastError: 'legacy local denial',
    }
    const local = new ConnectionGate()
    const server = remote('server', 'server.example')

    expect(await local.shouldAutoConnect()).toBe(false)
    expect(await server.shouldAutoConnect()).toBe(true)
    expect(
      (backing['motrix.connectionGate'] as { version: number }).version
    ).toBe(2)
  })

  it('keeps a legacy denial local when a remote gate triggers migration first', async () => {
    backing['motrix.connectionGate'] = {
      reason: 'denied',
      pausedUntil: Number.POSITIVE_INFINITY,
      lastError: 'legacy local denial',
    }
    const local = new ConnectionGate()
    const server = remote('server', 'server.example')

    expect(await server.shouldAutoConnect()).toBe(true)
    expect(await local.shouldAutoConnect()).toBe(false)
    expect((await local.get()).lastError).toBe('legacy local denial')
  })

  it('orders concurrent clear and replace operations without lost updates', async () => {
    const server = remote('server', 'server.example')
    await server.pauseDenied('old denial')

    await Promise.all([server.clear(), server.pauseDenied('new denial')])
    expect((await server.get()).lastError).toBe('new denial')

    await Promise.all([server.pauseDenied('last denial'), server.clear()])
    expect(await server.shouldAutoConnect()).toBe(true)
  })

  it('keeps the shared queue usable after a storage write rejection', async () => {
    const serverA = remote('a', 'a.example')
    const serverB = remote('b', 'b.example')
    const persistentSet = browser.storage.local.set
    browser.storage.local.set = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(persistentSet)

    await expect(serverA.pauseDenied('A denied')).rejects.toThrow(
      'storage unavailable'
    )
    await expect(serverB.pauseDenied('B denied')).resolves.toBeUndefined()
    expect(await serverA.shouldAutoConnect()).toBe(true)
    expect((await serverB.get()).lastError).toBe('B denied')
  })

  it('fails closed and preserves an unknown future version', async () => {
    const future = { version: 99, opaque: { keep: true } }
    backing['motrix.connectionGate'] = future
    const server = remote('server', 'server.example')

    expect(await server.shouldAutoConnect()).toBe(false)
    expect((await server.get()).lastError).toBe(
      'connection gate version is unsupported'
    )
    await expect(server.clear()).rejects.toThrow('version is unsupported')
    await expect(server.pauseDenied('replace')).rejects.toThrow(
      'version is unsupported'
    )
    expect(backing['motrix.connectionGate']).toEqual(future)
  })

  it('fails closed for a duplicate or malformed row in the selected authority only', async () => {
    const authorityA = createRemoteBackendAuthority({
      endpointId: 'a',
      wsBase: 'wss://a.example',
    })
    const authorityB = createRemoteBackendAuthority({
      endpointId: 'b',
      wsBase: 'wss://b.example',
    })
    const keyA = backendAuthorityKey(authorityA)
    backing['motrix.connectionGate'] = {
      version: 2,
      states: [
        {
          authorityKey: keyA,
          reason: 'pair-pending',
          pausedUntil: Date.now() - 1,
          lastError: null,
        },
        { authorityKey: keyA, reason: 'corrupted' },
      ],
    }

    const serverA = ConnectionGate.forAuthority(authorityA)
    const serverB = ConnectionGate.forAuthority(authorityB)
    expect(await serverA.shouldAutoConnect()).toBe(false)
    expect((await serverA.get()).lastError).toMatch(/ambiguous|malformed/)
    expect(await serverB.shouldAutoConnect()).toBe(true)
  })

  it.each([
    ['missing states', { version: 2 }],
    ['object states', { version: 2, states: {} }],
    ['null states', { version: 2, states: null }],
    ['unscopable row', { version: 2, states: [{ reason: 'denied' }] }],
  ])(
    'fails every scope closed and preserves corrupt v2 %s',
    async (_label, value) => {
      backing['motrix.connectionGate'] = value
      const local = new ConnectionGate()
      const server = remote('server', 'server.example')

      expect(await local.shouldAutoConnect()).toBe(false)
      expect(await server.shouldAutoConnect()).toBe(false)
      expect((await server.get()).lastError).toBe(
        'connection gate state is corrupt'
      )
      await expect(server.pauseDenied('replace')).rejects.toThrow(
        'state is corrupt'
      )
      await expect(local.clear()).rejects.toThrow('state is corrupt')
      expect(backing['motrix.connectionGate']).toEqual(value)
    }
  )

  it('falls back to open when an unversioned value is malformed', async () => {
    const gate = new ConnectionGate()
    backing['motrix.connectionGate'] = { reason: 'garbage' }
    expect(await gate.shouldAutoConnect()).toBe(true)
  })

  it('caps persisted error text and never copies it across authorities', async () => {
    const serverA = remote('a', 'a.example')
    const serverB = remote('b', 'b.example')
    await serverA.pauseDenied('x'.repeat(2_000))

    expect((await serverA.get()).lastError).toHaveLength(512)
    expect((await serverB.get()).lastError).toBeNull()
  })
})
