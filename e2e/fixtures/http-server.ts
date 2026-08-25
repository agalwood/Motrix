import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HttpRequestRecord {
  sequence: number
  pathname: string
  method: string
  range: string | null
  ifRange: string | null
  status: number
  etag: string
  resourceVersion: number
}

export interface HttpResourceSnapshot {
  etag: string
  sha256: string
  version: number
}

export interface HttpFixture {
  baseUrl: string
  fileUrl: string
  fileSize: number
  /** SHA-256 of the resource currently served by `fileUrl`. */
  readonly payloadSha256: string
  requests: () => readonly HttpRequestRecord[]
  resetRequests: () => void
  setRangeSupport: (supported: boolean) => void
  /** Swap in a different same-size resource, simulating a changed origin. */
  changeResource: (etag?: string) => HttpResourceSnapshot
  verifyFile: (filePath: string) => Promise<boolean>
  close: () => Promise<void>
}

export interface HttpFixtureOptions {
  /** Size of the served test file in bytes. Defaults to 1MB. */
  size?: number
  /** Path the file is served at. Defaults to /test.bin. */
  pathname?: string
  /** Fixed ETag for the initial resource. Quotes are added when omitted. */
  etag?: string
  /** Whether byte ranges are honored. Defaults to true. */
  rangeSupport?: boolean
  /**
   * Optional throttle. When set, the response body is streamed in
   * ~100ms slices at the target rate. Useful for lifecycle tests
   * that need to observe the Downloading state — without throttling
   * a 1MB localhost transfer completes faster than aria2's poll
   * interval, so the renderer never paints a Downloading row.
   */
  throttleBytesPerSecond?: number
}

function quoteEtag(value: string): string {
  const trimmed = value.trim()
  if (/^(?:W\/)?".*"$/.test(trimmed)) return trimmed
  return `"${trimmed}"`
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * Starts a hermetic HTTP server on a random localhost port that serves
 * a deterministic-size byte buffer. Besides serving Range requests, the
 * fixture records the protocol decisions made for every request so recovery
 * specs can distinguish a real resume from a fresh download.
 *
 * The buffer is generated fresh per call so no two fixtures hash to
 * the same file — useful when an aria2 cache or BT swarm test would
 * otherwise dedupe.
 */
export async function startHttpFixture(
  opts: HttpFixtureOptions = {}
): Promise<HttpFixture> {
  const size = opts.size ?? 1024 * 1024
  const pathname = opts.pathname ?? '/test.bin'
  let payload = crypto.randomBytes(size)
  let etag = quoteEtag(opts.etag ?? `motrix-e2e-${crypto.randomUUID()}`)
  let resourceVersion = 1
  let rangeSupport = opts.rangeSupport ?? true
  let sequence = 0
  const requests: HttpRequestRecord[] = []

  const record = (
    req: http.IncomingMessage,
    status: number,
    responseEtag = etag,
    responseVersion = resourceVersion
  ): void => {
    requests.push({
      sequence: ++sequence,
      pathname: req.url ?? '',
      method: req.method ?? 'GET',
      range: req.headers.range ?? null,
      ifRange: firstHeader(req.headers['if-range']),
      status,
      etag: responseEtag,
      resourceVersion: responseVersion,
    })
  }

  const commonHeaders = (
    contentLength: number,
    responseEtag: string,
    supportsRanges: boolean
  ): Record<string, string> => ({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(contentLength),
    'Accept-Ranges': supportsRanges ? 'bytes' : 'none',
    ETag: responseEtag,
  })

  const throttle = opts.throttleBytesPerSecond
  const server = http.createServer(async (req, res) => {
    // Capture an immutable response snapshot: changeResource() may be called
    // while a throttled response is still draining.
    const responsePayload = payload
    const responseEtag = etag
    const responseVersion = resourceVersion
    const supportsRanges = rangeSupport

    if (req.url !== pathname) {
      record(req, 404, responseEtag, responseVersion)
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      record(req, 405, responseEtag, responseVersion)
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }

    const rangeHeader = req.headers.range
    const rangeMatch = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/)
    const ifRange = firstHeader(req.headers['if-range'])
    const ifRangeMatches = ifRange === null || ifRange === responseEtag
    const honorRange = supportsRanges && Boolean(rangeMatch) && ifRangeMatches

    if (supportsRanges && rangeHeader && !rangeMatch) {
      record(req, 416, responseEtag, responseVersion)
      res.writeHead(416, {
        'Content-Range': `bytes */${responsePayload.length}`,
        'Accept-Ranges': 'bytes',
        ETag: responseEtag,
      })
      res.end()
      return
    }

    const rangeStart = honorRange && rangeMatch ? Number(rangeMatch[1]) : 0
    const requestedEnd =
      honorRange && rangeMatch && rangeMatch[2] !== ''
        ? Number(rangeMatch[2])
        : responsePayload.length - 1
    if (
      honorRange &&
      (!Number.isSafeInteger(rangeStart) ||
        !Number.isSafeInteger(requestedEnd) ||
        rangeStart < 0 ||
        rangeStart >= responsePayload.length ||
        requestedEnd < rangeStart)
    ) {
      record(req, 416, responseEtag, responseVersion)
      res.writeHead(416, {
        'Content-Range': `bytes */${responsePayload.length}`,
        'Accept-Ranges': 'bytes',
        ETag: responseEtag,
      })
      res.end()
      return
    }

    const rangeEnd = honorRange
      ? Math.min(requestedEnd, responsePayload.length - 1)
      : responsePayload.length - 1
    const body = responsePayload.subarray(rangeStart, rangeEnd + 1)
    const status = honorRange ? 206 : 200
    record(req, status, responseEtag, responseVersion)
    res.writeHead(status, {
      ...commonHeaders(body.length, responseEtag, supportsRanges),
      ...(honorRange
        ? {
            'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${responsePayload.length}`,
          }
        : {}),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    if (!throttle || throttle <= 0) {
      res.end(body)
      return
    }
    // Slice into ~10 chunks per second so observers see periodic
    // progress; the math gives `chunkSize * (1000 / sliceMs) === throttle`.
    const sliceMs = 100
    const chunkSize = Math.max(1024, Math.floor((throttle * sliceMs) / 1000))
    let offset = 0
    while (offset < body.length && !res.destroyed) {
      const end = Math.min(offset + chunkSize, body.length)
      const slice = body.subarray(offset, end)
      // Respect backpressure so we don't overrun the socket buffer.
      if (!res.write(slice)) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off('drain', finish)
            res.off('close', finish)
            resolve()
          }
          res.once('drain', finish)
          res.once('close', finish)
        })
      }
      offset = end
      if (offset < body.length && !res.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, sliceMs))
      }
    }
    if (!res.destroyed) res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const fixture: HttpFixture = {
    baseUrl,
    fileUrl: `${baseUrl}${pathname}`,
    fileSize: size,
    get payloadSha256() {
      return sha256(payload)
    },
    requests: () => requests.map((entry) => ({ ...entry })),
    resetRequests: () => {
      requests.length = 0
    },
    setRangeSupport: (supported) => {
      rangeSupport = supported
    },
    changeResource: (nextEtag) => {
      payload = crypto.randomBytes(size)
      resourceVersion++
      etag = quoteEtag(nextEtag ?? `motrix-e2e-${crypto.randomUUID()}`)
      return { etag, sha256: sha256(payload), version: resourceVersion }
    },
    verifyFile: async (filePath) => {
      const contents = await readFile(filePath)
      return contents.length === size && sha256(contents) === sha256(payload)
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // A killed aria2 can leave a throttled HTTP socket open until its
        // kernel close is observed. Tear it down so fixture cleanup is bounded.
        server.closeAllConnections()
      }),
  }
  return fixture
}
