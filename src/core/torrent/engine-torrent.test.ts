import { readFileSync } from 'node:fs'
import { encode } from '@motrix/torrent'
import { ErrorCode } from '@shared/errors'
import {
  parseEngineTorrent,
  torrentFileErrorKey,
  UnsupportedTorrentError,
} from '@shared/lib/engine-torrent'
import { describe, expect, it } from 'vitest'

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(`./__fixtures__/libtorrent/${name}.torrent`, import.meta.url)
    )
  )
describe('current engine torrent capability projection', () => {
  it('selects v1 identity for hybrid and rejects v2 without truncating its SHA-256 hash', async () => {
    const parsed = await parseEngineTorrent(fixture('v2'))
    expect(parsed.identity.kind).toBe('hybrid')
    expect(parsed.infoHash).toHaveLength(40)
    await expect(parseEngineTorrent(fixture('v2-only'))).rejects.toMatchObject({
      code: ErrorCode.EngineFeatureUnavailable,
    })
    await expect(
      parseEngineTorrent(`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`)
    ).rejects.toBeInstanceOf(UnsupportedTorrentError)
    expect(torrentFileErrorKey(new UnsupportedTorrentError('v2'))).toBe(
      'task.add.unsupportedTorrent'
    )
  })
  it('uses aria2 utf-8 extensions while preserving boundaries and original metadata bytes', async () => {
    const bytes = encode({
      info: {
        name: new Uint8Array([255]),
        'name.utf-8': 'root',
        'piece length': 16384,
        pieces: new Uint8Array(),
        files: [
          { length: 0, path: [new Uint8Array([255])], 'path.utf-8': ['a/b'] },
        ],
      },
    })
    const original = bytes.slice()
    const parsed = await parseEngineTorrent(bytes)
    expect(parsed.files?.[0]?.pathComponents).toEqual(['root', 'a/b'])
    expect(bytes).toEqual(original)
  })
  it('rejects invalid UTF-8 and preserves a literal leading BOM in filenames', async () => {
    const info = {
      name: new Uint8Array([255]),
      length: 0,
      'piece length': 1,
      pieces: new Uint8Array(),
    }
    await expect(parseEngineTorrent(encode({ info }))).rejects.toThrow()
    expect(
      (
        await parseEngineTorrent(
          encode({ info: { ...info, name: '\uFEFFfile' } })
        )
      ).name
    ).toBe('\uFEFFfile')
  })
  it('rejects unsorted info that aria2 would rehash, but accepts unsorted outer metadata', async () => {
    const utf8 = new TextEncoder()
    const info = 'd4:name1:a6:lengthi0e12:piece lengthi16384e6:pieces0:e'
    await expect(
      parseEngineTorrent(utf8.encode(`d4:info${info}e`))
    ).rejects.toBeInstanceOf(UnsupportedTorrentError)
    const canonicalInfo =
      'd6:lengthi0e4:name1:a12:piece lengthi16384e6:pieces0:e'
    const parsed = await parseEngineTorrent(
      utf8.encode(`d4:info${canonicalInfo}7:comment4:notee`)
    )
    expect(parsed.name).toBe('a')
    expect(parsed.comment).toBe('note')
  })

  it('rejects metadata with file lengths beyond engine precision', async () => {
    const bytes = encode({
      info: {
        name: 'huge',
        length: 9007199254740993n,
        'piece length': 9007199254740991n,
        pieces: new Uint8Array(40),
      },
    })
    await expect(parseEngineTorrent(bytes)).rejects.toBeInstanceOf(
      UnsupportedTorrentError
    )
  })
})
