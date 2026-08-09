import { beforeEach, describe, expect, it } from 'vitest'
import { TrustedExtensionRegistry } from './trusted-extension-registry'

const BUILTIN = [
  { id: 'ibpkjhgpbidfmbmomagmldcdlpbmchgi', browser: 'chromium' as const },
  { id: 'motrix-extension@motrix.app', browser: 'firefox' as const },
]

interface FakeStore {
  data: string | null
  read(): Promise<string | null>
  write(s: string): Promise<void>
}

function makeStore(): FakeStore {
  return {
    data: null,
    async read() {
      return this.data
    },
    async write(s) {
      this.data = s
    },
  }
}

describe('TrustedExtensionRegistry', () => {
  let store: FakeStore
  let reg: TrustedExtensionRegistry

  beforeEach(async () => {
    store = makeStore()
    reg = new TrustedExtensionRegistry(store, BUILTIN)
    await reg.load()
  })

  it('initialises with builtin entries marked source=builtin', () => {
    const list = reg.list()
    expect(list).toHaveLength(2)
    expect(list.every((e) => e.source === 'builtin')).toBe(true)
  })

  it('has(id, browser) returns true for builtin', () => {
    expect(reg.has(BUILTIN[0].id, 'chromium')).toBe(true)
  })

  it('add() accepts a valid Chrome ID', async () => {
    const ext = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await reg.add(ext, 'chromium', 'user-added', 'Test')
    expect(reg.has(ext, 'chromium')).toBe(true)
  })

  it('add() rejects an invalid Chrome ID (wrong length)', async () => {
    await expect(reg.add('short', 'chromium', 'user-added')).rejects.toThrow(
      /invalid/i
    )
  })

  it('add() rejects an invalid Firefox ID (no @ or UUID)', async () => {
    await expect(
      reg.add('plain-string', 'firefox', 'user-added')
    ).rejects.toThrow(/invalid/i)
  })

  it('remove() throws on builtin', async () => {
    await expect(reg.remove(BUILTIN[0].id, 'chromium')).rejects.toThrow(
      /builtin/i
    )
  })

  it('remove() works for user-added', async () => {
    const ext = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await reg.add(ext, 'chromium', 'user-added')
    await reg.remove(ext, 'chromium')
    expect(reg.has(ext, 'chromium')).toBe(false)
  })

  it('persists user-added across instances', async () => {
    const ext = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await reg.add(ext, 'chromium', 'user-added', 'Custom')
    const reg2 = new TrustedExtensionRegistry(store, BUILTIN)
    await reg2.load()
    expect(reg2.has(ext, 'chromium')).toBe(true)
  })

  it('listManifestIds returns merged Chrome list', () => {
    const ids = reg.listManifestIds('chromium')
    expect(ids).toContain(BUILTIN[0].id)
  })

  it('load() refuses to override a builtin via persisted key collision', async () => {
    store.data = JSON.stringify([
      {
        id: BUILTIN[0].id,
        browser: 'chromium',
        source: 'user-added',
        label: 'Impostor',
        addedAt: 1700000000000,
      },
    ])
    const reg2 = new TrustedExtensionRegistry(store, BUILTIN)
    await reg2.load()
    const entry = reg2.list().find((e) => e.id === BUILTIN[0].id)
    expect(entry?.source).toBe('builtin')
    expect(entry?.label).toBeUndefined()
  })

  it('load() drops persisted entries with invalid IDs', async () => {
    store.data = JSON.stringify([
      {
        id: 'not-a-valid-chrome-id',
        browser: 'chromium',
        source: 'user-added',
        addedAt: 1700000000000,
      },
    ])
    const reg2 = new TrustedExtensionRegistry(store, BUILTIN)
    await reg2.load()
    expect(reg2.has('not-a-valid-chrome-id', 'chromium')).toBe(false)
    expect(reg2.list()).toHaveLength(2)
  })
})
