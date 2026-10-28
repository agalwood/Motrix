import { getLogger } from '@core/logger'
import type { Aria2RpcClient } from './aria2-rpc-client'
import { extractUris } from './translate'
import type {
  Aria2FileMetadata,
  Aria2PolledStatus,
  Aria2RawFile,
  Aria2RawStatus,
} from './types'

const log = getLogger('task-file-metadata')
// Also reconcile edits made by another RPC client, which cannot invalidate our
// local cache. Failed reads retry separately from this successful-read TTL.
const REFRESH_INTERVAL_MS = 60_000
const RETRY_INTERVAL_MS = 1_000

type ListStatus = Omit<Aria2RawStatus, 'files'> & { files?: Aria2RawFile[] }

interface Entry {
  fingerprint: string
  identity: string
  lastSeenAt: number
  metadata?: Aria2FileMetadata
  refreshAt: number
  loading?: Promise<void>
}

function project(files: Aria2RawFile[]): Aria2FileMetadata {
  const first = files[0]
  return {
    firstFile: first ? { path: first.path, uris: first.uris } : undefined,
    fileCount: files.length,
    uris: extractUris({ files } as Aria2RawStatus),
    selectedFiles: files
      .filter((file) => file.selected === 'true')
      .map((file) => Number(file.index) - 1),
  }
}

/** Shared by desktop and server; coalesces reads for one metadata generation. */
export class TaskFileMetadata {
  private entries = new Map<string, Entry>()

  constructor(private rpc: Pick<Aria2RpcClient, 'getFiles'>) {}

  invalidate(gid?: string): void {
    if (gid === undefined) this.entries.clear()
    else this.entries.delete(gid)
  }

  retain(gids: ReadonlySet<string>): void {
    for (const [gid, entry] of this.entries) {
      // Keep a short grace period for a terminal notification whose tellStatus
      // is still in flight when the task disappears from active/waiting. Its
      // later getFiles may race eviction, so it still needs last-known identity.
      if (
        !gids.has(gid) &&
        !entry.loading &&
        Date.now() - entry.lastSeenAt > REFRESH_INTERVAL_MS
      )
        this.entries.delete(gid)
    }
  }

  async hydrate(raw: ListStatus): Promise<Aria2PolledStatus | null> {
    const identity = JSON.stringify([raw.dir, raw.infoHash])
    const fingerprint = JSON.stringify([
      raw.dir,
      raw.totalLength,
      raw.infoHash,
      raw.bittorrent?.info?.name,
      raw.bittorrent?.mode,
      raw.status,
      raw.following,
    ])
    let entry = this.entries.get(raw.gid)
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = {
        fingerprint,
        identity,
        lastSeenAt: Date.now(),
        // Keep last-known metadata if a terminal read races engine eviction.
        // Explicit invalidation (selection edits/reconnect) never reuses it.
        metadata: entry?.identity === identity ? entry.metadata : undefined,
        refreshAt: 0,
      }
      this.entries.set(raw.gid, entry)
    }
    const current = entry
    current.lastSeenAt = Date.now()
    if (raw.files !== undefined) {
      // Compatibility with an engine that ignores keys; project once and drop
      // the large response before publishing it to list consumers.
      current.metadata = project(raw.files)
      current.refreshAt = Date.now() + REFRESH_INTERVAL_MS
    } else if (!current.loading && Date.now() >= current.refreshAt) {
      current.loading = this.rpc
        .getFiles(raw.gid)
        .then((files) => {
          if (files.length > 0 || !current.metadata)
            current.metadata = project(files)
          // Empty/pre-metadata file structures must not delay magnet/HTTP
          // identity discovery for a minute.
          const complete = files.length > 0 && files.every((f) => f.path !== '')
          current.refreshAt =
            Date.now() + (complete ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS)
        })
        .catch((err) => {
          current.refreshAt = Date.now() + RETRY_INTERVAL_MS
          log.debug({ err, gid: raw.gid }, 'file metadata sync failed')
        })
        .finally(() => {
          current.loading = undefined
        })
    }
    await current.loading
    // A selection edit, reconnect, or newer lifecycle sample won the race.
    // Do not let this older read repopulate the cache or overwrite the task.
    if (this.entries.get(raw.gid) !== current || !current.metadata) return null
    const { files: _files, ...status } = raw
    return { ...status, fileMetadata: current.metadata }
  }
}
