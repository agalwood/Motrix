import { downloadSourceAnalysisSchema } from '@shared/schemas/download-source'
import { describe, expect, it } from 'vitest'
import { analyzeDownloadSource } from './download-source'
import { analyzeDownloadInput } from './download-source-input'

const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'

describe('download source representation', () => {
  it.each(['path', 'query', 'fragment'])(
    'rejects an oversized encoded Unicode %s before reporting an accepted URL',
    (part) => {
      const unicode = '界'.repeat(2000)
      const suffix =
        part === 'query'
          ? `?q=${unicode}`
          : part === 'fragment'
            ? `#${unicode}`
            : unicode
      expect(
        analyzeDownloadSource(`https://example.com/${suffix}`)
      ).toMatchObject({
        status: 'rejected',
        diagnostic: { reason: 'urlTooLong' },
      })
    }
  )

  it.each(['%20', '%09', '%0A', '%C2%A0'])(
    'does not trim decoded %s inside a magnet exact topic',
    (space) => {
      for (const topic of [`${space}${hash}`, `${hash}${space}`]) {
        expect(
          analyzeDownloadSource(`magnet:?xt=urn:btih:${topic}`)
        ).toMatchObject({
          status: 'rejected',
          diagnostic: { reason: 'invalidMagnet' },
        })
      }
    }
  )

  it.each([
    [
      'https://example.com/a//b?x=%2f&x=%2F&empty=&plus=+&space=%20&nested=%252F',
      'https://example.com/a//b?x=%2f&x=%2F&empty=&plus=+&space=%20&nested=%252F',
    ],
    [
      'HTTPS://EXAMPLE.COM:443/文件?键=值&sig=a%2Fb%5Cc',
      'https://example.com/%E6%96%87%E4%BB%B6?%E9%94%AE=%E5%80%BC&sig=a%2Fb%5Cc',
    ],
    ['https://例子.测试/a', 'https://xn--fsqu00a.xn--0zwm56d/a'],
    ['https://example.com/a?x=one\\two', 'https://example.com/a?x=one\\two'],
    [
      'https://example.com/a?x=%00%0D%0A#view',
      'https://example.com/a?x=%00%0D%0A',
    ],
    ['http://[::1]:8080/file', 'http://[::1]:8080/file'],
    ['ftp://example.com/file.zip', 'ftp://example.com/file.zip'],
    [
      `magnet:?xt=urn:btih:${hash}&tr=x&tr=y`,
      `magnet:?xt=urn:btih:${hash}&tr=x&tr=y`,
    ],
  ])('preserves the executable representation of %s', (input, requestUrl) => {
    const result = analyzeDownloadSource(input)
    expect(result).toMatchObject({ status: 'accepted', requestUrl })
    expect(downloadSourceAnalysisSchema.safeParse(result).success).toBe(true)
    if (result.status === 'accepted')
      expect(analyzeDownloadSource(result.sourceUrl)).toEqual(result)
  })

  it.each([
    ['example.com/a', 'missingScheme'],
    ['https://a/\tfile', 'controlCharacter'],
    ['https://a/\0file', 'controlCharacter'],
    ['https://a/\u007ffile', 'controlCharacter'],
    ['https://a/\ud800', 'invalidUnicode'],
    ['https://a:70000/f', 'invalidPort'],
    ['https://[:::1]/a', 'invalidHost'],
    ['https://user:pass@a/f', 'credentialsInUrl'],
    ['https://@a/f', 'credentialsInUrl'],
    ['file:///tmp/a', 'unsupportedProtocol'],
    ['ftps://a/f', 'unsupportedProtocol'],
    ['sftp://a/f', 'unsupportedProtocol'],
    ['magnet:?xt=urn:btih:bad', 'invalidMagnet'],
  ])(
    'rejects %s before a forgiving parser can hide the error',
    (input, reason) => {
      expect(analyzeDownloadSource(input)).toMatchObject({
        status: 'rejected',
        diagnostic: { reason },
      })
    }
  )

  it.each([
    ['https://example.com?', 'ambiguousStructure'],
    ['https:example.com/a', 'ambiguousStructure'],
    ['https:////example.com/a', 'ambiguousStructure'],
    ['https://a/dir\\file', 'ambiguousBackslash'],
    ['https://good.test\\@other.test/a', 'ambiguousBackslash'],
    ['https://a/a b', 'unescapedCharacter'],
    ['https://a/file%ZZ', 'invalidPercentEncoding'],
    ['https://a/a/../b', 'ambiguousStructure'],
    ['https://a/%2e%2e/b', 'ambiguousStructure'],
    ['http://127.1/a', 'ambiguousStructure'],
    ['http://0x7f000001/a', 'ambiguousStructure'],
    ["https://a/?sig='value'", 'ambiguousStructure'],
  ])('offers a correction without executing %s', (input, reason) => {
    const result = analyzeDownloadSource(input)
    expect(result).toMatchObject({
      status: 'needsCorrection',
      diagnostic: { reason },
    })
    expect(result).not.toHaveProperty('requestUrl')
  })

  it('offers both meanings of a path backslash without modifying signed query data', () => {
    const result = analyzeDownloadSource('https://a/dir\\file?sig=%2f+%252F')
    expect(result).toMatchObject({
      corrections: [
        {
          action: 'usePathSeparators',
          url: 'https://a/dir/file?sig=%2f+%252F',
        },
        {
          action: 'encodeLiteralCharacters',
          url: 'https://a/dir%5Cfile?sig=%2f+%252F',
        },
      ],
    })
  })

  it('retains line positions, rejects internal tabs, and only trims ASCII spaces', () => {
    const result = analyzeDownloadInput(
      ` https://a/f \r\n\n${hash}\n\thttps://a/g`
    )
    expect(result.map(({ line, valid }) => ({ line, valid }))).toEqual([
      { line: 0, valid: true },
      { line: 2, valid: true },
      { line: 3, valid: false },
    ])
  })

  it('does not pick valid-looking lines out of an unsupported command', () => {
    expect(
      analyzeDownloadInput('curl --data x\nhttps://a/f').every(
        (line) => !line.valid
      )
    ).toBe(true)
  })
})
