import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginUploadStore } from './upload-store'

let root: string
let store: PluginUploadStore

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'motrix-plugin-upload-'))
  store = new PluginUploadStore(root)
})

afterEach(async () => {
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
})
