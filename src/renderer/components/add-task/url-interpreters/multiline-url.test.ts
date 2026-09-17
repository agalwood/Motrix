import { describe, expect, it } from 'vitest'
import { multilineUrlInterpreter, parseUrlLines } from './multiline-url'

describe('parseUrlLines', () => {
  it('recognizes bare hashes in a mixed batch without dropping invalid lines', () => {
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    expect(
      parseUrlLines(`https://a/b\n ${hash} \r\n\nnot-a-url`)
    ).toMatchObject([
      { line: 0, url: 'https://a/b', valid: true },
      { line: 1, url: `magnet:?xt=urn:btih:${hash}`, valid: true },
      { line: 3, url: 'not-a-url', valid: false },
    ])
  })

  it('parses a single http URL', () => {
    const r = parseUrlLines('https://a.com/f')
    expect(r).toMatchObject([{ line: 0, url: 'https://a.com/f', valid: true }])
  })

  it('splits multiple URLs by newline', () => {
    const r = parseUrlLines('https://a\nhttps://b')
    expect(r).toHaveLength(2)
    expect(r.every((x) => x.valid)).toBe(true)
  })

  it('ignores empty lines', () => {
    const r = parseUrlLines('https://a\n\nhttps://b')
    expect(r).toHaveLength(2)
  })

  it('marks invalid URLs', () => {
    const r = parseUrlLines('not-a-url')
    expect(r[0].valid).toBe(false)
  })

  it('accepts magnet', () => {
    const r = parseUrlLines(
      'magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    )
    expect(r[0].valid).toBe(true)
  })

  it('accepts ftp', () => {
    const r = parseUrlLines('ftp://x.com/f')
    expect(r[0].valid).toBe(true)
  })

  it('trims whitespace', () => {
    const r = parseUrlLines('  https://a.com/f  ')
    expect(r[0].url).toBe('https://a.com/f')
    expect(r[0].valid).toBe(true)
  })
})

describe('multilineUrlInterpreter.tryInterpret', () => {
  it('returns null for empty text', () => {
    expect(multilineUrlInterpreter.tryInterpret('')).toBeNull()
  })

  it('returns urls for valid multi-line input', () => {
    const r = multilineUrlInterpreter.tryInterpret('https://a\nhttps://b')
    expect(r).toEqual({ urls: ['https://a/', 'https://b/'] })
  })

  it('returns null when no valid URL is present', () => {
    expect(multilineUrlInterpreter.tryInterpret('garbage')).toBeNull()
  })
})
