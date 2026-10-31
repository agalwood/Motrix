import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type BInput, encode, parseTorrent } from '../src/index.js'

const digest = (algorithm: string, bytes: Uint8Array) =>
  new Uint8Array(createHash(algorithm).update(bytes).digest())
const sha256 = (bytes: Uint8Array) => digest('sha256', bytes)
const concat = (...bytes: Uint8Array[]) => new Uint8Array(Buffer.concat(bytes))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const pieceLength = 16384
function vector(hybrid = false, size = pieceLength) {
  const data = new Uint8Array(size * 2 + 1).fill(7)
  const zero = new Uint8Array(32)
  const blockHashes = Array.from(
    { length: Math.ceil(data.length / 16384) },
    (_, i) => sha256(data.subarray(i * 16384, (i + 1) * 16384))
  )
  let width = 1
  while (width < blockHashes.length) width *= 2
  let layer = [
    ...blockHashes,
    ...Array.from({ length: width - blockHashes.length }, () => zero),
  ]
  let pieceHashes = layer
  for (let blockSize = 16384; layer.length > 1; blockSize *= 2) {
    if (blockSize === size) pieceHashes = layer
    layer = Array.from({ length: layer.length / 2 }, (_, i) =>
      sha256(concat(layer[i * 2]!, layer[i * 2 + 1]!))
    )
  }
  const root = layer[0]!
  const info: Record<string, BInput> = {
    name: 'file',
    'meta version': 2,
    'piece length': size,
    'file tree': { file: { '': { length: data.length, 'pieces root': root } } },
  }
  if (hybrid) {
    info.length = data.length
    info.pieces = concat(
      ...Array.from({ length: Math.ceil(data.length / size) }, (_, i) =>
        digest('sha1', data.subarray(i * size, (i + 1) * size))
      )
    )
  }
  const metainfo: Record<string, BInput> = {
    info,
    'piece layers': new Map([
      [root, concat(...pieceHashes.slice(0, Math.ceil(data.length / size)))],
    ]),
  }
  return { info, metainfo, root, data }
}
describe('torrent metadata and integrity', () => {
  it.each([false, true])(
    'verifies independent Node crypto v2 roots, hybrid=%s',
    (hybrid) => {
      for (const size of [16384, 32768, 65536]) {
        const v = vector(hybrid, size)
        const bytes = encode(v.metainfo)
        const parsed = parseTorrent(bytes)
        expect(parsed.identity).toEqual(
          hybrid
            ? {
                kind: 'hybrid',
                sha1: hex(digest('sha1', encode(v.info))),
                sha256: hex(sha256(encode(v.info))),
              }
            : { kind: 'v2', sha256: hex(sha256(encode(v.info))) }
        )
        expect(parsed.v2?.pieceLayers.get(hex(v.root))?.length).toBe(3)
        expect(parsed.infoBytes.buffer).toBe(bytes.buffer)
        expect(parsed.v2?.files[0]?.length).toBe(BigInt(v.data.length))
      }
    }
  )
  it('rejects forged, truncated, missing and unreferenced piece layers', () => {
    for (const mode of ['forged', 'short', 'missing', 'extra']) {
      const v = vector()
      const layers = v.metainfo['piece layers'] as Map<Uint8Array, Uint8Array>
      const original = layers.get(v.root)!
      if (mode === 'forged') original[0] = original[0]! ^ 1
      if (mode === 'short') layers.set(v.root, original.subarray(32))
      if (mode === 'missing') layers.clear()
      if (mode === 'extra') layers.set(new Uint8Array(32), new Uint8Array(32))
      expect(() => parseTorrent(encode(v.metainfo))).toThrow()
    }
  })
  it('validates hybrid ordering, offsets, padding and content equality', () => {
    const root = sha256(new Uint8Array([1]))
    const info: Record<string, BInput> = {
      name: 'root',
      'meta version': 2,
      'piece length': pieceLength,
      'file tree': {
        a: { '': { length: 1, 'pieces root': root } },
        b: { '': { length: 1, 'pieces root': root } },
      },
      files: [
        { length: 1, path: ['a'] },
        { length: 16383, attr: 'p', path: ['.pad', '16383'] },
        { length: 1, path: ['b'] },
      ],
      pieces: new Uint8Array(40),
    }
    const parsed = parseTorrent(encode({ info }))
    expect(parsed.v1?.files[1]?.padding).toBe(true)
    expect(parsed.v2?.files.map((f) => f.offset)).toEqual([0n, 16384n])
    for (const files of [
      [
        { length: 1, path: ['a'] },
        { length: 1, path: ['b'] },
      ],
      [
        { length: 1, path: ['b'] },
        { length: 16383, attr: 'p', path: ['.pad', '16383'] },
        { length: 1, path: ['a'] },
      ],
    ])
      expect(() =>
        parseTorrent(encode({ info: { ...info, files: files as BInput[] } }))
      ).toThrow()
  })
  it('retains raw unsafe paths, private policy, tiers, extensions and creation data', () => {
    const raw = new Uint8Array([255, 47, 0])
    const bytes = encode({
      announce: 'fallback',
      'announce-list': [['one', 'two'], ['three']],
      'url-list': ['https://seed/'],
      comment: 'note',
      'created by': 'creator',
      'creation date': 42,
      extension: { future: 'kept' },
      info: {
        name: 'root',
        files: [{ length: 0, path: ['..', raw], attr: 'xhZ' }],
        private: 1,
        'piece length': 16384,
        pieces: new Uint8Array(),
      },
    })
    const parsed = parseTorrent(bytes)
    expect(parsed.private).toBe(true)
    expect(parsed.announceTiers).toEqual([['one', 'two'], ['three']])
    expect(parsed.webSeeds).toEqual(['https://seed/'])
    expect(parsed.v1?.files[0]?.path[1]).toEqual(raw)
    expect(parsed.creationDate).toBe(42n)
    expect(parsed.metainfo.has('extension')).toBe(true)
    expect(encode(parsed.metainfo)).toEqual(bytes)
  })
  it('requires name, sane piece counts, valid scalars and supported versions', () => {
    const base = {
      name: 'a',
      length: 1,
      pieces: new Uint8Array(20),
      'piece length': 16384,
    }
    for (const info of [
      { ...base, name: '' },
      { ...base, length: -1 },
      { ...base, pieces: new Uint8Array() },
      { ...base, 'piece length': 0 },
      { ...base, files: [] },
      { ...base, private: 2 },
    ])
      expect(() => parseTorrent(encode({ info }))).toThrow()
    const { name: _, ...withoutName } = base
    expect(() => parseTorrent(encode({ info: withoutName }))).toThrow(/name/)
    expect(() => parseTorrent(encode({ info: { 'meta version': 3 } }))).toThrow(
      /version/
    )
  })
  it.each(['x', 'h', 'z', 'xxhZ'])(
    'accepts hybrid hint attributes %s without changing either file view',
    (attributes) => {
      const data = new Uint8Array([97])
      const bytes = encode({
        info: {
          name: 'a',
          length: 1,
          attr: attributes,
          'piece length': 16384,
          pieces: digest('sha1', data),
          'meta version': 2,
          'file tree': {
            a: { '': { length: 1, 'pieces root': sha256(data) } },
          },
        },
      })
      const parsed = parseTorrent(bytes)
      expect(parsed.identity.kind).toBe('hybrid')
      expect(parsed.v1?.files[0]?.attributes).toBe(attributes)
      expect(parsed.v2?.files[0]?.attributes).toBe('')
      expect(parsed.v1?.files[0]?.length).toBe(parsed.v2?.files[0]?.length)
    }
  )

  it('keeps hybrid symlink semantics and targets strict when hints differ', () => {
    const data = new Uint8Array([97])
    const files: BInput[] = [
      { path: ['link'], length: 0, attr: 'lhZ', 'symlink path': ['target'] },
      { path: ['target'], length: 1 },
    ]
    const info = {
      name: 'root',
      'meta version': 2,
      'piece length': 16384,
      pieces: digest('sha1', data),
      files,
      'file tree': {
        link: { '': { length: 0, attr: 'l', 'symlink path': ['target'] } },
        target: { '': { length: 1, 'pieces root': sha256(data) } },
      },
    } satisfies BInput
    expect(parseTorrent(encode({ info })).identity.kind).toBe('hybrid')
    for (const link of [
      { length: 0 },
      { length: 0, attr: 'l', 'symlink path': ['elsewhere'] },
    ] as BInput[]) {
      expect(() =>
        parseTorrent(
          encode({
            info: {
              ...info,
              'file tree': { ...info['file tree'], link: { '': link } },
            },
          })
        )
      ).toThrow(/Hybrid/)
    }
  })

  it.each([14, 31, 49, 50, 51, 52])(
    'checks v2 powers of two exactly near 2**%i',
    (exponent) => {
      const data = new Uint8Array([97])
      const make = (size: number) =>
        encode({
          info: {
            name: 'a',
            'meta version': 2,
            'piece length': size,
            'file tree': {
              a: { '': { length: 1, 'pieces root': sha256(data) } },
            },
          },
        })
      expect(parseTorrent(make(2 ** exponent)).pieceLength).toBe(2 ** exponent)
      expect(() => parseTorrent(make(2 ** exponent - 1))).toThrow(
        /power of two/
      )
      expect(() => parseTorrent(make(2 ** exponent + 1))).toThrow(
        /power of two/
      )
    }
  )

  it('preserves declared v1 file order and detects exact binary path conflicts', () => {
    const make = (files: BInput[]) =>
      encode({
        info: {
          name: 'root',
          files,
          'piece length': 16384,
          pieces: new Uint8Array(),
        },
      })
    const files = [
      { path: [new Uint8Array([255])], length: 0 },
      { path: [new Uint8Array([0])], length: 0 },
    ]
    const parsed = parseTorrent(make(files))
    expect(parsed.v1?.files.map((file) => [...file.path[0]!])).toEqual([
      [255],
      [0],
    ])
    expect(() =>
      parseTorrent(
        make([...files, { path: [new Uint8Array([255])], length: 0 }])
      )
    ).toThrow(/Conflicting/)
    expect(() =>
      parseTorrent(
        make([
          { path: ['a', 'b'], length: 0 },
          { path: ['a'], length: 0 },
        ])
      )
    ).toThrow(/file\/directory/)
    const pads = [
      { path: ['.pad', '0'], length: 0, attr: 'p' },
      { path: ['.pad', '0'], length: 0, attr: 'p' },
    ]
    expect(parseTorrent(make(pads)).v1?.files).toHaveLength(2)
    expect(() =>
      parseTorrent(make([pads[0]!, { path: ['.pad', '0'], length: 0 }]))
    ).toThrow(/Conflicting/)
  })

  it('hashes original unsorted v1 info bytes, never a canonical reconstruction', () => {
    const rawInfo = Buffer.concat([
      Buffer.from('d4:name1:a6:lengthi1e12:piece lengthi16384e6:pieces20:'),
      Buffer.alloc(20),
      Buffer.from('e'),
    ])
    const bytes = Buffer.concat([
      Buffer.from('d4:info'),
      rawInfo,
      Buffer.from('e'),
    ])
    const parsed = parseTorrent(bytes, { allowUnsortedKeys: true })
    expect(parsed.identity).toEqual({
      kind: 'v1',
      sha1: hex(digest('sha1', rawInfo)),
    })
    expect(parsed.infoBytes).toEqual(rawInfo)
  })
})
