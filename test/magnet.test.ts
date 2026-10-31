import { describe, expect, it } from 'vitest'
import { encodeMagnet, normalizeBtih, parseMagnet } from '../src/index.js'

const sha1 = '0123456789abcdef0123456789abcdef01234567'
const sha256 = 'ab'.repeat(32)
describe('magnet identities and extensions', () => {
  it('keeps both algorithms and bounded inclusive selections', () => {
    const input = `magnet:?xt=urn:btih:${sha1}&xt=urn:btmh:1220${sha256}&dn=hello+world&tr=udp%3A%2F%2Fone&tr=two&ws=https%3A%2F%2Fseed%2F&xs=https://source&as=https://backup&x.pe=127.0.0.1:1&so=0,2,4-999999999&x.future=kept`
    const parsed = parseMagnet(input)
    expect(parsed.identity).toEqual({ kind: 'hybrid', sha1, sha256 })
    expect(parsed.name).toBe('hello world')
    expect(parsed.trackers).toEqual(['udp://one', 'two'])
    expect(parsed.selectOnly).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
      { start: 4, end: 999999999 },
    ])
    expect(parseMagnet(encodeMagnet(parsed))).toEqual(parsed)
    expect(parseMagnet(`magnet:?xt=urn:btmh:1220${sha256}`).identity).toEqual({
      kind: 'v2',
      sha256,
    })
  })
  it('normalizes base32 and hexadecimal without whitespace or partial matches', () => {
    expect(normalizeBtih('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe(
      '00443214c74254b635cf84653a56d7c675be77df'
    )
    expect(normalizeBtih(sha1.toUpperCase())).toBe(sha1)
    expect(normalizeBtih(` ${sha1}`)).toBeNull()
  })
  it.each([
    '',
    'https://example.com',
    'magnet:?xt=urn:sha1:a',
    `magnet:?xt=urn:btih:${sha1}&xt=urn:btih:${'f'.repeat(40)}`,
    `magnet:?xt=urn:btih:${sha1}&so=4-2`,
    `magnet:?xt=urn:btih:${sha1}&so=9007199254740992`,
    `magnet:?xt=urn:btih:${sha1}&dn=%FF`,
    `magnet:?xt=urn:btmh:1320${sha256}`,
  ])('rejects malformed or ambiguous input %j', (input) => {
    expect(() => parseMagnet(input)).toThrow()
  })
})
