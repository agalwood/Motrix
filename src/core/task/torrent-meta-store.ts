import fs from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface TorrentMetaStore {
  persist(taskId: string, bytes: Uint8Array): Promise<string>
  read(metaPath: string): Promise<Uint8Array>
  remove(metaPath: string): Promise<void>
}

export class TorrentMetaStoreImpl implements TorrentMetaStore {
  constructor(private readonly baseDir: string) {}

  async persist(taskId: string, bytes: Uint8Array): Promise<string> {
    await fs.mkdir(this.baseDir, { recursive: true })
    const filePath = path.join(this.baseDir, `${taskId}.torrent`)
    // Atomic: a half-written .torrent file would fail bencode parse
    // on next launch's reseed path, marking the BT task as
    // unrecoverable. The file is small (a few KB at most) so the
    // tmp+fsync+rename overhead is negligible. write-file-atomic's
    // signature wants Buffer | string; wrap the Uint8Array with
    // Buffer.from (zero-copy: shares the underlying ArrayBuffer).
    await writeFileAtomic(filePath, Buffer.from(bytes))
    return filePath
  }

  async read(metaPath: string): Promise<Uint8Array> {
    const buf = await fs.readFile(metaPath)
    return new Uint8Array(buf)
  }

  async remove(metaPath: string): Promise<void> {
    try {
      await fs.unlink(metaPath)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw err
    }
  }
}
