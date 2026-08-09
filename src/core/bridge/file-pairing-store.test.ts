import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilePairingStore } from './file-pairing-store'
import type { PairedClient } from './pairing-service'

describe('FilePairingStore', () => {
  let tmpDir: string
  let filePath: string
  let store: FilePairingStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pairing-store-'))
    filePath = path.join(tmpDir, 'pairing.json')
    store = new FilePairingStore(filePath)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when file does not exist', async () => {
    expect(await store.load()).toEqual([])
  })

  it('round-trips save and load', async () => {
    const list: PairedClient[] = [
      {
        identity: {
          kind: 'extension',
          browser: 'chromium',
          extensionId: 'ext-a',
        },
        token: 'tok-a',
        name: 'Ext A',
        pairedAt: 1000,
        lastActiveAt: 2000,
      },
      {
        identity: { kind: 'cli', id: 'agent-1' },
        token: 'tok-b',
        name: 'Agent',
        pairedAt: 1500,
        lastActiveAt: null,
      },
    ]
    await store.save(list)
    expect(await store.load()).toEqual(list)
  })

  it('writes pairing.json owner-only (0600) — it holds bearer tokens', async () => {
    await store.save([
      {
        identity: { kind: 'cli', id: 'agent-1' },
        token: 'secret-agent-token',
        name: 'Agent',
        pairedAt: 1,
        lastActiveAt: null,
      },
    ])
    const st = await fs.stat(filePath)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('re-applies 0600 when overwriting a pre-existing looser file', async () => {
    await fs.writeFile(filePath, '[]', { mode: 0o644 })
    await store.save([])
    const st = await fs.stat(filePath)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('returns empty array on corrupt JSON', async () => {
    await fs.writeFile(filePath, 'not json{', 'utf-8')
    expect(await store.load()).toEqual([])
  })

  it('creates parent directory on save', async () => {
    const nested = new FilePairingStore(
      path.join(tmpDir, 'sub', 'pairing.json')
    )
    await nested.save([])
    expect(await nested.load()).toEqual([])
  })

  it('migrates a legacy flat extension record forward to PairedClient', async () => {
    // A pre-7a pairing.json: flat `{ extensionId, browser, token, ... }` with
    // no `identity` wrapper. The user must NOT have to re-pair after upgrade.
    const legacy = [
      {
        extensionId: 'legacy-ext',
        browser: 'firefox',
        token: 'legacy-tok',
        name: 'Legacy Ext',
        pairedAt: 1000,
        lastActiveAt: 2000,
      },
    ]
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8')

    const loaded = await store.load()
    expect(loaded).toEqual([
      {
        identity: {
          kind: 'extension',
          browser: 'firefox',
          extensionId: 'legacy-ext',
        },
        token: 'legacy-tok',
        name: 'Legacy Ext',
        pairedAt: 1000,
        lastActiveAt: 2000,
      },
    ])
  })

  it('drops records with no token (corrupt/partial)', async () => {
    const mixed = [
      { extensionId: 'no-token', browser: 'chromium', name: 'X' },
      {
        extensionId: 'ok',
        browser: 'chromium',
        token: 'tok-ok',
        name: 'OK',
        pairedAt: 1,
        lastActiveAt: null,
      },
    ]
    await fs.writeFile(filePath, JSON.stringify(mixed), 'utf-8')

    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].token).toBe('tok-ok')
  })

  it('drops new-shape records with a malformed identity', async () => {
    // pairing.json is untrusted input: a partial/corrupt new-shape record must
    // never load as a malformed PairedClient.
    const corrupt = [
      { identity: { kind: 'extension', browser: 'chromium' }, token: 'a' }, // no extensionId
      { identity: { kind: 'cli' }, token: 'b' }, // no id
      { identity: { kind: 'whoops', id: 'x' }, token: 'c' }, // unknown kind
      { identity: ['chromium', 'ext'], token: 'd' }, // array, not an object record
      {
        identity: { kind: 'cli', id: 'good' },
        token: 'e',
        name: 'Agent',
        pairedAt: 1,
        lastActiveAt: null,
      },
    ]
    await fs.writeFile(filePath, JSON.stringify(corrupt), 'utf-8')

    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].token).toBe('e')
    expect(loaded[0].identity).toEqual({ kind: 'cli', id: 'good' })
  })

  it('defaults missing name/pairedAt/lastActiveAt on a legacy record', async () => {
    const legacy = [
      { extensionId: 'bare', browser: 'chromium', token: 'tok-bare' },
    ]
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8')

    const [rec] = await store.load()
    expect(rec.identity).toEqual({
      kind: 'extension',
      browser: 'chromium',
      extensionId: 'bare',
    })
    expect(rec.name).toBe('')
    expect(rec.lastActiveAt).toBeNull()
    expect(typeof rec.pairedAt).toBe('number')
  })
})
