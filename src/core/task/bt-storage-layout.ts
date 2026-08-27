import { createHash } from 'node:crypto'
import path from 'node:path'
import { containsOnlyVideoFiles } from '@shared/constants/file-types'
import type { DownloadTask } from '@shared/types/task'
import parseTorrent from 'parse-torrent'

const STORAGE_ROOT = '.motrix'
const PAYLOAD_ENTRY = 'p'
const LAYOUT_KEY = 'btStorageLayout'

export interface BtStorageLayoutV1 {
  version: 1
  strategy: 'indexed-staging'
  workspacePath: string
  payloadEntry: typeof PAYLOAD_ENTRY
  torrentRootName: string
  multiFile: boolean
}

export interface BtOutputFilePath {
  /** Domain-native, zero-based torrent file index. */
  fileIndex: number
  /** Path relative to the engine add operation's saveDir. */
  relativePath: string
}

export interface ParsedBtFileLayout {
  /** Canonical lowercase hexadecimal BitTorrent content identity. */
  infoHash: string
  torrentRootName: string
  multiFile: boolean
  isPrivate: boolean
  files: Array<{ fileIndex: number; pathInsideRoot: string | null }>
}

export interface BtStoragePlan {
  layout: BtStorageLayoutV1
  outputFilePaths: BtOutputFilePath[]
}

export class UnsafeTorrentPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTorrentPathError'
  }
}

/**
 * Parse and validate the paths declared by untrusted torrent metadata.
 * parse-torrent returns root-inclusive paths; Motrix strips that root before
 * mapping every file below its own short staging entry.
 */
export async function parseBtFileLayout(
  metadata: Uint8Array
): Promise<ParsedBtFileLayout> {
  const parsed = await parseTorrent(metadata)
  if (
    typeof parsed.infoHash !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(parsed.infoHash)
  ) {
    throw new UnsafeTorrentPathError('Torrent contains no valid info hash')
  }
  const torrentRootName = validatePathComponent(parsed.name, 'torrent name')
  const parsedFiles = parsed.files ?? []
  if (parsedFiles.length === 0) {
    throw new UnsafeTorrentPathError('Torrent contains no files')
  }

  const multiFile = Array.isArray(parsed.info?.files)
  const files = parsedFiles.map((file, fileIndex) => {
    const components = splitAndValidateTorrentPath(file.path)
    if (components[0] !== torrentRootName) {
      throw new UnsafeTorrentPathError(
        `Torrent file ${fileIndex} is outside its declared root directory`
      )
    }
    if (!multiFile) {
      if (components.length !== 1) {
        throw new UnsafeTorrentPathError(
          `Single-file torrent ${fileIndex} has a nested path`
        )
      }
      return { fileIndex, pathInsideRoot: null }
    }
    if (components.length < 2) {
      throw new UnsafeTorrentPathError(
        `Multi-file torrent ${fileIndex} has an empty path`
      )
    }
    return {
      fileIndex,
      pathInsideRoot: path.join(...components.slice(1)),
    }
  })

  return {
    infoHash: parsed.infoHash.toLowerCase(),
    torrentRootName,
    multiFile,
    isPrivate: parsed.private === true,
    files,
  }
}

/**
 * Enable preview-oriented piece ordering only when validated torrent metadata
 * proves that every declared file is a video. A mixed torrent stays on the
 * engine's normal piece policy even when the user selects only its videos.
 */
export function shouldPrioritizeBtPreviewPieces(
  parsed: ParsedBtFileLayout
): boolean {
  return containsOnlyVideoFiles(
    parsed.files.map((file) => file.pathInsideRoot ?? parsed.torrentRootName)
  )
}

/** Parse failures are an explicit "not proven video-only" result. */
export async function shouldPrioritizeBtPreviewPiecesFromMetadata(
  metadata: Uint8Array
): Promise<boolean> {
  try {
    return shouldPrioritizeBtPreviewPieces(await parseBtFileLayout(metadata))
  } catch {
    return false
  }
}

export function createBtStoragePlan(
  taskId: string,
  saveDir: string,
  parsed: ParsedBtFileLayout
): BtStoragePlan {
  const layout: BtStorageLayoutV1 = {
    version: 1,
    strategy: 'indexed-staging',
    workspacePath: btWorkspacePath(taskId, saveDir),
    payloadEntry: PAYLOAD_ENTRY,
    torrentRootName: parsed.torrentRootName,
    multiFile: parsed.multiFile,
  }
  return {
    layout,
    outputFilePaths: buildStagingOutputFilePaths(parsed, layout),
  }
}

export function btWorkspacePath(taskId: string, saveDir: string): string {
  const workspaceId = createHash('sha256')
    .update(taskId)
    .digest('hex')
    .slice(0, 20)
  return path.join(saveDir, STORAGE_ROOT, workspaceId)
}

export function buildStagingOutputFilePaths(
  parsed: ParsedBtFileLayout,
  layout: BtStorageLayoutV1
): BtOutputFilePath[] {
  assertLayoutMatchesMetadata(layout, parsed)
  return parsed.files.map((file) => ({
    fileIndex: file.fileIndex,
    relativePath:
      file.pathInsideRoot === null
        ? layout.payloadEntry
        : path.join(layout.payloadEntry, file.pathInsideRoot),
  }))
}

export function buildFinalOutputFilePaths(
  parsed: ParsedBtFileLayout,
  finalPath: string,
  expectedLayout?: BtStorageLayoutV1
): BtOutputFilePath[] {
  if (expectedLayout) assertLayoutMatchesMetadata(expectedLayout, parsed)
  const finalEntry = validatePathComponent(
    path.basename(finalPath),
    'final name'
  )
  return parsed.files.map((file) => ({
    fileIndex: file.fileIndex,
    relativePath:
      file.pathInsideRoot === null
        ? finalEntry
        : path.join(finalEntry, file.pathInsideRoot),
  }))
}

export function btStoragePayload(
  layout: BtStorageLayoutV1
): Record<string, unknown> {
  return { [LAYOUT_KEY]: layout }
}

export function getBtStorageLayout(
  task: Pick<DownloadTask, 'instances' | 'saveDir' | 'diskPath' | 'finalPath'>
): BtStorageLayoutV1 | null {
  for (const instance of task.instances) {
    const candidate = instance.payload[LAYOUT_KEY]
    if (isBtStorageLayout(candidate) && isLayoutOwnedByTask(candidate, task)) {
      return candidate
    }
  }
  return null
}

export function getBtPayloadPath(
  task: Pick<DownloadTask, 'instances' | 'saveDir' | 'diskPath' | 'finalPath'>
): string | null {
  const layout = getBtStorageLayout(task)
  return layout ? path.join(layout.workspacePath, layout.payloadEntry) : null
}

function assertLayoutMatchesMetadata(
  layout: BtStorageLayoutV1,
  parsed: ParsedBtFileLayout
): void {
  if (
    layout.torrentRootName !== parsed.torrentRootName ||
    layout.multiFile !== parsed.multiFile
  ) {
    throw new Error(
      'Persisted BT storage layout does not match torrent metadata'
    )
  }
}

function splitAndValidateTorrentPath(value: string): string[] {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw new UnsafeTorrentPathError(
      'Torrent contains an absolute or empty file path'
    )
  }
  const components = value.replace(/\\/g, '/').split('/')
  return components.map((component) =>
    validatePathComponent(component, 'torrent file path')
  )
}

function validatePathComponent(value: unknown, description: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new UnsafeTorrentPathError(`Invalid ${description}`)
  }
  return value
}

function isBtStorageLayout(value: unknown): value is BtStorageLayoutV1 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BtStorageLayoutV1>
  return (
    candidate.version === 1 &&
    candidate.strategy === 'indexed-staging' &&
    typeof candidate.workspacePath === 'string' &&
    path.isAbsolute(candidate.workspacePath) &&
    candidate.payloadEntry === PAYLOAD_ENTRY &&
    typeof candidate.torrentRootName === 'string' &&
    isSafePathComponent(candidate.torrentRootName) &&
    typeof candidate.multiFile === 'boolean'
  )
}

function isLayoutOwnedByTask(
  layout: BtStorageLayoutV1,
  task: Pick<DownloadTask, 'saveDir' | 'diskPath' | 'finalPath'>
): boolean {
  if (!task.saveDir) return false
  const workspacePath = path.resolve(layout.workspacePath)
  const storageRoot = path.resolve(task.saveDir, STORAGE_ROOT)
  if (
    path.dirname(workspacePath) !== storageRoot ||
    !/^[a-f0-9]{20}$/.test(path.basename(workspacePath))
  ) {
    return false
  }

  // While the task is in-flight, the canonical diskPath must identify the
  // same workspace. After rename diskPath equals finalPath, so the retained
  // layout remains available for reseed/retry mapping without authorizing
  // arbitrary filesystem operations from persisted JSON.
  return (
    task.diskPath === task.finalPath ||
    path.resolve(task.diskPath) === workspacePath
  )
}

function isSafePathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}
