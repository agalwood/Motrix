// Hardened .moext (zip) extractor.
//
// Defenses (rejected at the entry boundary, BEFORE any data is written):
//   - zip-slip:   absolute paths, '..' segments, backslashes
//   - symlinks:   external-file-attribute mode bits indicate a link
//   - oversized:  per-bundle and total caps
//   - collisions: exact duplicate paths and file/directory conflicts
//
// Integrity: the archive is read once, hashed, and that exact in-memory byte
// sequence is used for extraction so a path replacement cannot make
// verification and unpacking observe different packages. ExtractResult keeps
// the existing SHA-256-of-dist/plugin.js install-record semantics.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import yauzl from 'yauzl'

const BUNDLE_SIZE_MAX = 1 << 20 // 1 MB — limit on dist/plugin.js
const MOEXT_TOTAL_MAX = 5 << 20 // 5 MB — total uncompressed cap
const FILE_READ_CHUNK = 64 << 10
const DEFAULT_BUNDLE_ENTRY = 'dist/plugin.js'
const MANIFEST_ENTRY = 'motrix-plugin.json'
const SYMLINK_MODE = 0o120000

export interface ExtractResult {
  bundleSha256: string
  manifestRaw: string
  totalUncompressed: number
}

export interface LoadedMoext {
  /** Exact package bytes from one bounded file-descriptor read. */
  readonly bytes: Buffer
  /** SHA-256 of the complete .moext archive. */
  readonly archiveSha256: string
}

interface MoextScanResult {
  totalUncompressed: number
  hasManifest: boolean
  hasDefaultBundle: boolean
}

interface PathIndex {
  explicitPaths: Set<string>
  filePaths: Set<string>
  requiredDirectoryPaths: Set<string>
}

function fail(code: string): never {
  throw new AppError(ErrorCode.PluginManifestInvalid, code)
}

// Name-only half of the zip-slip guard: reject '..' segments, absolute paths,
// and backslashes regardless of whether the caller is writing to disk
// (extractMoext) or reading a single entry into memory (readMoextEntry).
function assertSafeEntryName(entryName: string): void {
  if (
    entryName.split('/').includes('..') ||
    entryName.startsWith('/') ||
    entryName.includes('\\')
  ) {
    fail('plugin.install.zip_slip')
  }
}

// Reject anything that, after path.resolve, escapes destDir. Belt-and-suspenders
// against zip-slip on systems where '..' would be allowed by path.join.
function assertSafeEntry(entryName: string, destDir: string): string {
  assertSafeEntryName(entryName)
  const target = path.resolve(destDir, entryName)
  const safe = path.resolve(destDir)
  if (target !== safe && !target.startsWith(safe + path.sep)) {
    fail('plugin.install.zip_slip')
  }
  return target
}

// yauzl's own filename validation rejects '..', leading '/', and '\' before
// they reach our entry handler. Both extractMoext and readMoextEntry
// translate those to our canonical error code so callers see a single
// failure mode for path-traversal attempts.
function isZipSlipYauzlError(message: string): boolean {
  return /invalid relative path|absolute path|invalid characters in (?:file ?name)/i.test(
    message
  )
}

// File-mode bits stored in the external-file-attribute upper 16 bits.
function entryIsSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  return mode === SYMLINK_MODE
}

function pathCollision(): never {
  fail('plugin.install.path_collision')
}

/** Register exact duplicate and file-vs-directory conflicts before writing. */
function registerPath(
  entryName: string,
  isDirectory: boolean,
  index: PathIndex
): void {
  const withoutTrailingSlash = isDirectory ? entryName.slice(0, -1) : entryName
  if (withoutTrailingSlash.length === 0) pathCollision()

  const parts = withoutTrailingSlash.split('/')
  for (let i = 0; i < parts.length - 1; i += 1) {
    const prefix = parts.slice(0, i + 1).join('/')
    if (index.filePaths.has(prefix)) pathCollision()
    index.requiredDirectoryPaths.add(prefix)
  }

  if (index.explicitPaths.has(withoutTrailingSlash)) pathCollision()
  if (!isDirectory && index.requiredDirectoryPaths.has(withoutTrailingSlash)) {
    pathCollision()
  }
  index.explicitPaths.add(withoutTrailingSlash)
  if (!isDirectory) index.filePaths.add(withoutTrailingSlash)
}

function translateZipError(error: Error): Error {
  if (isZipSlipYauzlError(error.message)) {
    return new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.zip_slip'
    )
  }
  return error
}

/** Preflight every central-directory entry without creating destDir. */
function scanMoextEntries(bytes: Buffer): Promise<MoextScanResult> {
  return new Promise<MoextScanResult>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(
          openErr ??
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.zip_invalid'
            )
        )
        return
      }

      const index: PathIndex = {
        explicitPaths: new Set(),
        filePaths: new Set(),
        requiredDirectoryPaths: new Set(),
      }
      let totalUncompressed = 0
      let hasManifest = false
      let hasDefaultBundle = false
      let settled = false

      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        zip.close()
        if (error) {
          reject(error)
        } else {
          resolve({
            totalUncompressed,
            hasManifest,
            hasDefaultBundle,
          })
        }
      }

      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          assertSafeEntryName(entry.fileName)
          const isDirectory = entry.fileName.endsWith('/')
          registerPath(entry.fileName, isDirectory, index)
          if (entryIsSymlink(entry)) fail('plugin.install.zip_symlink')

          totalUncompressed += entry.uncompressedSize
          if (totalUncompressed > MOEXT_TOTAL_MAX) {
            fail('plugin.manifest.bundle_too_large')
          }
          if (
            entry.fileName === DEFAULT_BUNDLE_ENTRY &&
            entry.uncompressedSize > BUNDLE_SIZE_MAX
          ) {
            fail('plugin.manifest.bundle_too_large')
          }
          if (entry.fileName === MANIFEST_ENTRY && !isDirectory) {
            hasManifest = true
          }
          if (entry.fileName === DEFAULT_BUNDLE_ENTRY && !isDirectory) {
            hasDefaultBundle = true
          }
          zip.readEntry()
        } catch (error) {
          finish(error)
        }
      })
      zip.on('end', () => finish())
      zip.on('error', (error: Error) => finish(translateZipError(error)))
      zip.readEntry()
    })
  })
}

export async function loadMoext(moextPath: string): Promise<LoadedMoext> {
  // Read through one open file descriptor and stop at the compressed-size
  // limit. A pathname swap after open cannot change which file is verified,
  // and an oversized file is never buffered in full before rejection.
  const handle = await open(moextPath, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const remaining = MOEXT_TOTAL_MAX + 1 - total
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK, remaining))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MOEXT_TOTAL_MAX) {
        fail('plugin.manifest.bundle_too_large')
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  const bytes = Buffer.concat(chunks, total)
  return {
    bytes,
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function extractLoadedMoext(
  loaded: LoadedMoext,
  destDir: string
): Promise<ExtractResult> {
  if (loaded.bytes.byteLength > MOEXT_TOTAL_MAX) {
    fail('plugin.manifest.bundle_too_large')
  }
  if (
    createHash('sha256').update(loaded.bytes).digest('hex') !==
    loaded.archiveSha256
  ) {
    fail('plugin.install.sha256_mismatch')
  }
  const scan = await scanMoextEntries(loaded.bytes)
  if (!scan.hasManifest) {
    fail('plugin.install.manifest_not_at_root')
  }
  if (!scan.hasDefaultBundle) {
    fail('plugin.install.bundle_missing')
  }
  await mkdir(destDir, { recursive: true })

  return new Promise<ExtractResult>((resolve, reject) => {
    yauzl.fromBuffer(loaded.bytes, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(
          openErr ??
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.zip_invalid'
            )
        )
        return
      }
      let manifestRaw: string | null = null
      let hasDefaultBundle = false
      let defaultBundleSha256: string | null = null
      let totalUncompressed = 0
      // Actual decompressed bytes streamed across ALL entries. totalUncompressed
      // above trusts the zip header's uncompressedSize (forgeable); this caps
      // the real output so a lying header can't write GBs of a non-bundle entry
      // to disk (the per-stream cap below only guarded the bundle).
      let totalActualBytes = 0
      let settled = false

      const finish = (err: unknown, value?: ExtractResult) => {
        if (settled) return
        settled = true
        zip.close()
        if (err) reject(err)
        else if (value) resolve(value)
      }

      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          const isDir = /\/$/.test(entry.fileName)
          const target = assertSafeEntry(entry.fileName, destDir)
          if (entryIsSymlink(entry)) {
            finish(
              new AppError(
                ErrorCode.PluginManifestInvalid,
                'plugin.install.zip_symlink'
              )
            )
            return
          }
          totalUncompressed += entry.uncompressedSize
          if (totalUncompressed > MOEXT_TOTAL_MAX) {
            finish(
              new AppError(
                ErrorCode.PluginManifestInvalid,
                'plugin.manifest.bundle_too_large'
              )
            )
            return
          }
          if (isDir) {
            mkdir(target, { recursive: true })
              .then(() => zip.readEntry())
              .catch((e) => finish(e))
            return
          }
          const isBundle = entry.fileName === DEFAULT_BUNDLE_ENTRY
          if (isBundle && entry.uncompressedSize > BUNDLE_SIZE_MAX) {
            finish(
              new AppError(
                ErrorCode.PluginManifestInvalid,
                'plugin.manifest.bundle_too_large'
              )
            )
            return
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              finish(
                streamErr ??
                  new AppError(
                    ErrorCode.PluginManifestInvalid,
                    'plugin.install.zip_invalid'
                  )
              )
              return
            }
            mkdir(path.dirname(target), { recursive: true })
              .then(
                () =>
                  new Promise<void>((res, rej) => {
                    // Never overwrite an earlier entry or a pre-existing path.
                    // The host filesystem itself decides whether distinct ZIP
                    // spellings (case, Unicode, Win32 aliases) name one file.
                    const ws = createWriteStream(target, { flags: 'wx' })
                    const hash = isBundle ? createHash('sha256') : null
                    const manifestChunks: Buffer[] | null =
                      entry.fileName === MANIFEST_ENTRY ? [] : null
                    let written = 0
                    const rejectWrite = (error: NodeJS.ErrnoException) => {
                      stream.destroy()
                      if (error.code === 'EEXIST') {
                        rej(
                          new AppError(
                            ErrorCode.PluginManifestInvalid,
                            'plugin.install.path_collision'
                          )
                        )
                        return
                      }
                      rej(error)
                    }
                    stream.on('data', (chunk: Buffer) => {
                      written += chunk.length
                      totalActualBytes += chunk.length
                      if (
                        (isBundle && written > BUNDLE_SIZE_MAX) ||
                        totalActualBytes > MOEXT_TOTAL_MAX
                      ) {
                        stream.destroy()
                        ws.destroy()
                        rej(
                          new AppError(
                            ErrorCode.PluginManifestInvalid,
                            'plugin.manifest.bundle_too_large'
                          )
                        )
                        return
                      }
                      if (manifestChunks) manifestChunks.push(chunk)
                      hash?.update(chunk)
                      ws.write(chunk)
                    })
                    stream.on('end', () => {
                      ws.end((error?: Error | null) => {
                        if (error) {
                          rejectWrite(error)
                          return
                        }
                        if (isBundle) hasDefaultBundle = true
                        if (hash) defaultBundleSha256 = hash.digest('hex')
                        if (manifestChunks) {
                          manifestRaw =
                            Buffer.concat(manifestChunks).toString('utf8')
                        }
                        res()
                      })
                    })
                    stream.on('error', rej)
                    ws.on('error', rejectWrite)
                  })
              )
              .then(() => zip.readEntry())
              .catch((e) => finish(e))
          })
        } catch (e) {
          finish(e)
        }
      })

      zip.on('end', () => {
        if (!manifestRaw) {
          finish(
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.manifest_not_at_root'
            )
          )
          return
        }
        if (!hasDefaultBundle || !defaultBundleSha256) {
          finish(
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.bundle_missing'
            )
          )
          return
        }
        finish(null, {
          bundleSha256: defaultBundleSha256,
          manifestRaw,
          totalUncompressed: scan.totalUncompressed,
        })
      })

      zip.on('error', (e: Error) => {
        if (isZipSlipYauzlError(e.message)) {
          finish(
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.zip_slip'
            )
          )
        } else {
          finish(e)
        }
      })
      zip.readEntry()
    })
  })
}

export async function extractMoext(
  moextPath: string,
  destDir: string
): Promise<ExtractResult> {
  return extractLoadedMoext(await loadMoext(moextPath), destDir)
}

/**
 * In-memory single-entry reader for an already-loaded .moext buffer. Used by
 * the Firefox-packed-XPI read path (2026-07-18 design §4): once the bundle's
 * detached signature has been verified, both the manifest and the executed
 * code are pulled from THESE verified bytes rather than the separately
 * tamperable extracted tree. Returns `null` when the entry is absent (not an
 * error — callers decide whether a missing manifest/main is fatal).
 *
 * Mirrors extractMoext's yauzl idioms (lazyEntries, openReadStream, the
 * zip-slip error translation) but never touches the filesystem — the whole
 * point is that this is an alternative to trusting the extracted tree.
 */
export async function readMoextEntry(
  bytes: Buffer,
  entryName: string
): Promise<Buffer | null> {
  assertSafeEntryName(entryName)

  return new Promise<Buffer | null>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(
          openErr ??
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.zip_invalid'
            )
        )
        return
      }
      let settled = false

      const finish = (err: unknown, value?: Buffer | null) => {
        if (settled) return
        settled = true
        zip.close()
        if (err) reject(err)
        else resolve(value ?? null)
      }

      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          assertSafeEntryName(entry.fileName)
          const isDir = /\/$/.test(entry.fileName)
          if (isDir || entry.fileName !== entryName) {
            zip.readEntry()
            return
          }
          if (entry.uncompressedSize > BUNDLE_SIZE_MAX) {
            finish(
              new AppError(
                ErrorCode.PluginManifestInvalid,
                'plugin.manifest.bundle_too_large'
              )
            )
            return
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              finish(
                streamErr ??
                  new AppError(
                    ErrorCode.PluginManifestInvalid,
                    'plugin.install.zip_invalid'
                  )
              )
              return
            }
            const chunks: Buffer[] = []
            let written = 0
            stream.on('data', (chunk: Buffer) => {
              written += chunk.length
              if (written > BUNDLE_SIZE_MAX) {
                stream.destroy()
                finish(
                  new AppError(
                    ErrorCode.PluginManifestInvalid,
                    'plugin.manifest.bundle_too_large'
                  )
                )
                return
              }
              chunks.push(chunk)
            })
            stream.on('end', () => finish(null, Buffer.concat(chunks)))
            stream.on('error', (e) => finish(e))
          })
        } catch (e) {
          finish(e)
        }
      })

      zip.on('end', () => finish(null, null))

      zip.on('error', (e: Error) => {
        if (isZipSlipYauzlError(e.message)) {
          finish(
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.zip_slip'
            )
          )
        } else {
          finish(e)
        }
      })
      zip.readEntry()
    })
  })
}
