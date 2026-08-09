import type { ClientIdentity } from '@shared/protocol/bridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PairedClient,
  PairingService,
  type PairingStore,
} from './pairing-service'

function ext(
  extensionId: string,
  browser: 'chromium' | 'firefox'
): ClientIdentity {
  return { kind: 'extension', browser, extensionId }
}

function makeFakeStore(): PairingStore {
  let list: PairedClient[] = []
  return {
    async load() {
      return [...list]
    },
    async save(next) {
      list = [...next]
    },
  }
}

describe('PairingService', () => {
  let store: PairingStore
  let svc: PairingService

  beforeEach(async () => {
    store = makeFakeStore()
    svc = new PairingService(store)
    await svc.load()
  })

  it('issueToken stores and returns a 256-bit base64url token', async () => {
    const { token } = await svc.issueToken(
      ext('ext-id-1', 'chromium'),
      'Ext One'
    )
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('issueToken persists the client name', async () => {
    await svc.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')
    const [info] = svc.listPaired()
    expect(info.name).toBe('Ext One')
  })

  it('findByToken returns the issued pair', async () => {
    const { token } = await svc.issueToken(
      ext('ext-id-1', 'chromium'),
      'Ext One'
    )
    expect(svc.findByToken(token)?.identity).toMatchObject({
      kind: 'extension',
      extensionId: 'ext-id-1',
      browser: 'chromium',
    })
  })

  it('revoke removes the token', async () => {
    const { token } = await svc.issueToken(
      ext('ext-id-1', 'chromium'),
      'Ext One'
    )
    await svc.revoke(ext('ext-id-1', 'chromium'), 'user-revoked')
    expect(svc.findByToken(token)).toBeNull()
  })

  it('reissue rotates the token', async () => {
    const a = await svc.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')
    const b = await svc.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')
    expect(b.token).not.toEqual(a.token)
    expect(svc.findByToken(a.token)).toBeNull()
    expect(svc.findByToken(b.token)?.identity).toMatchObject({
      extensionId: 'ext-id-1',
    })
  })

  it('listPaired returns all issued tokens', async () => {
    await svc.issueToken(ext('ext-a', 'chromium'), 'A')
    await svc.issueToken(ext('ext-b', 'firefox'), 'B')
    expect(svc.listPaired()).toHaveLength(2)
  })

  it('issues independent tokens for cli and extension identities', async () => {
    await svc.issueToken(ext('ext-a', 'chromium'), 'A')
    const cli = await svc.issueToken({ kind: 'cli', id: 'agent-1' }, 'Agent')
    expect(svc.listPaired()).toHaveLength(2)
    expect(svc.findByToken(cli.token)?.identity).toEqual({
      kind: 'cli',
      id: 'agent-1',
    })
  })

  it('persists across instances via the store', async () => {
    const { token } = await svc.issueToken(
      ext('ext-id-1', 'chromium'),
      'Ext One'
    )
    const svc2 = new PairingService(store)
    await svc2.load()
    expect(svc2.findByToken(token)?.identity).toMatchObject({
      extensionId: 'ext-id-1',
    })
  })

  it('markActive updates lastActiveAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    await svc.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')
    vi.setSystemTime(5000)
    svc.markActive(ext('ext-id-1', 'chromium'))
    const [info] = svc.listPaired()
    expect(info.lastActiveAt).toBe(5000)
    vi.useRealTimers()
  })

  it('stopAndDrain waits for accepted markActive persistence and gates later writes', async () => {
    let saveCalls = 0
    let releaseActiveSave!: () => void
    const activeSaveBlocked = new Promise<void>((resolve) => {
      releaseActiveSave = resolve
    })
    const deferredStore: PairingStore = {
      load: async () => [],
      save: async () => {
        saveCalls += 1
        if (saveCalls === 2) await activeSaveBlocked
      },
    }
    const draining = new PairingService(deferredStore)
    await draining.load()

    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      await draining.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')
      vi.setSystemTime(61_001)
      draining.markActive(ext('ext-id-1', 'chromium'))
      await Promise.resolve()
      expect(saveCalls).toBe(2)

      let drained = false
      const drain = draining.stopAndDrain().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)

      releaseActiveSave()
      await drain
      expect(drained).toBe(true)

      vi.setSystemTime(122_002)
      draining.markActive(ext('ext-id-1', 'chromium'))
      await Promise.resolve()
      expect(saveCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes markActive persistence ahead of revoke so a stale save cannot resurrect the client', async () => {
    let saveCalls = 0
    let persisted: PairedClient[] = []
    let releaseActiveSave!: () => void
    const activeSaveBlocked = new Promise<void>((resolve) => {
      releaseActiveSave = resolve
    })
    const deferredStore: PairingStore = {
      load: async () => [],
      save: async (next) => {
        saveCalls += 1
        if (saveCalls === 2) await activeSaveBlocked
        persisted = structuredClone(next)
      },
    }
    const serialized = new PairingService(deferredStore)
    await serialized.load()
    await serialized.issueToken(ext('ext-id-1', 'chromium'), 'Ext One')

    serialized.markActive(ext('ext-id-1', 'chromium'))
    await Promise.resolve()
    expect(saveCalls).toBe(2)

    const revoke = serialized.revoke(
      ext('ext-id-1', 'chromium'),
      'user-revoked'
    )
    await Promise.resolve()
    expect(saveCalls).toBe(2)

    releaseActiveSave()
    await revoke
    expect(saveCalls).toBe(3)
    expect(persisted).toEqual([])
  })

  it('leaves in-memory state untouched when issueToken persist fails', async () => {
    const failing: PairingStore = {
      load: async () => [],
      save: async () => {
        throw new Error('disk full')
      },
    }
    const failSvc = new PairingService(failing)
    await failSvc.load()
    await expect(
      failSvc.issueToken(ext('ext-x', 'chromium'), 'X')
    ).rejects.toThrow('disk full')
    expect(failSvc.listPaired()).toHaveLength(0)
  })

  it('keeps the entry when revoke persist fails', async () => {
    let calls = 0
    const flaky: PairingStore = {
      load: async () => [],
      save: async () => {
        calls++
        if (calls >= 2) throw new Error('locked')
      },
    }
    const svc2 = new PairingService(flaky)
    await svc2.load()
    const { token } = await svc2.issueToken(
      ext('ext-id-1', 'chromium'),
      'Ext One'
    )
    await expect(
      svc2.revoke(ext('ext-id-1', 'chromium'), 'user-revoked')
    ).rejects.toThrow('locked')
    expect(svc2.findByToken(token)?.identity).toMatchObject({
      extensionId: 'ext-id-1',
    })
  })
})

describe('PairingService revoke event', () => {
  it('emits revoked event with identity and reason', async () => {
    const store = makeFakeStore()
    const pairing = new PairingService(store)
    await pairing.load()
    await pairing.issueToken(ext('abc', 'chromium'), 'Abc')

    const events: Array<{ identity: ClientIdentity; reason: string }> = []
    pairing.on('revoked', (e) => events.push(e))

    await pairing.revoke(ext('abc', 'chromium'), 'user-clicked-revoke')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      identity: { kind: 'extension', extensionId: 'abc', browser: 'chromium' },
      reason: 'user-clicked-revoke',
    })
  })

  it('does NOT emit when revoking a non-paired client', async () => {
    const store = makeFakeStore()
    const pairing = new PairingService(store)
    await pairing.load()

    const events: unknown[] = []
    pairing.on('revoked', () => events.push({}))

    await pairing.revoke(ext('never-paired', 'chromium'), 'irrelevant')

    expect(events).toHaveLength(0)
  })
})

describe('PairingService rotated event', () => {
  it('emits rotated with the identity when an existing identity re-pairs', async () => {
    const store = makeFakeStore()
    const pairing = new PairingService(store)
    await pairing.load()
    await pairing.issueToken({ kind: 'cli', id: 'agent-1' }, 'Agent')

    const events: Array<{ identity: ClientIdentity }> = []
    pairing.on('rotated', (e) => events.push(e))

    await pairing.issueToken({ kind: 'cli', id: 'agent-1' }, 'Agent')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      identity: { kind: 'cli', id: 'agent-1' },
    })
  })

  it('does NOT emit rotated for a first-time identity', async () => {
    const store = makeFakeStore()
    const pairing = new PairingService(store)
    await pairing.load()

    const events: unknown[] = []
    pairing.on('rotated', () => events.push({}))

    await pairing.issueToken({ kind: 'cli', id: 'fresh-agent' }, 'Fresh')

    expect(events).toHaveLength(0)
  })
})
