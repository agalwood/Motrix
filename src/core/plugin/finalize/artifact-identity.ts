import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import path from 'node:path'

export interface FileArtifactIdentity {
  kind: 'file'
  size: number
  sha256: string
  platformFileId: string
}

export interface DirectoryArtifactIdentity {
  kind: 'directory'
  entryCount: number
  totalBytes: number
  treeSha256: string
  platformFileId: string
}

export type ArtifactIdentity = FileArtifactIdentity | DirectoryArtifactIdentity

export class ArtifactIdentityError extends Error {
  constructor(
    readonly code:
      | 'artifact_missing'
      | 'artifact_mutated'
      | 'artifact_special_file'
      | 'artifact_too_large'
      | 'artifact_unsafe_path',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ArtifactIdentityError'
  }
}

export interface ArtifactIdentityOptions {
  maxEntries?: number
}

const statKey = (value: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): string =>
  `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`

const fileId = (value: { dev: bigint; ino: bigint }): string =>
  `${value.dev}:${value.ino}`

function appendRecord(
  hash: ReturnType<typeof createHash>,
  fields: Buffer[]
): void {
  for (const field of fields) {
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(field.length))
    hash.update(length)
    hash.update(field)
  }
}

async function identityForFile(
  filePath: string
): Promise<FileArtifactIdentity> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new ArtifactIdentityError(
      'artifact_missing',
      `cannot open artifact without following links: ${filePath}`,
      { cause: error }
    )
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) {
      throw new ArtifactIdentityError(
        'artifact_special_file',
        `artifact is not a regular file: ${filePath}`
      )
    }
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk as Buffer)
    const after = await handle.stat({ bigint: true })
    if (statKey(before) !== statKey(after)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `artifact changed while hashing: ${filePath}`
      )
    }
    if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArtifactIdentityError(
        'artifact_too_large',
        `artifact size exceeds the safe identity range: ${filePath}`
      )
    }
    return {
      kind: 'file',
      size: Number(after.size),
      sha256: hash.digest('hex'),
      platformFileId: fileId(after),
    }
  } finally {
    await handle.close()
  }
}

interface TreeRecord {
  type: 'directory' | 'file'
  relativePath: string
  size?: number
  sha256?: string
}

async function walkDirectory(
  root: string,
  current: string,
  records: TreeRecord[],
  maxEntries: number
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name))
  )
  for (const entry of entries) {
    if (records.length >= maxEntries) {
      throw new ArtifactIdentityError(
        'artifact_too_large',
        `directory artifact exceeds ${maxEntries} entries`
      )
    }
    const absolute = path.join(current, entry.name)
    const relativePath = path.relative(root, absolute)
    const entryStat = await lstat(absolute, { bigint: true })
    if (entryStat.isSymbolicLink()) {
      throw new ArtifactIdentityError(
        'artifact_unsafe_path',
        `directory artifact contains a symbolic link: ${relativePath}`
      )
    }
    if (entryStat.isDirectory()) {
      records.push({ type: 'directory', relativePath })
      await walkDirectory(root, absolute, records, maxEntries)
      const after = await lstat(absolute, { bigint: true })
      if (statKey(entryStat) !== statKey(after)) {
        throw new ArtifactIdentityError(
          'artifact_mutated',
          `directory changed while hashing: ${relativePath}`
        )
      }
      continue
    }
    if (!entryStat.isFile()) {
      throw new ArtifactIdentityError(
        'artifact_special_file',
        `directory artifact contains a special entry: ${relativePath}`
      )
    }
    const identity = await identityForFile(absolute)
    if (identity.platformFileId !== fileId(entryStat)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `directory entry was replaced while hashing: ${relativePath}`
      )
    }
    records.push({
      type: 'file',
      relativePath,
      size: identity.size,
      sha256: identity.sha256,
    })
  }
}

export async function readArtifactIdentity(
  artifactPath: string,
  options: ArtifactIdentityOptions = {}
): Promise<ArtifactIdentity> {
  const root = await lstat(artifactPath, { bigint: true }).catch((error) => {
    throw new ArtifactIdentityError(
      'artifact_missing',
      `artifact does not exist: ${artifactPath}`,
      { cause: error }
    )
  })
  if (root.isSymbolicLink()) {
    throw new ArtifactIdentityError(
      'artifact_unsafe_path',
      `artifact root is a symbolic link: ${artifactPath}`
    )
  }
  if (root.isFile()) return identityForFile(artifactPath)
  if (!root.isDirectory()) {
    throw new ArtifactIdentityError(
      'artifact_special_file',
      `artifact root is neither a file nor a directory: ${artifactPath}`
    )
  }

  const directoryHandle =
    process.platform === 'win32'
      ? null
      : await open(
          artifactPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        )
  try {
    const before = directoryHandle
      ? await directoryHandle.stat({ bigint: true })
      : await lstat(artifactPath, { bigint: true })
    const records: TreeRecord[] = []
    await walkDirectory(
      artifactPath,
      artifactPath,
      records,
      options.maxEntries ?? 1_000_000
    )
    const after = directoryHandle
      ? await directoryHandle.stat({ bigint: true })
      : await lstat(artifactPath, { bigint: true })
    if (statKey(before) !== statKey(after)) {
      throw new ArtifactIdentityError(
        'artifact_mutated',
        `directory root changed while hashing: ${artifactPath}`
      )
    }
    const hash = createHash('sha256')
    appendRecord(hash, [Buffer.from('motrix-directory-identity-v1')])
    appendRecord(hash, [Buffer.from(process.platform)])
    appendRecord(hash, [Buffer.from('directory'), Buffer.from('')])
    let totalBytes = 0
    for (const record of records) {
      const fields = [
        Buffer.from(record.type),
        Buffer.from(record.relativePath),
      ]
      if (record.type === 'file') {
        const size = Buffer.allocUnsafe(8)
        size.writeBigUInt64BE(BigInt(record.size ?? 0))
        fields.push(size, Buffer.from(record.sha256 ?? '', 'hex'))
        totalBytes += record.size ?? 0
        if (!Number.isSafeInteger(totalBytes)) {
          throw new ArtifactIdentityError(
            'artifact_too_large',
            'directory byte total exceeds the safe identity range'
          )
        }
      }
      appendRecord(hash, fields)
    }
    return {
      kind: 'directory',
      entryCount: records.length,
      totalBytes,
      treeSha256: hash.digest('hex'),
      platformFileId: fileId(after),
    }
  } finally {
    await directoryHandle?.close()
  }
}

export function artifactIdentityEquals(
  left: ArtifactIdentity,
  right: ArtifactIdentity
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'file' && right.kind === 'file') {
    return (
      left.size === right.size &&
      left.sha256 === right.sha256 &&
      left.platformFileId === right.platformFileId
    )
  }
  if (left.kind === 'directory' && right.kind === 'directory') {
    return (
      left.entryCount === right.entryCount &&
      left.totalBytes === right.totalBytes &&
      left.treeSha256 === right.treeSha256 &&
      left.platformFileId === right.platformFileId
    )
  }
  return false
}

/** Compares immutable bytes/tree content across an intentional copy. */
export function artifactContentEquals(
  left: ArtifactIdentity,
  right: ArtifactIdentity
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'file' && right.kind === 'file') {
    return left.size === right.size && left.sha256 === right.sha256
  }
  if (left.kind === 'directory' && right.kind === 'directory') {
    return (
      left.entryCount === right.entryCount &&
      left.totalBytes === right.totalBytes &&
      left.treeSha256 === right.treeSha256
    )
  }
  return false
}
