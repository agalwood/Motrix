// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseLegacySession, validateLegacyBencode } from './session-parser'

const encode = (value: string) => new TextEncoder().encode(value)

describe('legacy session adversarial parsing', () => {
  it('recognizes a saved session with BOM, trailing TAB, CRLF, comments and blank option lines', () => {
    const entries = parseLegacySession(
      encode(
        '\uFEFFhttps://example.test/a\thttps://mirror.test/a\t\r\n gid=0123456789abcdef\r\n# saved options\r\n\r\n out=a.zip\r\n'
      )
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].uris).toEqual([
      'https://example.test/a',
      'https://mirror.test/a',
    ])
    expect(entries[0].options.out).toBe('a.zip')
    expect(entries[0].reason).toBeNull()
  })

  it('uses the final singleton option without discarding valid saved records', () => {
    const [entry] = parseLegacySession(
      encode('https://example.test/a\n out=first.zip\n out=last.zip\n')
    )
    expect(entry.options.out).toBe('last.zip')
    expect(entry.reason).toBeNull()
  })

  it.each([
    'on-download-complete=/tmp/run',
    'input-file=/tmp/other',
    'load-cookies=/tmp/cookies',
    'rpc-secret=private',
    'header=Authorization: Bearer private',
  ])(
    'does not replay executable, remote-control or credential options: %s',
    (option) => {
      const [entry] = parseLegacySession(
        encode(`https://example.test/a\n ${option}\n out=a.zip\n`)
      )
      expect(entry.reason).not.toBeNull()
    }
  )

  it('rejects malformed UTF-8 instead of merging replacement characters into an identity', () => {
    expect(() =>
      parseLegacySession(new Uint8Array([0x68, 0xff, 0x0a]))
    ).toThrow()
  })

  it.each([
    'l'.repeat(40) + 'e'.repeat(40),
    '99999999:a',
    'i9007199254740992e',
    'd1:ale',
  ])(
    'rejects malicious or truncated bencode before torrent decoding: %s',
    (input) => {
      expect(() => validateLegacyBencode(encode(input))).toThrow()
    }
  )
})
