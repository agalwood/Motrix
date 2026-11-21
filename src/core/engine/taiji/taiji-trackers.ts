import { BDictionary, decode } from '@motrix/torrent'
import { AppError, ErrorCode } from '@shared/errors'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import { isNotFoundError } from '../aria2/error-utils'
import type { TaijiRpcClient } from './taiji-rpc-client'

/** Native tracker edits operate on the full tier list. Protect metainfo tiers. */
export class TaijiTrackers {
  private originals = new Map<string, Promise<Set<string>>>()
  constructor(private readonly rpc: TaijiRpcClient) {}

  clear(): void {
    this.originals.clear()
  }

  private original(gid: string): Promise<Set<string>> {
    const cached = this.originals.get(gid)
    if (cached) return cached
    // Cache only URLs, never the metadata blob or its potentially large file tree.
    const pending = this.rpc.getTorrentMetadata(gid).then(({ data }) => {
      const { value } = decode(Buffer.from(data, 'base64'), {
        maxBytes: MAX_TORRENT_FILE_SIZE,
        allowUnsortedKeys: true,
      })
      if (!(value instanceof BDictionary))
        throw new AppError(
          ErrorCode.EngineProtocolError,
          'Invalid torrent metadata'
        )
      const urls = new Set<string>()
      const add = (entry: unknown) => {
        if (entry instanceof Uint8Array)
          urls.add(new TextDecoder().decode(entry))
      }
      add(value.get('announce'))
      const tiers = value.get('announce-list')
      if (Array.isArray(tiers))
        for (const tier of tiers) if (Array.isArray(tier)) tier.forEach(add)
      return urls
    })
    this.originals.set(gid, pending)
    if (this.originals.size > 128) {
      const first = this.originals.keys().next().value
      if (first) this.originals.delete(first)
    }
    void pending.catch(() => {
      if (this.originals.get(gid) === pending) this.originals.delete(gid)
    })
    return pending
  }

  private async all(gid: string): Promise<string[]> {
    const status = await this.rpc.tellStatus(gid, ['status', 'bittorrent'])
    if (['complete', 'error', 'removed'].includes(status.status)) return []
    return [...new Set(status.bittorrent?.announceList.flat() ?? [])]
  }

  async read(gid: string): Promise<string[]> {
    let all: string[]
    try {
      all = await this.all(gid)
    } catch (error) {
      if (isNotFoundError(error)) return []
      throw error
    }
    if (!all.length) return []
    const original = await this.original(gid)
    return all.filter((url) => !original.has(url))
  }

  async add(gid: string, urls: readonly string[]): Promise<void> {
    if (!urls.length) return
    await this.rpc.addTrackers(gid, urls)
    const actual = new Set(await this.all(gid))
    if (urls.some((url) => !actual.has(url)))
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Tracker update was not applied'
      )
  }

  async replace(gid: string, urls: readonly string[]): Promise<void> {
    const current = await this.read(gid)
    const original = await this.original(gid)
    const next = [...new Set(urls)].filter((url) => !original.has(url))
    await this.add(
      gid,
      next.filter((url) => !current.includes(url))
    )
    const removed = current.filter((url) => !next.includes(url))
    if (removed.length) await this.rpc.removeTrackers(gid, removed)
    const actual = await this.read(gid)
    if (
      actual.length !== next.length ||
      actual.some((url) => !next.includes(url))
    )
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Tracker update was not applied'
      )
  }
}
