import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HttpFixture {
  baseUrl: string
  fileUrl: string
  fileSize: number
  close: () => Promise<void>
}

interface StartOptions {
  /** Size of the served test file in bytes. Defaults to 1MB. */
  size?: number
  /** Path the file is served at. Defaults to /test.bin. */
  pathname?: string
  /**
   * Optional throttle. When set, the response body is streamed in
   * ~100ms slices at the target rate. Useful for lifecycle tests
   * that need to observe the Downloading state — without throttling
   * a 1MB localhost transfer completes faster than aria2's poll
   * interval, so the renderer never paints a Downloading row.
   */
  throttleBytesPerSecond?: number
}

/**
 * Starts a hermetic HTTP server on a random localhost port that serves
 * a deterministic byte buffer. Lets add-download e2e specs avoid
 * hitting the public internet (and the flake / privacy concerns that
 * come with it).
 *
 * The buffer is generated fresh per call so no two fixtures hash to
 * the same file — useful when an aria2 cache or BT swarm test would
 * otherwise dedupe.
 */
export async function startHttpFixture(
  opts: StartOptions = {}
): Promise<HttpFixture> {
  const size = opts.size ?? 1024 * 1024
  const pathname = opts.pathname ?? '/test.bin'
  const payload = crypto.randomBytes(size)

  const throttle = opts.throttleBytesPerSecond
  const server = http.createServer(async (req, res) => {
    if (req.url !== pathname) {
      res.writeHead(404).end()
      return
    }

    const rangeMatch = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    const rangeStart = rangeMatch ? Number(rangeMatch[1]) : 0
    const requestedEnd =
      rangeMatch?.[2] === undefined || rangeMatch[2] === ''
        ? payload.length - 1
        : Number(rangeMatch[2])
    if (
      !Number.isSafeInteger(rangeStart) ||
      !Number.isSafeInteger(requestedEnd) ||
      rangeStart < 0 ||
      rangeStart >= payload.length ||
      requestedEnd < rangeStart
    ) {
      res.writeHead(416, {
        'Content-Range': `bytes */${payload.length}`,
      })
      res.end()
      return
    }

    const rangeEnd = Math.min(requestedEnd, payload.length - 1)
    const body = payload.subarray(rangeStart, rangeEnd + 1)
    res.writeHead(rangeMatch ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'Accept-Ranges': 'bytes',
      ...(rangeMatch
        ? {
            'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${payload.length}`,
          }
        : {}),
    })
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
        await new Promise((r) => setTimeout(r, sliceMs))
      }
    }
    if (!res.destroyed) res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`

  return {
    baseUrl,
    fileUrl: `${baseUrl}${pathname}`,
    fileSize: size,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
