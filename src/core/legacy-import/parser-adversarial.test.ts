// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  getLegacyRequestValues,
  parseLegacySession,
  resolveLegacyRequestSettings,
  validateLegacyBencode,
} from './session-parser'

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

  it.each(['0', '1', ''])(
    'does not enable ambient netrc credentials through no-netrc=%s',
    (value) => {
      const [entry] = parseLegacySession(
        encode(`https://example.test/a\n no-netrc=${value}\n`)
      )
      expect(entry.reason).toBeNull()
    }
  )

  it.each([
    ['header', 'Authorization: Bearer private-token'],
    ['referer', 'https://private.test/source'],
  ])(
    'keeps only the name of request option %s for reconfiguration',
    (key, value) => {
      const [entry] = parseLegacySession(
        encode(`https://example.test/a\n ${key}=${value}\n`)
      )
      expect(entry.reason).toBe('request-settings-required')
      expect(entry.requestOptions).toEqual([key])
      expect(entry.options[key]).toBeUndefined()
      expect(entry.optionPairs).toEqual([])
      expect(JSON.stringify(entry)).not.toContain(value)
    }
  )

  it('deduplicates repeated request names without retaining any of their values', () => {
    const [entry] = parseLegacySession(
      encode(
        'https://example.test/a\n header=Cookie: private-cookie\n header=Authorization: private-token\n header=\n'
      )
    )
    expect(entry.requestOptions).toEqual(['header'])
    expect(entry.reason).toBe('request-settings-required')
    expect(JSON.stringify(entry)).not.toMatch(/private-cookie|private-token/)
  })

  it('ignores empty known request options and strips empty unknown options', () => {
    const [empty, unknown] = parseLegacySession(
      encode(
        'https://example.test/a\n header=\n referer= \n all-proxy=\nhttps://example.test/b\n unsafe-option=\n'
      )
    )
    expect(empty.reason).toBeNull()
    expect(empty.requestOptions).toEqual([])
    expect(unknown.reason).toBeNull()
    expect(unknown.ignoredOptions).toEqual(['unsafe-option'])
  })

  it('bounds safe diagnostic names without retaining unsupported values', () => {
    const [entry] = parseLegacySession(
      encode(
        `https://example.test/a\n ${'x'.repeat(65)}=private\n${Array.from({ length: 70 }, (_, index) => ` unknown-${index}=private`).join('\n')}\n`
      )
    )
    expect(entry.reason).toBeNull()
    expect(entry.ignoredOptions).toHaveLength(64)
    expect(entry.ignoredOptions.every((key) => key.length <= 64)).toBe(true)
    expect(JSON.stringify(entry)).not.toContain('private')
  })

  it.each([
    ['malformed option', ' bad option=value\n unsupported=value\n'],
    ['oversized line', ` header=${'x'.repeat(16384)}\n unsupported=value\n`],
    ['invalid gid', ' gid=invalid\n header=private\n'],
  ])(
    'retains invalid-record precedence for %s after unsafe options',
    (_label, options) => {
      const [entry] = parseLegacySession(
        encode(`https://example.test/a\n${options}`)
      )
      expect(entry.reason).toBe('invalid-record')
    }
  )

  it('rejects repeated GIDs even when both records only need request settings', () => {
    const entries = parseLegacySession(
      encode(
        'https://example.test/a\n gid=0123456789abcdef\n header=private\nhttps://example.test/b\n gid=0123456789abcdef\n header=private\n'
      )
    )
    expect(entries.every((entry) => entry.reason === 'invalid-record')).toBe(
      true
    )
  })

  it('preserves cumulative tracker pairs while applying singleton last-value semantics', () => {
    const [entry] = parseLegacySession(
      encode(
        'metadata.torrent\n bt-tracker=https://first.test/announce\n out=first\n bt-tracker=https://second.test/announce\n out=last\n'
      )
    )
    expect(entry.options.out).toBe('last')
    expect(entry.optionPairs.filter(([key]) => key === 'bt-tracker')).toEqual([
      ['bt-tracker', 'https://first.test/announce'],
      ['bt-tracker', 'https://second.test/announce'],
    ])
    expect(entry.reason).toBeNull()
  })

  it.each([
    'on-download-complete=/tmp/run',
    'input-file=/tmp/other',
    'rpc-secret=private',
  ])(
    'strips executable, remote-control or credential options: %s',
    (option) => {
      const [entry] = parseLegacySession(
        encode(`https://example.test/a\n ${option}\n out=a.zip\n`)
      )
      expect(entry.reason).toBeNull()
      expect(entry.ignoredOptions).toEqual([option.split('=')[0]])
      expect(entry.options[option.split('=')[0]]).toBeUndefined()
    }
  )

  it('keeps private request values out of serialization while resolving the final task singleton', () => {
    const [entry] = parseLegacySession(
      encode(
        [
          'https://example.test/a',
          ' all-proxy=http://obsolete-private.test:8080',
          ' all-proxy=',
          ' http-user=obsolete-user',
          ' http-user=final-user',
          ' header=X-Task: private-task',
          '',
        ].join('\n')
      )
    )
    const resolved = resolveLegacyRequestSettings(
      entry,
      {
        'all-proxy': 'http://global-private.test:8080',
        'http-user': 'global-user',
        header: ['X-Global: private-global'],
      },
      'http'
    )
    expect(resolved.values).toMatchObject({
      'http-user': ['final-user'],
      header: ['X-Global: private-global', 'X-Task: private-task'],
    })
    expect(resolved.requestOptions).toEqual(
      expect.arrayContaining(['http-user', 'header'])
    )
    expect(resolved.requestOptions).not.toContain('all-proxy')
    expect(getLegacyRequestValues(entry)['all-proxy']).toBeUndefined()
    expect(JSON.stringify(entry)).not.toMatch(
      /private|final-user|obsolete-user/
    )
  })

  it('drops unsupported and conflicting headers while preserving independent valid headers', () => {
    const [entry] = parseLegacySession(
      encode(
        [
          'https://example.test/a',
          ' header=Authorization: private-task',
          ' header=X-Valid: retained',
          ' header=Range: bytes=0-1',
          ' header=Host: unsafe.test',
          ' header=invalid',
          ' load-cookies=/private/cookies.txt',
          ' netrc-path=/private/netrc',
          ' no-netrc=false',
          '',
        ].join('\n')
      )
    )
    const resolved = resolveLegacyRequestSettings(
      entry,
      { header: ['Authorization: private-global'] },
      'http'
    )
    expect(resolved.values.header).toEqual(['X-Valid: retained'])
    expect(resolved.requestOptions).toEqual(['header'])
    expect(resolved.ignoredOptions).toEqual(
      expect.arrayContaining([
        'header',
        'load-cookies',
        'netrc-path',
        'no-netrc',
      ])
    )
    expect(JSON.stringify(entry)).not.toMatch(/private|unsafe/)
  })

  it.each(['http', 'bt', 'magnet'] as const)(
    'discards legacy proxy values for %s while reporting only names',
    (kind) => {
      const prefixes = ['all-proxy', 'http-proxy', 'https-proxy', 'ftp-proxy']
      const settings = Object.fromEntries(
        prefixes.flatMap((key) => [
          [key, 'http://private:secret@proxy.test:8080'],
          [`${key}-user`, 'private-user'],
          [`${key}-passwd`, 'private-password'],
        ])
      )
      Object.assign(settings, {
        'no-proxy': '.private.test',
        'proxy-method': 'tunnel',
      })
      const entry = parseLegacySession(
        encode(
          'https://example.test/a\n' +
            Object.entries(settings)
              .map(([key, value]) => ` ${key}=${value}`)
              .join('\n')
        )
      )[0]
      const result = resolveLegacyRequestSettings(entry, settings, kind)
      expect(result.values).toEqual({})
      expect(result.requestOptions).toEqual([])
      expect(result.ignoredOptions.sort()).toEqual(Object.keys(settings).sort())
      expect(getLegacyRequestValues(entry)).toEqual({})
      expect(JSON.stringify(entry)).not.toMatch(/private|secret|proxy\.test/)
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
