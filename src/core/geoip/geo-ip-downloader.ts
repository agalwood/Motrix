import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import writeFileAtomic from 'write-file-atomic'
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  type DownloadOptions,
  type DownloadProgress,
  type DownloadResult,
} from './types'

const MIN_VALID_SIZE_BYTES = 1024
const MMDB_METADATA_SENTINEL = Buffer.from([0xab, 0xcd, 0xef])
const MMDB_METADATA_TAIL = 'MaxMind.com'

export type ProgressListener = (progress: DownloadProgress) => void

async function cancelResponseBody(
  response: Response,
  reason?: unknown
): Promise<void> {
  try {
    await response.body?.cancel(reason)
  } catch {
    // Preserve the download error when cancellation races a closed body.
  }
}

/**
 * Stream a `.mmdb` file from `url` into `dbPath` atomically.
 *
 * Atomicity is delegated to `write-file-atomic`: the buffered
 * download is written to a sibling tmp file with fsync, then renamed
 * over `dbPath`, so callers never observe a partial file. Progress
 * is emitted at most every {@link DownloadOptions.progressByteThreshold}
 * bytes or {@link DownloadOptions.progressTimeThresholdMs} milliseconds,
 * with a final 100% emission immediately before the install step.
 *
 * Sanity validation: the downloaded buffer must be ≥ 1KB and contain
 * the MMDB metadata marker (`\xab\xcd\xefMaxMind.com`) somewhere in
 * the trailing 128KB. The canonical structural validation happens
 * later in {@link GeoIPService.open} via `mmdb-lib`.
 */
export class GeoIPDownloader {
  constructor(
    private readonly options: DownloadOptions = DEFAULT_DOWNLOAD_OPTIONS
  ) {}

  async download(
    url: string,
    dbPath: string,
    onProgress?: ProgressListener
  ): Promise<DownloadResult> {
    await mkdir(path.dirname(dbPath), { recursive: true })

    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    )

    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
      })
    } catch (err) {
      clearTimeout(timeoutId)
      throw new AppError(
        ErrorCode.GeoIPDownloadFailed,
        `network error: ${(err as Error).message}`,
        err
      )
    }

    let bodyConsumed = false
    try {
      if (!response.ok) {
        throw new AppError(
          ErrorCode.GeoIPDownloadFailed,
          `http ${response.status} ${response.statusText} for ${url}`
        )
      }

      const totalHeader = response.headers.get('content-length')
      const bytesTotal = totalHeader ? Number.parseInt(totalHeader, 10) : -1
      const version = deriveVersion(response.headers)

      let bytesReceived = 0
      let lastEmitBytes = 0
      let lastEmitTime = Date.now()
      const chunks: Uint8Array[] = []

      const emit = (force = false) => {
        const now = Date.now()
        const elapsed = now - lastEmitTime
        const delta = bytesReceived - lastEmitBytes
        if (
          !force &&
          delta < this.options.progressByteThreshold &&
          elapsed < this.options.progressTimeThresholdMs
        ) {
          return
        }
        lastEmitBytes = bytesReceived
        lastEmitTime = now
        onProgress?.({
          bytesReceived,
          bytesTotal,
          percent: bytesTotal > 0 ? bytesReceived / bytesTotal : -1,
        })
      }

      const body = response.body
      if (!body) {
        throw new AppError(
          ErrorCode.GeoIPDownloadFailed,
          'response body is empty'
        )
      }

      const reader = body.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) {
            chunks.push(value)
            bytesReceived += value.byteLength
            emit(false)
          }
        }
      } finally {
        reader.releaseLock()
      }
      bodyConsumed = true

      const buffer = Buffer.concat(chunks)
      if (buffer.length < MIN_VALID_SIZE_BYTES) {
        throw new AppError(
          ErrorCode.GeoIPDatabaseInvalid,
          `database too small (${buffer.length} bytes)`
        )
      }
      if (!hasMmdbSentinel(buffer)) {
        throw new AppError(
          ErrorCode.GeoIPDatabaseInvalid,
          'MaxMind.com metadata marker not found — file is not a valid .mmdb'
        )
      }

      try {
        // writeFileAtomic handles fsync + rename + tmp cleanup on
        // failure, so we no longer need an explicit unlink in the
        // catch path.
        await writeFileAtomic(dbPath, buffer)
      } catch (err) {
        throw new AppError(
          ErrorCode.GeoIPDownloadFailed,
          `failed to install database: ${(err as Error).message}`,
          err
        )
      }

      onProgress?.({
        bytesReceived,
        bytesTotal: bytesTotal > 0 ? bytesTotal : bytesReceived,
        percent: 1,
      })

      let installedSize = bytesReceived
      try {
        const s = await stat(dbPath)
        installedSize = s.size
      } catch {
        // stat failure is non-fatal: bytesReceived from the stream is a
        // safe approximation for status reporting.
      }

      return { sizeBytes: installedSize, version }
    } catch (error) {
      if (!bodyConsumed) await cancelResponseBody(response, error)
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

/**
 * Walk the buffer's tail looking for the mmdb metadata marker. The
 * canonical mmdb format places metadata in the last ≤ 128KB; we scan
 * that window so a slightly malformed download (extra trailer, etc.)
 * still trips the structural validation in `mmdb-lib` rather than this
 * coarse check.
 */
export function hasMmdbSentinel(buffer: Buffer): boolean {
  const scanFrom = Math.max(0, buffer.length - 128 * 1024)
  const slice = buffer.subarray(scanFrom)
  let idx = slice.indexOf(MMDB_METADATA_SENTINEL)
  while (idx !== -1) {
    const after = slice.toString(
      'utf8',
      idx + MMDB_METADATA_SENTINEL.length,
      idx + MMDB_METADATA_SENTINEL.length + MMDB_METADATA_TAIL.length
    )
    if (after === MMDB_METADATA_TAIL) return true
    idx = slice.indexOf(MMDB_METADATA_SENTINEL, idx + 1)
  }
  return false
}

function deriveVersion(headers: Headers): string {
  const etag = headers.get('etag')
  if (etag) return etag.replace(/"/g, '').slice(0, 64)

  const disp = headers.get('content-disposition')
  if (disp) {
    const m = disp.match(/filename\*?=(?:UTF-8'')?([^;]+)/i)
    if (m) return m[1].replace(/^["']|["']$/g, '').slice(0, 128)
  }

  return new Date().toISOString()
}
