// Adapted scenarios from parse-torrent v11.0.24 (MIT, test/LICENSE.upstream).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import reference from 'parse-torrent'
import { describe, expect, it } from 'vitest'
import { type BInput, encode, parseMagnet, parseTorrent } from '../src/index.js'

const text = new TextDecoder()
describe('parse-torrent v11.0.24 legal v1 differential', () => {
  it.each(['alice', 'numbers', 'lots-of-numbers', 'folder'])(
    'matches %s metadata, identity and piece table',
    async (name) => {
      const bytes = new Uint8Array(
        readFileSync(
          new URL(`./fixtures/webtorrent/${name}.torrent`, import.meta.url)
        )
      )
      const old = await reference(bytes)
      const parsed = parseTorrent(bytes)
      expect(parsed.identity).toEqual({ kind: 'v1', sha1: old.infoHash })
      expect(parsed.name).toBe(old.name)
      expect(Number(parsed.v1!.length)).toBe(old.length)
      expect([...new Set(parsed.announceTiers.flat())]).toEqual(old.announce)
      expect(
        parsed.v1!.files.map((f) => ({
          name: f.path.length ? text.decode(f.path.at(-1)) : parsed.name,
          path: [parsed.name, ...f.path.map((p) => text.decode(p))],
          length: Number(f.length),
          offset: Number(f.offset),
        }))
      ).toEqual(
        old.files?.map((file) => ({ ...file, path: file.path.split(path.sep) }))
      )
      expect(
        Array.from({ length: parsed.v1!.pieces.length }, (_, i) =>
          parsed.v1!.pieces.hex(i)
        )
      ).toEqual(old.pieces)
    }
  )
  it('differentially checks generated canonical private and webseed metadata', async () => {
    for (let i = 0; i < 100; i++) {
      const length = i * 1234
      const pieceLength = 16384
      const info: BInput = {
        name: `file-${i}`,
        length,
        'piece length': pieceLength,
        pieces: new Uint8Array(Math.ceil(length / pieceLength) * 20),
        private: i % 2,
      }
      const bytes = encode({
        info,
        'url-list': i % 2 ? ['https://seed/'] : 'https://seed/',
        'announce-list': [['udp://one', 'udp://two'], ['udp://three']],
      })
      const old = await reference(bytes)
      const parsed = parseTorrent(bytes)
      expect(parsed.identity).toEqual({ kind: 'v1', sha1: old.infoHash })
      expect(parsed.private).toBe(old.private)
      expect(parsed.webSeeds).toEqual(old.urlList)
    }
  })
  it('handles empty webseed forms and defines empty announce-list precedence', async () => {
    const info = {
      name: 'empty',
      length: 0,
      'piece length': 16384,
      pieces: new Uint8Array(),
    }
    for (const webseeds of ['', []] as BInput[]) {
      const bytes = encode({ info, 'url-list': webseeds })
      expect(parseTorrent(bytes).webSeeds).toEqual(
        (await reference(bytes)).urlList
      )
    }
    expect(
      parseTorrent(encode({ info, announce: 'udp://fallback' })).announceTiers
    ).toEqual([['udp://fallback']])
    // BEP 12: an explicitly present tier list supersedes announce, including [].
    expect(
      parseTorrent(
        encode({ info, announce: 'udp://fallback', 'announce-list': [] })
      ).announceTiers
    ).toEqual([])
  })

  it('explicitly rejects missing name instead of passing an empty catch assertion', async () => {
    const bytes = encode({
      info: { length: 1, 'piece length': 16384, pieces: new Uint8Array(20) },
    })
    await expect(
      Promise.resolve().then(() => parseTorrent(bytes))
    ).rejects.toThrow(/name/)
  })
  it('matches magnet name, trackers and normalized identity', async () => {
    const uri = `magnet:?xt=urn:btih:${'ab'.repeat(20)}&dn=Alice+in+Wonderland&tr=udp://one&tr=udp://two`
    const old = await reference(uri)
    const parsed = parseMagnet(uri)
    expect(parsed.identity).toEqual({ kind: 'v1', sha1: old.infoHash })
    expect(parsed.name).toBe(old.name)
    expect(parsed.trackers).toEqual(old.announce)
  })
})
