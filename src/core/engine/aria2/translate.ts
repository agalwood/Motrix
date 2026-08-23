import path from 'node:path'
import {
  applyTerminalTransition,
  terminalFieldsFromRow,
} from '@core/task/apply-terminal-transition'
import { toFinalPath } from '@core/task/paths'
import { DownloadErrorCode } from '@shared/errors'
import type { TaskPeer } from '@shared/types/peer'
import type { GlobalStats } from '@shared/types/stats'
import type {
  BtExtension,
  DownloadTask,
  TaskFile,
  TaskInstance,
} from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import peerid from 'bittorrent-peerid'
import type {
  Aria2RawFile,
  Aria2RawGlobalStat,
  Aria2RawPeer,
  Aria2RawStatus,
} from './types'

// ─── Status Translation ───────────────────────────────────────

export function translateStatus(raw: Aria2RawStatus): TaskStatus {
  // BT seeding detection: active + seeder === 'true'
  if (raw.status === 'active' && raw.seeder === 'true' && raw.bittorrent) {
    return TaskStatus.Seeding
  }

  // Metadata fetching detection: active + totalLength === '0'.
  // Gated on `raw.bittorrent` because that shape is only meaningful
  // for BT/Magnet (waiting on torrent metadata). HTTP/FTP can show
  // the same shape transiently before the response Content-Length is
  // parsed, or persistently when a server uses chunked transfer
  // encoding; labeling those as "Fetch Metadata" misleads the user.
  if (
    raw.status === 'active' &&
    raw.totalLength === '0' &&
    raw.bittorrent !== undefined
  ) {
    return TaskStatus.FetchingMetadata
  }

  switch (raw.status) {
    case 'active':
      return TaskStatus.Downloading
    case 'waiting':
      return TaskStatus.Queued
    case 'paused':
      return TaskStatus.Paused
    case 'complete':
      return TaskStatus.Completed
    case 'error':
      return TaskStatus.Error
    case 'removed':
      return TaskStatus.Removed
    default:
      return TaskStatus.Error
  }
}

export function translateErrorCode(
  raw: string | null | undefined
): DownloadErrorCode | null {
  const normalized = raw?.trim()
  if (!normalized || normalized === '0') return null
  if (!/^\d+$/.test(normalized)) return DownloadErrorCode.Unknown

  const code = Number.parseInt(normalized, 10)
  switch (code) {
    case 2:
    case 5:
      return DownloadErrorCode.Timeout
    case 3:
    case 4:
      return DownloadErrorCode.NotFound
    case 6:
    case 19:
      return DownloadErrorCode.NetworkError
    case 9:
      return DownloadErrorCode.DiskFull
    case 11:
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
    case 18:
      return DownloadErrorCode.FileWriteError
    case 23:
      return DownloadErrorCode.TooManyRedirects
    case 24:
      return DownloadErrorCode.Unauthorized
    case 8:
    case 21:
    case 22:
    case 29:
      return DownloadErrorCode.ServerError
    case 25:
    case 26:
    case 27:
      return DownloadErrorCode.BtMetadataFailed
    case 10:
    case 32:
      return DownloadErrorCode.ChecksumMismatch
    // DownloadErrorCode.BtTrackerError is reserved wire contract with no
    // producer today — kept for future tracker-error refinement; do not
    // force-map an aria2 exit code onto it.
    default:
      return DownloadErrorCode.Unknown
  }
}

// ─── Task Type Detection ──────────────────────────────────────

export function detectTaskType(raw: Aria2RawStatus): TaskType {
  // Check first file's URI first — magnet links have bittorrent
  // metadata in aria2 but should be identified by their URI scheme
  const firstUri = raw.files?.[0]?.uris?.[0]?.uri ?? ''
  if (firstUri.startsWith('magnet:')) return TaskType.Magnet
  if (firstUri.startsWith('ftp://')) return TaskType.Ftp

  if (raw.bittorrent) return TaskType.Bt

  return TaskType.Http
}

// ─── Progress & ETA ───────────────────────────────────────────

export function computeProgress(
  totalLength: string,
  completedLength: string
): number {
  const total = Number(totalLength)
  const completed = Number(completedLength)
  if (total === 0) return 0
  return completed / total
}

export function computeEta(
  totalLength: string,
  completedLength: string,
  downloadSpeed: string
): number {
  const remaining = Number(totalLength) - Number(completedLength)
  const speed = Number(downloadSpeed)
  if (speed === 0 || remaining <= 0) return 0
  return Math.round(remaining / speed)
}

// ─── Name & URI Extraction ────────────────────────────────────

export function extractName(raw: Aria2RawStatus): string {
  // BT downloads: use torrent name from metadata
  if (raw.bittorrent?.info?.name) {
    return raw.bittorrent.info.name
  }

  // File-based: use first file path's basename
  const firstFile = raw.files?.[0]
  if (firstFile?.path) {
    const parts = firstFile.path.split('/')
    return parts[parts.length - 1] || firstFile.path
  }

  // Fallback: use first URI's filename
  const firstUri = raw.files?.[0]?.uris?.[0]?.uri
  if (firstUri) {
    try {
      const url = new URL(firstUri)
      const pathParts = url.pathname.split('/')
      return pathParts[pathParts.length - 1] || raw.gid
    } catch {
      return raw.gid
    }
  }

  return raw.gid
}

export function extractUris(raw: Aria2RawStatus): string[] {
  const seen = new Set<string>()
  const uris: string[] = []
  for (const file of raw.files ?? []) {
    for (const u of file.uris) {
      if (!seen.has(u.uri)) {
        seen.add(u.uri)
        uris.push(u.uri)
      }
    }
  }
  return uris
}

// ─── BT Extension ────────────────────────────────────────────

export function translateBtExtension(
  raw: Aria2RawStatus
): BtExtension | undefined {
  if (!raw.bittorrent) return undefined

  return {
    peers: Number(raw.connections) || 0,
    seeds: Number(raw.numSeeders) || 0,
    ratio:
      Number(raw.completedLength) > 0
        ? Number(raw.uploadLength) / Number(raw.completedLength)
        : 0,
    trackers: (raw.bittorrent.announceList ?? []).flat(),
    selectedFiles: (raw.files ?? [])
      .filter((f) => f.selected === 'true')
      // aria2 numbers files from 1; the engine-neutral domain uses 0-based
      // indices (the same convention as TorrentFileInfo and selection
      // commands). Keep that engine detail inside this adapter boundary.
      .map((f) => Number(f.index) - 1),
    peersInSwarm: 0,
    seedsInSwarm: 0,
    announceList: raw.bittorrent.announceList ?? [],
    comment: raw.bittorrent.comment ?? null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
  }
}

// ─── Path Derivation ─────────────────────────────────────────
// aria2 reports its on-disk state via `raw.files[].path` (individual
// files) and `raw.dir` (torrent container directory). When we restore
// a task that was created before Task 13 persisted `diskPath`/
// `finalPath`/`finalName` — or adopt an orphan GID that aria2 already
// owns — we derive those fields from the aria2 view of the filesystem
// rather than leaving them empty, so downstream rename/reseed code
// sees a self-consistent path trio.

export interface DerivedPaths {
  diskPath: string
  finalPath: string
  finalName: string
}

export function derivePathsFromRaw(raw: Aria2RawStatus): DerivedPaths {
  const taskType = detectTaskType(raw)
  const isBt = taskType === TaskType.Bt || taskType === TaskType.Magnet

  // BT/magnet downloads: aria2 places files under `raw.dir` using the
  // torrent's root name (single or multi-file). The container itself
  // is what we rename at finalize time, so `diskPath` tracks `raw.dir`.
  if (isBt) {
    const diskPath = raw.dir
    const finalPath = toFinalPath(diskPath)
    return {
      diskPath,
      finalPath,
      finalName: finalPath ? path.basename(finalPath) : '',
    }
  }

  // HTTP/FTP: the first selected file's path is the canonical on-disk
  // location. Fallback to `raw.dir` + extracted name if files[] is
  // empty (e.g. pre-metadata state).
  const filePath = raw.files?.[0]?.path
  const diskPath =
    filePath && filePath.length > 0
      ? filePath
      : raw.dir
        ? path.join(raw.dir, extractName(raw))
        : ''

  if (diskPath === '') {
    return { diskPath: '', finalPath: '', finalName: '' }
  }

  const finalPath = toFinalPath(diskPath)
  return {
    diskPath,
    finalPath,
    finalName: path.basename(finalPath),
  }
}

// ─── Full Task Translation ────────────────────────────────────

export function translateRawToTask(raw: Aria2RawStatus): DownloadTask {
  const now = Date.now()
  const status = translateStatus(raw)
  const derivedPaths = derivePathsFromRaw(raw)
  // extractName reads aria2's on-disk file name, which carries the `.motrix`
  // in-flight placeholder for HTTP tasks. Adopted orphans (restore Pass 1 /
  // poll discovery) mint their display name here — strip the internal suffix
  // so it never surfaces in the Downloads list. Path fields keep it: they
  // must reflect the on-disk truth for finalize's rename.
  const displayName = toFinalPath(extractName(raw))
  const taskType = detectTaskType(raw)
  const kind: TaskKind =
    taskType === TaskType.Bt || taskType === TaskType.Magnet
      ? TaskKind.Bt
      : TaskKind.Direct
  const phase: TaskInstancePhase =
    kind === TaskKind.Bt
      ? TaskInstancePhase.BtDownload
      : TaskInstancePhase.HttpDownload
  const totalBytes = Number(raw.totalLength)
  const downloadedBytes = Number(raw.completedLength)
  const synthInstance: TaskInstance = {
    // motrixId left empty — SessionManager.adoptTask remaps after newTaskId().
    instanceId: `adopted:${raw.gid}`,
    motrixId: '',
    gid: raw.gid,
    phase,
    status,
    progress:
      totalBytes > 0
        ? Math.min(100, Math.round((downloadedBytes * 100) / totalBytes))
        : 0,
    totalBytes,
    downloadedBytes,
    uploadedBytes: Number(raw.uploadLength || 0),
    diskPath: derivedPaths.diskPath,
    transitionPhase: TransitionPhase.Idle,
    uris: extractUris(raw),
    uriHash: null,
    payload: {},
    createdAt: now,
    updatedAt: now,
  }

  const terminalFields = applyTerminalTransition(
    terminalFieldsFromRow(null),
    status,
    {
      finishedAt: raw.status === 'complete' ? now : null,
      errorMessage: raw.errorMessage ?? null,
      errorCode: translateErrorCode(raw.errorCode),
    },
    now
  )

  return {
    // id is set to GID — the caller (SessionManager) will resolve
    // the Motrix UUID from the metadata database
    id: raw.gid,
    engineTaskId: raw.gid,
    name: displayName,
    kind,
    type: taskType,
    ...terminalFields,
    progress: computeProgress(raw.totalLength, raw.completedLength),
    totalBytes: Number(raw.totalLength),
    downloadedBytes: Number(raw.completedLength),
    downloadSpeed: Number(raw.downloadSpeed),
    uploadSpeed: Number(raw.uploadSpeed),
    etaSeconds: computeEta(
      raw.totalLength,
      raw.completedLength,
      raw.downloadSpeed
    ),
    saveDir: raw.dir,
    createdAt: now,
    updatedAt: now,
    uris: extractUris(raw),
    // Adopt path: no historical sessions known, so display value equals
    // current gid's uploadLength. Sidecar-driven paths in SessionManager
    // override the baseline if motrix.db has a saved value.
    uploadedBytes: Number(raw.uploadLength),
    uploadedBytesBaseline: 0,
    fileCount: raw.files?.length ?? 0,

    connections: Number(raw.connections),
    pieceLength: Number(raw.pieceLength) || 0,
    infoHash: raw.infoHash ?? null,
    metadataProgress: 0,

    priority: 0,
    category: null,
    dlLimit: 0,
    ulLimit: 0,
    filename: displayName,
    sizeWhenDone: Number(raw.totalLength),

    bt: translateBtExtension(raw),

    diskPath: derivedPaths.diskPath,
    finalPath: derivedPaths.finalPath,
    finalName: derivedPaths.finalName,
    // Restored tasks are Idle by definition — only in-flight intent
    // markers come from the persistence layer, handled by SessionManager.
    transitionPhase: TransitionPhase.Idle,
    // Restored tasks have no torrent metadata blob path on disk; new
    // tasks set this at create time via `createTaskHandler`.
    torrentMetaPath: null,
    // Provenance defaults; overridden by SessionManager from persisted metadata.
    source: 'user',
    sourceMeta: null,
    instances: [synthInstance],
  }
}

// ─── File Translation ─────────────────────────────────────────

export function translateRawFile(raw: Aria2RawFile): TaskFile {
  return {
    // aria2.getFiles is 1-based; TaskFile is engine-neutral and 0-based.
    index: Number(raw.index) - 1,
    path: raw.path,
    size: Number(raw.length),
    completedBytes: Number(raw.completedLength),
    selected: raw.selected === 'true',
  }
}

// ─── Peer Translation ─────────────────────────────────────────

/**
 * aria2 percent-encodes peerId bytes because the wire form is raw 20
 * bytes and not guaranteed to be UTF-8 safe. `decodeURIComponent` would
 * choke on non-UTF-8 sequences (e.g. 0xff), so we walk the string and
 * decode `%XX` pairs to bytes manually. Anything that is not a percent
 * escape passes through as its low-byte char code.
 */
export function decodeAria2PeerId(encoded: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < encoded.length; ) {
    const ch = encoded[i]
    if (ch === '%' && i + 2 < encoded.length) {
      const byte = Number.parseInt(encoded.slice(i + 1, i + 3), 16)
      if (Number.isFinite(byte)) {
        out.push(byte)
        i += 3
        continue
      }
    }
    out.push(encoded.charCodeAt(i) & 0xff)
    i += 1
  }
  return Buffer.from(out)
}

/**
 * Estimate piece progress from a hex bitfield by counting set bits.
 *
 * The peer's bitfield length is `ceil(numPieces / 8)` bytes, which may
 * include trailing padding bits. We don't know the exact piece count at
 * this layer (aria2.getPeers does not return it) so the result is
 * approximate — close enough for a UI percentage and avoids a separate
 * tellStatus call per peers refresh.
 */
export function bitfieldProgress(hex: string): number {
  if (!hex) return 0
  let total = 0
  let set = 0
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i], 16)
    if (Number.isNaN(nibble)) continue
    total += 4
    set +=
      ((nibble >> 0) & 1) +
      ((nibble >> 1) & 1) +
      ((nibble >> 2) & 1) +
      ((nibble >> 3) & 1)
  }
  return total === 0 ? 0 : set / total
}

export function translatePeer(raw: Aria2RawPeer): TaskPeer {
  const port = Number.parseInt(raw.port, 10) || 0
  const buffer = decodeAria2PeerId(raw.peerId ?? '')
  let client: string | null = null
  let version: string | null = null
  if (buffer.length === 20) {
    try {
      const parsed = peerid(buffer)
      // bittorrent-peerid emits 'unknown' for buffers that don't match
      // any scheme; treat that as null so the UI can show a dash.
      if (parsed.client && parsed.client !== 'unknown') {
        client = parsed.client
        version = parsed.version ?? null
      }
    } catch {
      // Malformed peerId — leave client null, UI degrades gracefully.
    }
  }
  return {
    id: `${raw.ip}:${port}`,
    ip: raw.ip,
    port,
    client,
    clientVersion: version,
    progress: bitfieldProgress(raw.bitfield ?? ''),
    downSpeed: Number.parseInt(raw.downloadSpeed ?? '0', 10) || 0,
    upSpeed: Number.parseInt(raw.uploadSpeed ?? '0', 10) || 0,
    seeder: raw.seeder === 'true',
    amChoking: raw.amChoking === 'true',
    peerChoking: raw.peerChoking === 'true',
  }
}

// ─── Global Stats Translation ─────────────────────────────────

export function translateGlobalStat(raw: Aria2RawGlobalStat): GlobalStats {
  return {
    totalDownloadSpeed: Number(raw.downloadSpeed),
    totalUploadSpeed: Number(raw.uploadSpeed),
    activeTasks: Number(raw.numActive),
    waitingTasks: Number(raw.numWaiting),
    stoppedTasks: Number(raw.numStopped),
  }
}
