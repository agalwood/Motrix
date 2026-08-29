import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeoIPDownloader, hasMmdbSentinel } from './geo-ip-downloader'

function makeFakeMmdb(extraBytes = 4096): Buffer {
  // Pad with arbitrary bytes, then append the canonical mmdb metadata
  // marker so hasMmdbSentinel passes. The fake buffer is not a real
  // mmdb file — Service tests stub mmdb-lib directly.
  const padding = Buffer.alloc(extraBytes, 0x42)
  const marker = Buffer.from([0xab, 0xcd, 0xef])
  const tail = Buffer.from('MaxMind.com')
  const trailing = Buffer.alloc(64, 0x77)
  return Buffer.concat([padding, marker, tail, trailing])
}

function streamFromBuffer(buf: Buffer, chunkSize = 1024): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0
      while (offset < buf.length) {
        const end = Math.min(offset + chunkSize, buf.length)
        controller.enqueue(buf.subarray(offset, end))
        offset = end
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-length': String(buf.length),
      etag: '"v-2026.05.01"',
    },
  })
}

describe('hasMmdbSentinel', () => {
  it('returns true when the marker is in the tail', () => {
    expect(hasMmdbSentinel(makeFakeMmdb())).toBe(true)
  })

  it('returns false on garbage', () => {
    expect(hasMmdbSentinel(Buffer.alloc(2048, 0x00))).toBe(false)
  })

  it('returns false on a partial marker without the MaxMind.com tail', () => {
    const buf = Buffer.concat([
      Buffer.alloc(2048, 0x00),
      Buffer.from([0xab, 0xcd, 0xef]),
      Buffer.from('NotMaxMind'),
    ])
    expect(hasMmdbSentinel(buf)).toBe(false)
  })
})

describe('GeoIPDownloader.download', () => {
  let tmp: string
  let dbPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'geoip-dl-'))
    dbPath = path.join(tmp, 'GeoLite2-Country.mmdb')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('writes the buffer atomically and reports size + etag-derived version', async () => {
    const buf = makeFakeMmdb(8192)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamFromBuffer(buf))

    const dl = new GeoIPDownloader()
    const progressCalls: number[] = []
    const result = await dl.download(
      'https://example.com/db.mmdb',
      dbPath,
      (p) => progressCalls.push(p.bytesReceived)
    )

    expect(fetchSpy).toHaveBeenCalledOnce()
    const onDisk = await readFile(dbPath)
    expect(onDisk.length).toBe(buf.length)
    expect(result.sizeBytes).toBe(buf.length)
    expect(result.version).toBe('v-2026.05.01')
    expect(progressCalls.length).toBeGreaterThan(0)
    // Final emission is always 100% of received bytes
    expect(progressCalls.at(-1)).toBe(buf.length)
  })

  it('rejects responses smaller than 1KB as invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromBuffer(Buffer.alloc(64, 0xff))
    )
    const dl = new GeoIPDownloader()
    await expect(
      dl.download('https://example.com/db.mmdb', dbPath)
    ).rejects.toThrow(/too small/)
    await expect(stat(dbPath)).rejects.toThrow()
  })

  it('rejects buffers without the MaxMind metadata marker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromBuffer(Buffer.alloc(8192, 0x00))
    )
    const dl = new GeoIPDownloader()
    await expect(
      dl.download('https://example.com/db.mmdb', dbPath)
    ).rejects.toThrow(/MaxMind.com metadata marker/)
    await expect(stat(dbPath)).rejects.toThrow()
  })

  it('surfaces non-2xx responses as download errors', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('not found'))
          },
          cancel,
        }),
        { status: 404, statusText: 'Not Found' }
      )
    )
    const dl = new GeoIPDownloader()
    await expect(
      dl.download('https://example.com/db.mmdb', dbPath)
    ).rejects.toThrow(/http 404/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('releases and cancels the response body when streaming work throws', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024))
          },
          cancel,
        }),
        { status: 200 }
      )
    )
    const dl = new GeoIPDownloader({
      timeoutMs: 60_000,
      progressByteThreshold: 1,
      progressTimeThresholdMs: 250,
    })

    await expect(
      dl.download('https://example.com/db.mmdb', dbPath, () => {
        throw new Error('progress failed')
      })
    ).rejects.toThrow('progress failed')

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('surfaces network failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'))
    const dl = new GeoIPDownloader()
    await expect(
      dl.download('https://example.com/db.mmdb', dbPath)
    ).rejects.toThrow(/network error/)
  })

  it('preserves an existing on-disk DB when the new download fails verification', async () => {
    const existing = makeFakeMmdb(2048)
    await writeFile(dbPath, existing)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromBuffer(Buffer.alloc(8192, 0x00))
    )
    const dl = new GeoIPDownloader()
    await expect(
      dl.download('https://example.com/db.mmdb', dbPath)
    ).rejects.toThrow(/MaxMind.com metadata marker/)
    const stillThere = await readFile(dbPath)
    expect(stillThere.equals(existing)).toBe(true)
  })
})
