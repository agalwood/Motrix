import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bencodeEncode } from './bencode'
import {
  collectSourceFiles,
  createTorrent,
  isValidPieceLength,
  suggestPieceLength,
} from './create-torrent'

const sha1 = (data: string | Uint8Array) =>
  createHash('sha1').update(data).digest('hex')

describe('bencodeEncode', () => {
  it('encodes the canonical spec example byte-exactly', () => {
    // {'bar': 'spam', 'foo': 42} → d3:bar4:spam3:fooi42ee
    const bytes = bencodeEncode({ bar: 'spam', foo: 42 })
    expect(Buffer.from(bytes).toString('latin1')).toBe('d3:bar4:spam3:fooi42ee')
  })

  it('sorts dict keys by UTF-8 byte order', () => {
    // 'Z' (0x5A) sorts before 'a' (0x61)
    const bytes = bencodeEncode({ a: 1, Z: 2 })
    expect(Buffer.from(bytes).toString('latin1')).toBe('d1:Zi2e1:ai1ee')
  })

  it('encodes nested lists, bytes, and skips undefined/null values', () => {
    const bytes = bencodeEncode({
      list: ['a', 1, new Uint8Array([1, 2, 3])],
      skipMe: undefined,
      skipMeToo: null,
    })
    expect(Buffer.from(bytes).toString('latin1')).toBe(
      'd4:listl1:ai1e3:\u0001\u0002\u0003ee'
    )
  })

  it('rejects non-integer numbers', () => {
    expect(() => bencodeEncode({ x: 1.5 })).toThrow(TypeError)
  })
})

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
    expect(result.infoHash).toBe(sha1(bencodeEncode(info)))
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
    expect(raw).toContain('7:privatei1e')
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
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
  })

  it('produces bytes that parse-torrent reads back with matching infohash', async () => {
    const { default: parseTorrent } = await import('parse-torrent')
    const result = await createTorrent({
      sourcePath: path.join(dir, 'payload.bin'),
      pieceLength: 16 * 1024,
      trackers: ['https://tracker.example/announce'],
      comment: 'roundtrip',
    })
    const parsed = await parseTorrent(new Uint8Array(result.bytes))
    expect(parsed.infoHash).toBe(result.infoHash)
    expect(parsed.name).toBe('payload.bin')
    expect(parsed.length).toBe(3)
    expect(parsed.announce?.[0]).toBe('https://tracker.example/announce')
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

  it('rejects invalid piece lengths', async () => {
    await expect(
      createTorrent({
        sourcePath: path.join(dir, 'payload.bin'),
        pieceLength: 15000,
      })
    ).rejects.toThrow(TypeError)
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
