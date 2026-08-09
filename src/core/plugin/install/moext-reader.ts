// Hardened .moext (zip) extractor.
//
// Defenses (rejected at the entry boundary, BEFORE any data is written):
//   - zip-slip:   absolute paths, '..' segments, backslashes
//   - symlinks:   external-file-attribute mode bits indicate a link
//   - oversized:  per-bundle and total caps
//
// Hashing: SHA-256 of `dist/plugin.js` (informational in Phase 1A —
// Phase 2 layers detached signing on top).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import yauzl from 'yauzl'

const BUNDLE_SIZE_MAX = 1 << 20 // 1 MB — limit on dist/plugin.js
const MOEXT_TOTAL_MAX = 5 << 20 // 5 MB — total uncompressed cap
const HASHED_ENTRY = 'dist/plugin.js'
const MANIFEST_ENTRY = 'motrix-plugin.json'
const SYMLINK_MODE = 0o120000

export interface ExtractResult {
  bundleSha256: string
  manifestRaw: string
  totalUncompressed: number
}

function fail(code: string): never {
  throw new AppError(ErrorCode.PluginManifestInvalid, code)
}

// Name-only half of the zip-slip guard: reject '..' segments, absolute paths,
// and backslashes regardless of whether the caller is writing to disk
// (extractMoext) or reading a single entry into memory (readMoextEntry).
function assertSafeEntryName(entryName: string): void {
  if (
    entryName.includes('..') ||
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

export async function extractMoext(
  moextPath: string,
  destDir: string
): Promise<ExtractResult> {
  const fileStat = await stat(moextPath)
  if (fileStat.size > MOEXT_TOTAL_MAX) {
    fail('plugin.manifest.bundle_too_large')
  }
  await mkdir(destDir, { recursive: true })

  return new Promise<ExtractResult>((resolve, reject) => {
    yauzl.open(moextPath, { lazyEntries: true }, (openErr, zip) => {
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
      let bundleHash: string | null = null
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
          const isBundle = entry.fileName === HASHED_ENTRY
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
                    const ws = createWriteStream(target)
                    const hash = isBundle ? createHash('sha256') : null
                    const manifestChunks: Buffer[] | null =
                      entry.fileName === MANIFEST_ENTRY ? [] : null
                    let written = 0
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
                      if (hash) hash.update(chunk)
                      if (manifestChunks) manifestChunks.push(chunk)
                      ws.write(chunk)
                    })
                    stream.on('end', () => {
                      ws.end(() => {
                        if (hash) bundleHash = hash.digest('hex')
                        if (manifestChunks) {
                          manifestRaw =
                            Buffer.concat(manifestChunks).toString('utf8')
                        }
                        res()
                      })
                    })
                    stream.on('error', rej)
                    ws.on('error', rej)
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
        if (!bundleHash) {
          finish(
            new AppError(
              ErrorCode.PluginManifestInvalid,
              'plugin.install.bundle_missing'
            )
          )
          return
        }
        finish(null, {
          bundleSha256: bundleHash,
          manifestRaw,
          totalUncompressed,
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
