import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encode, parseTorrent } from '@motrix/torrent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  collectSourceFiles,
  createTorrent,
  isValidPieceLength,
  suggestPieceLength,
} from './create-torrent'

const sha1 = (data: string | Uint8Array) =>
  createHash('sha1').update(data).digest('hex')

describe('collectSourceFiles', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'motrix-create-torrent-'))
    await writeFile(path.join(dir, 'single.bin'), 'abc')
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('maps a single file to a one-entry list', async () => {
    const result = await collectSourceFiles(path.join(dir, 'single.bin'))
    expect(result.name).toBe('single.bin')
    expect(result.files).toHaveLength(1)
    expect(result.totalSize).toBe(3)
  })
})

describe('createTorrent', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'motrix-create-torrent-'))
    await writeFile(path.join(dir, 'payload.bin'), 'abc')
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('hashes a known payload: pieces = SHA-1("abc")', async () => {
    const result = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
    })
    // 'abc' → a9993e364706816aba3e25717850c26c9cd0d89d (FIPS vector)
    const abcDigest = createHash('sha1').update('abc').digest()
    expect(Buffer.from(result.bytes).indexOf(abcDigest)).toBeGreaterThan(-1)
    expect(result.pieceCount).toBe(1)
    expect(result.totalSize).toBe(3)
    // infoHash = SHA-1 of the exact info dict the encoder produced
    const info = {
      length: 3,
      name: 'payload.bin',
      'piece length': 16 * 1024,
      pieces: createHash('sha1').update('abc').digest(),
    }
    expect(result.infoHash).toBe(sha1(encode(info)))
  })

  it('emits progress covering the full size', async () => {
    const seen: Array<[number, number]> = []
    await createTorrent(
      { sourcePath: path.join(dir, 'payload.bin'), pieceLength: 16 * 1024 },
      { onProgress: (processed, total) => seen.push([processed, total]) }
    )
    expect(seen.at(-1)).toEqual([3, 3])
    expect(seen.every(([, total]) => total === 3)).toBe(true)
  })

  it('includes announce/announce-list, comment, and private flags', async () => {
    const result = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
      trackers: ['https://tracker.example/announce', 'udp://t2.example:1337'],
      comment: 'made by tests',
      private: true,
    })
    const raw = Buffer.from(result.bytes).toString('latin1')
    expect(raw).toContain('8:announce32:https://tracker.example/announce')
    expect(raw).toContain('13:announce-list')
    expect(raw).toContain('7:comment13:made by tests')
    expect(parseTorrent(result.bytes).private).toBe(true)
  })

  it('omits announce entirely for DHT-only torrents', async () => {
    const result = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
    })
    expect(Buffer.from(result.bytes).toString('latin1')).not.toContain(
      'announce'
    )
  })

  it('concatenates pieces across file boundaries in sorted order', async () => {
    const folder = path.join(dir, 'multi')
    await mkdir(folder)
    await writeFile(path.join(folder, 'a.bin'), 'hello ')
    await writeFile(path.join(folder, 'b.bin'), 'world')
    const result = await createTorrent({
      sourcePath: folder,
      pieceLength: 16 * 1024,
    })
    // One piece spanning both files = sha1('hello world')
    const helloWorldDigest = createHash('sha1').update('hello world').digest()
    expect(Buffer.from(result.bytes).indexOf(helloWorldDigest)).toBeGreaterThan(
      -1
    )
    expect(result.fileCount).toBe(2)
    const raw = Buffer.from(result.bytes).toString('latin1')
    expect(raw).toContain('6:lengthi6e4:pathl5:a.bine')
    expect(raw).toContain('6:lengthi5e4:pathl5:b.bine')
  })

  it('is deterministic apart from the creation date', async () => {
    const a = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
      comment: 'x',
    })
    const b = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
      comment: 'x',
    })
    expect(a.infoHash).toBe(b.infoHash)
    expect(parseTorrent(a.bytes).infoBytes).toEqual(
      parseTorrent(b.bytes).infoBytes
    )
  })

  it('produces bytes that parse-torrent reads back with matching infohash', async () => {
    const result = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
      trackers: ['https://tracker.example/announce'],
      comment: 'roundtrip',
    })
    const parsed = parseTorrent(new Uint8Array(result.bytes))
    expect(parsed.identity).toMatchObject({ sha1: result.infoHash })
    expect(parsed.name).toBe('payload.bin')
    expect(parsed.v1?.length).toBe(3n)
    expect(parsed.announce).toBe('https://tracker.example/announce')
  })

  it('handles a zero-byte file with an empty pieces string', async () => {
    await writeFile(path.join(dir, 'empty.bin'), '')
    const result = await createTorrent({
      sourcePath: path.join(dir, 'empty.bin'),
      pieceLength: 16 * 1024,
    })
    // Zero pieces → 'pieces' must be a zero-length byte string, not
    // sha1('') — the empty digest would be 20 bytes of bogus data.
    const raw = Buffer.from(result.bytes).toString('latin1')
    expect(raw).toContain('6:pieces0:')
    expect(result.pieceCount).toBe(0)
  })

  it('hashes individual pieces across file boundaries including the final tail', async () => {
    const src = path.join(dir, 'split')
    await mkdir(src)
    const chunk = 32768
    const data = Buffer.concat([
      Buffer.alloc(chunk, 1),
      Buffer.alloc(chunk, 2),
      Buffer.from('tail'),
    ])
    await writeFile(path.join(src, 'a'), data.subarray(0, 17001))
    await writeFile(path.join(src, 'b'), data.subarray(17001))
    const result = await createTorrent({ sourcePath: src, pieceLength: chunk })
    const parsed = parseTorrent(result.bytes)
    expect(parsed.v1?.pieces.length).toBe(3)
    for (let i = 0; i < 3; i++)
      expect(parsed.v1?.pieces.hex(i)).toBe(
        sha1(data.subarray(i * chunk, (i + 1) * chunk))
      )
  })

  it('preserves directory shape even with a single nested file and distinguishes private swarms', async () => {
    const src = path.join(dir, 'one')
    await mkdir(path.join(src, 'nested'), { recursive: true })
    await writeFile(path.join(src, 'nested', 'x'), 'abc')
    const opts = {
      sourcePath: src,
      trackers: ['https://tracker.example/announce'],
      webSeeds: ['https://seed.example/'],
    }
    const publicResult = await createTorrent(opts)
    const result = await createTorrent({ ...opts, private: true })
    const parsed = parseTorrent(result.bytes)
    expect(parsed.v1?.multiFile).toBe(true)
    expect(
      parsed.v1?.files[0].path.map((p) => new TextDecoder().decode(p))
    ).toEqual(['nested', 'x'])
    expect(parsed.webSeeds).toEqual(opts.webSeeds)
    expect(parsed.private).toBe(true)
    expect(publicResult.infoHash).not.toBe(result.infoHash)
  })

  it('rejects a source modified while being hashed', async () => {
    const { truncateSync } = await import('node:fs')
    const file = path.join(dir, 'changing')
    await writeFile(file, Buffer.alloc(2 * 1024 ** 2))
    await expect(
      createTorrent(
        { sourcePath: file },
        {
          onProgress(done, total) {
            if (done < total) truncateSync(file, 0)
          },
        }
      )
    ).rejects.toThrow('changed')
  })
  it('rejects invalid piece lengths', async () => {
    await expect(
      createTorrent({
        sourcePath: path.join(dir, 'payload.bin'),
        pieceLength: 15000,
      })
    ).rejects.toThrow()
  })
})

describe('piece length helpers', () => {
  it('suggests larger pieces for larger inputs', () => {
    expect(suggestPieceLength(1024)).toBe(32 * 1024)
    expect(suggestPieceLength(4 * 1024 * 1024 * 1024)).toBe(2 * 1024 * 1024)
  })

  it('validates powers of two within bounds', () => {
    expect(isValidPieceLength(16 * 1024)).toBe(true)
    expect(isValidPieceLength(15 * 1024)).toBe(false)
    expect(isValidPieceLength(32 * 1024 * 1024)).toBe(false)
  })
})
