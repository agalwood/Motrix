import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginUploadStore } from './upload-store'

let root: string
let store: PluginUploadStore

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-upload-'))
  store = new PluginUploadStore(root)
})

afterEach(async () => {
  store.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('PluginUploadStore', () => {
  it('stores an opaque reference and verifies it again on resolve', async () => {
    const bytes = Buffer.from('plugin bytes')
    const fileHash = createHash('sha256').update(bytes).digest('hex')
    const reference = await store.put(bytes, fileHash, 'test.moext')

    const resolved = await store.resolve(reference.uploadId, fileHash)
    await expect(readFile(resolved)).resolves.toEqual(bytes)
    await store.remove(reference.uploadId)
    await expect(
      store.resolve(reference.uploadId, fileHash)
    ).rejects.toMatchObject({ message: 'plugin.install.upload_not_found' })
  })

  it('computes the authoritative hash when the browser omits a claim', async () => {
    const bytes = Buffer.from('plain HTTP plugin bytes')
    const expectedHash = createHash('sha256').update(bytes).digest('hex')

    await expect(
      store.put(bytes, undefined, 'lan.moext')
    ).resolves.toMatchObject({
      fileHash: expectedHash,
    })
  })

  it('rejects a mismatched hash and a non-moext filename', async () => {
    const bytes = Buffer.from('plugin bytes')
    await expect(
      store.put(bytes, '0'.repeat(64), 'test.moext')
    ).rejects.toMatchObject({
      message: 'plugin.install.local_file_hash_mismatch',
    })
    const fileHash = createHash('sha256').update(bytes).digest('hex')
    await expect(store.put(bytes, fileHash, 'test.zip')).rejects.toMatchObject({
      message: 'plugin.install.upload_extension_invalid',
    })
  })

  it('rejects traversal-shaped upload identifiers', async () => {
    await expect(
      store.resolve('../../etc/passwd', '0'.repeat(64))
    ).rejects.toMatchObject({
      message: 'plugin.install.upload_reference_invalid',
    })
  })

  it('enforces the retained-file count under concurrent puts', async () => {
    const countLimitedStore = new PluginUploadStore(root, {
      maxCount: 1,
      maxTotalBytes: 100,
    })
    const first = Buffer.from('first plugin')
    const second = Buffer.from('second plugin')
    const results = await Promise.allSettled([
      countLimitedStore.put(
        first,
        createHash('sha256').update(first).digest('hex'),
        'first.moext'
      ),
      countLimitedStore.put(
        second,
        createHash('sha256').update(second).digest('hex'),
        'second.moext'
      ),
    ])

    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      reason: { message: 'plugin.install.upload_quota_exceeded' },
    })
    expect(await readdir(root)).toHaveLength(1)
    countLimitedStore.dispose()
  })

  it('rejects before a put would exceed the retained byte quota', async () => {
    const byteLimitedStore = new PluginUploadStore(root, {
      maxCount: 10,
      maxTotalBytes: 12,
    })
    const first = Buffer.from('12345678')
    await byteLimitedStore.put(
      first,
      createHash('sha256').update(first).digest('hex'),
      'first.moext'
    )
    const second = Buffer.from('abcdef')

    await expect(
      byteLimitedStore.put(
        second,
        createHash('sha256').update(second).digest('hex'),
        'second.moext'
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.upload_quota_exceeded',
    })
    expect(await readdir(root)).toHaveLength(1)
    byteLimitedStore.dispose()
  })

  it('removes TTL-expired uploads and makes quota available again', async () => {
    let clock = Date.now()
    const expiringStore = new PluginUploadStore(root, {
      maxCount: 1,
      maxTotalBytes: 100,
      ttlMs: 1_000,
      now: () => clock,
    })
    const first = Buffer.from('first plugin')
    const reference = await expiringStore.put(
      first,
      createHash('sha256').update(first).digest('hex'),
      'first.moext'
    )
    const firstPath = path.join(root, `${reference.uploadId}.moext`)
    const expiredAt = new Date(clock - 1_001)
    await utimes(firstPath, expiredAt, expiredAt)

    expect(await expiringStore.cleanupExpired()).toBe(1)
    await expect(
      expiringStore.resolve(reference.uploadId, reference.fileHash)
    ).rejects.toMatchObject({ message: 'plugin.install.upload_not_found' })

    clock += 1
    const second = Buffer.from('second plugin')
    await expect(
      expiringStore.put(
        second,
        createHash('sha256').update(second).digest('hex'),
        'second.moext'
      )
    ).resolves.toMatchObject({
      fileHash: createHash('sha256').update(second).digest('hex'),
    })
    expiringStore.dispose()
  })

  it('clears its scheduled cleanup timer on dispose', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now())
      const disposableStore = new PluginUploadStore(root, { ttlMs: 1_000 })
      const bytes = Buffer.from('plugin bytes')
      await disposableStore.put(
        bytes,
        createHash('sha256').update(bytes).digest('hex'),
        'plugin.moext'
      )
      expect(vi.getTimerCount()).toBe(1)
      disposableStore.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
