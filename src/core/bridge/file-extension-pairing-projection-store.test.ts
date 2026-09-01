import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireBridgeDataDirLock } from './bridge-data-dir-lock'
import type { ExtensionPairingProjection } from './extension-pairing-projection'
import {
  FileExtensionPairingProjectionStore,
  FileExtensionPairingProjectionStoreError,
  recoverExtensionPairingProjectionWriterLock,
} from './file-extension-pairing-projection-store'

const RECORD_A: ExtensionPairingProjection = {
  identity: {
    kind: 'extension',
    browser: 'chromium',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  identityTrust: 'official',
  authorizationEpoch: '11111111-1111-4111-8111-111111111111',
  status: 'ready',
  pairedAt: 1_700_000_000_000,
  lastActiveAt: null,
}

const RECORD_B: ExtensionPairingProjection = {
  identity: {
    kind: 'extension',
    browser: 'firefox',
    extensionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  },
  identityTrust: 'unverified',
  authorizationEpoch: '22222222-2222-4222-8222-222222222222',
  status: 'ready',
  pairedAt: 1_700_000_001_000,
  lastActiveAt: 1_700_000_002_000,
}

describe('FileExtensionPairingProjectionStore', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-pairing-projection-')
    )
    filePath = path.join(directory, 'nested', 'extension-pairings.json')
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('loads a missing document as revision zero and requires that load before save', async () => {
    const unloaded = new FileExtensionPairingProjectionStore(filePath)
    await expect(unloaded.save([RECORD_A], 0)).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )

    const store = new FileExtensionPairingProjectionStore(filePath)
    await expect(store.load()).resolves.toEqual({ revision: 0, records: [] })
    await expect(store.save([RECORD_A], 0)).resolves.toBe(1)
  })

  it('publishes a versioned document at 0600 and advances its durable revision', async () => {
    const store = new FileExtensionPairingProjectionStore(filePath)
    await store.load()

    await expect(store.save([RECORD_A], 0)).resolves.toBe(1)
    await expect(store.save([RECORD_A, RECORD_B], 1)).resolves.toBe(2)

    expect(JSON.parse(await fs.readFile(filePath, 'utf-8'))).toEqual({
      version: 1,
      revision: 2,
      records: [RECORD_A, RECORD_B],
    })
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600)
    }
    expect(await fs.readdir(path.dirname(filePath))).toEqual([
      'extension-pairings.json',
    ])
  })

  it.each([
    ['malformed', '{not-json'],
    [
      'future',
      JSON.stringify({ version: 2, revision: 7, records: [RECORD_A] }),
    ],
    [
      'unknown-field',
      JSON.stringify({
        version: 1,
        revision: 7,
        records: [RECORD_A],
        ignored: true,
      }),
    ],
  ])('preserves and fails closed on %s content', async (_name, content) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    const store = new FileExtensionPairingProjectionStore(filePath)

    await expect(store.load()).resolves.toEqual({
      revision: -1,
      records: null,
    })
    await expect(store.save([], 0)).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(content)
  })

  it('rejects an oversized input before an unbounded read and preserves it', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    await fs.writeFile(filePath, content)
    const store = new FileExtensionPairingProjectionStore(filePath)

    await expect(store.load()).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Rejected
    )
    expect((await fs.stat(filePath)).size).toBe(content.byteLength)
  })

  it('caps serialized output before creating the target', async () => {
    const store = new FileExtensionPairingProjectionStore(filePath)
    await store.load()
    const oversized = {
      ...RECORD_A,
      identity: {
        ...RECORD_A.identity,
        extensionId: 'a'.repeat(2 * 1024 * 1024),
      },
    }

    await expect(
      store.save([oversized as ExtensionPairingProjection], 0)
    ).rejects.toThrow(FileExtensionPairingProjectionStoreError.Rejected)
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a same-revision external rewrite using the loaded byte fingerprint', async () => {
    const store = new FileExtensionPairingProjectionStore(filePath)
    await store.load()
    await store.save([RECORD_A], 0)

    const external = JSON.stringify({
      version: 1,
      revision: 1,
      records: [RECORD_B],
    })
    await fs.writeFile(filePath, external, 'utf-8')

    await expect(store.save([], 1)).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(external)
  })

  it('makes the second stale writer fail CAS without losing the first write', async () => {
    const first = new FileExtensionPairingProjectionStore(filePath)
    const second = new FileExtensionPairingProjectionStore(filePath)
    await Promise.all([first.load(), second.load()])

    await expect(first.save([RECORD_A], 0)).resolves.toBe(1)
    await expect(second.save([RECORD_B], 0)).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )

    const observer = new FileExtensionPairingProjectionStore(filePath)
    await expect(observer.load()).resolves.toEqual({
      revision: 1,
      records: [RECORD_A],
    })
  })

  it('fails closed while a writer lock already exists', async () => {
    const store = new FileExtensionPairingProjectionStore(filePath)
    await store.load()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(`${filePath}.lock`, 'unknown owner', { mode: 0o600 })

    await expect(store.save([RECORD_A], 0)).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a residual writer lock on startup without consuming the target', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const content = JSON.stringify({
      version: 1,
      revision: 4,
      records: [RECORD_A],
    })
    await fs.writeFile(filePath, content, { mode: 0o600 })
    await fs.writeFile(`${filePath}.lock`, 'unknown owner', { mode: 0o600 })
    const store = new FileExtensionPairingProjectionStore(filePath)

    await expect(store.load()).rejects.toThrow(
      FileExtensionPairingProjectionStoreError.Conflict
    )
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(content)
    await expect(fs.readFile(`${filePath}.lock`, 'utf-8')).resolves.toBe(
      'unknown owner'
    )
  })

  it.runIf(process.platform !== 'win32')(
    'removes a regular crash-residual writer lock only under the data-root lock',
    async () => {
      const dataDirectory = path.dirname(filePath)
      await fs.mkdir(dataDirectory, { recursive: true })
      const dataDirLock = await acquireBridgeDataDirLock(dataDirectory)
      await fs.writeFile(`${filePath}.lock`, 'crashed writer', { mode: 0o600 })

      await recoverExtensionPairingProjectionWriterLock(filePath, dataDirLock)
      await expect(fs.lstat(`${filePath}.lock`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        new FileExtensionPairingProjectionStore(filePath).load()
      ).resolves.toEqual({ revision: 0, records: [] })

      await dataDirLock.release()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'preserves and rejects a symlinked residual writer lock',
    async () => {
      const dataDirectory = path.dirname(filePath)
      await fs.mkdir(dataDirectory, { recursive: true })
      const target = path.join(directory, 'unrelated-lock-target')
      await fs.writeFile(target, 'keep me', { mode: 0o600 })
      await fs.symlink(target, `${filePath}.lock`)
      const dataDirLock = await acquireBridgeDataDirLock(dataDirectory)

      await expect(
        recoverExtensionPairingProjectionWriterLock(filePath, dataDirLock)
      ).rejects.toThrow(FileExtensionPairingProjectionStoreError.Rejected)
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('keep me')
      expect((await fs.lstat(`${filePath}.lock`)).isSymbolicLink()).toBe(true)

      await dataDirLock.release()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'never follows a final symlink on load or save',
    async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const target = path.join(directory, 'sensitive.json')
      const original = 'do not replace'
      await fs.writeFile(target, original, 'utf-8')
      await fs.symlink(target, filePath)
      const store = new FileExtensionPairingProjectionStore(filePath)

      await expect(store.load()).rejects.toThrow(
        FileExtensionPairingProjectionStoreError.Rejected
      )
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe(original)

      await fs.unlink(filePath)
      const writer = new FileExtensionPairingProjectionStore(filePath)
      await writer.load()
      await fs.symlink(target, filePath)
      await expect(writer.save([RECORD_A], 0)).rejects.toThrow()
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe(original)
    }
  )
})
