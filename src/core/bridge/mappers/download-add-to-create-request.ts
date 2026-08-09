import type { DownloadAddParams } from '@motrix/mdxp'
import type { TaskCreateRequest } from '@shared/schemas/add-task'

/**
 * Map the public `DownloadAddParams` union onto the host-native
 * `TaskCreateRequest`. The shapes nearly align — `headers` is identity
 * (`{name,value}[]` on both sides). The one piece of real logic is the torrent
 * **select-all default**: the native `bt` schema rejects an empty
 * `selectedFiles` for a torrent file, so an absent/empty public selection is
 * resolved to all file indices (0-based; the engine adds aria2's +1 offset).
 * Magnet keeps an empty selection (selection is deferred until metadata).
 *
 * `parseTorrentFileCount` is injected (defaults to a TorrentParser at the
 * bootstrap) so this mapper stays unit-testable without parsing a real torrent.
 */
export async function buildCreateRequest(
  params: DownloadAddParams,
  parseTorrentFileCount: (base64: string) => Promise<number>
): Promise<TaskCreateRequest> {
  switch (params.kind) {
    case 'url':
      return {
        type: 'http',
        uris: params.uris,
        saveDir: params.saveDir,
        headers: params.headers ?? [],
        ...(params.filename !== undefined ? { filename: params.filename } : {}),
        ...(params.connections !== undefined
          ? { connections: params.connections }
          : {}),
        ...(params.proxy !== undefined ? { proxy: params.proxy } : {}),
      }
    case 'magnet':
      return {
        type: 'bt',
        saveDir: params.saveDir,
        payload: { kind: 'magnet', uri: params.uri },
        selectedFiles: params.selectedFiles ?? [],
      }
    case 'torrent': {
      const explicit = params.selectedFiles ?? []
      const selectedFiles =
        explicit.length > 0
          ? explicit
          : Array.from(
              { length: await parseTorrentFileCount(params.base64) },
              (_, i) => i
            )
      return {
        type: 'bt',
        saveDir: params.saveDir,
        payload: { kind: 'torrent-base64', base64: params.base64 },
        selectedFiles,
        // Treat an empty displayName as absent: the public schema permits ''
        // but the native bt schema requires .min(1), and '' means "no name".
        ...(params.displayName ? { displayName: params.displayName } : {}),
      }
    }
  }
}
