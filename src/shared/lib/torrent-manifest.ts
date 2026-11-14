import type { TorrentManifest } from '@shared/schemas/torrent-manifest'
import type { TorrentMeta } from '@shared/types/torrent'
import type { EngineTorrent } from './engine-torrent'
import { projectTorrentMeta } from './torrent-meta'

/** Preserve native file indices, including padding and the v2 primary view. */
export function manifestToEngineTorrent(
  manifest: TorrentManifest
): EngineTorrent {
  const identity: EngineTorrent['identity'] = manifest.v1
    ? manifest.v2
      ? { kind: 'hybrid', sha1: manifest.v1, sha256: manifest.v2 }
      : { kind: 'v1', sha1: manifest.v1 }
    : { kind: 'v2', sha256: manifest.v2 ?? manifest.infoHash }
  let offset = 0
  const files = manifest.files.map((file) => {
    const start = offset
    offset += file.length
    return {
      name: file.components.at(-1) ?? manifest.name,
      path: file.components.join('/'),
      pathComponents: file.components,
      length: file.length,
      offset: start,
      padding: file.padding,
    }
  })
  return {
    identity,
    infoHash: manifest.infoHash,
    name: manifest.name,
    multiFile: manifest.multiFile,
    private: manifest.isPrivate,
    announce: [],
    files,
    length: offset,
  }
}

export function manifestToTorrentMeta(manifest: TorrentManifest): TorrentMeta {
  const meta = projectTorrentMeta(manifestToEngineTorrent(manifest))
  const files = meta.files.filter((file) => !manifest.files[file.index].padding)
  return {
    ...meta,
    files,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
  }
}
