import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { parseXml } from './xml-parser'

describe('parseXml happy path', () => {
  it('parses single self-closing element', () => {
    const r = parseXml('<root/>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.name).toBe('root')
      expect(r.value.children).toEqual([])
    }
  })

  it('parses text content', () => {
    const r = parseXml('<root>hello</root>')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.text).toBe('hello')
  })

  it('parses attributes', () => {
    const r = parseXml('<root a="1" b="two"/>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.attrs.a).toBe('1')
      expect(r.value.attrs.b).toBe('two')
    }
  })

  it('parses nested structure', () => {
    const r = parseXml('<a><b><c>inner</c></b></a>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.name).toBe('a')
      expect(r.value.children[0]?.name).toBe('b')
      expect(r.value.children[0]?.children[0]?.name).toBe('c')
      expect(r.value.children[0]?.children[0]?.text).toBe('inner')
    }
  })

  it('preserves multiple children', () => {
    const r = parseXml('<root><a/><b/><c/></root>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.children.map((c) => c.name)).toEqual(['a', 'b', 'c'])
    }
  })

  it('handles XML declaration', () => {
    const r = parseXml('<?xml version="1.0" encoding="UTF-8"?><root/>')
    expect(r.ok).toBe(true)
  })
})

describe('parseXml limits', () => {
  it('rejects depth exceeding limit', () => {
    let xml = ''
    for (let i = 0; i < 20; i++) xml += '<a>'
    for (let i = 0; i < 20; i++) xml += '</a>'
    const r = parseXml(xml, { maxDepth: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects element count exceeding limit', () => {
    let xml = '<root>'
    for (let i = 0; i < 50; i++) xml += '<x/>'
    xml += '</root>'
    const r = parseXml(xml, { maxElements: 30 })
    expect(r.ok).toBe(false)
  })

  it('rejects mismatched end tag', () => {
    const r = parseXml('<a><b></a></b>')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatParseError)
  })

  it('rejects unclosed root element', () => {
    const r = parseXml('<a>')
    expect(r.ok).toBe(false)
  })

  it('rejects multiple root elements', () => {
    const r = parseXml('<a/><b/>')
    expect(r.ok).toBe(false)
  })
})

describe('parseXml security', () => {
  it('rejects XXE', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>'
    const r = parseXml(xxe)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects billion laughs', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><root>&lol2;</root>'
    const r = parseXml(bomb)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.string({ maxLength: 2048 })])(
  'parseXml never throws on random strings',
  (s) => {
    const r = parseXml(s)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('parseXml additional branches', () => {
  it('rejects non-whitespace text before/outside root element', () => {
    // Tokenizer produces a text token with non-whitespace content before any element
    // This hits the "text outside root element" branch in xml-parser
    const r = parseXml('some text<root/>')
    expect(r.ok).toBe(false)
  })

  it('accepts whitespace text outside root element', () => {
    // Whitespace-only text tokens outside root are silently skipped
    const r = parseXml('  \n  <root/>  ')
    expect(r.ok).toBe(true)
  })

  it('rejects end tag with no matching open element', () => {
    const r = parseXml('</orphan>')
    expect(r.ok).toBe(false)
  })

  it('rejects empty input (no root)', () => {
    const r = parseXml('')
    expect(r.ok).toBe(false)
  })
})
