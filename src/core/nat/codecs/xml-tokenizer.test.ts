import { fc, test } from '@fast-check/vitest'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { tokenizeXml, XmlTokenType } from './xml-tokenizer'

describe('xml-tokenizer byte-level safety', () => {
  it('rejects input exceeding max size', () => {
    const xml = `<a>${'x'.repeat(64 * 1024)}</a>`
    const r = tokenizeXml(xml, { maxSize: 1024 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects non-ASCII bytes', () => {
    const xml = '<a>\u00e9</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects control characters (except \\t \\n \\r)', () => {
    const xml = '<a>\u0001</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts \\t \\n \\r', () => {
    const xml = '<a>hello\tworld\nfoo\r</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects DOCTYPE', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE a><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects ENTITY declarations', () => {
    const xml = '<!ENTITY x "y"><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects CDATA sections', () => {
    const xml = '<a><![CDATA[ hello ]]></a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects XML comments', () => {
    const xml = '<a><!-- comment --></a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects processing instructions other than XML declaration', () => {
    const xml = '<?xml-stylesheet?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts optional XML declaration', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects numeric character references', () => {
    const xml = '<a>&#60;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects hex character references', () => {
    const xml = '<a>&#x3C;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unknown entity references', () => {
    const xml = '<a>&xxe;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts the 5 standard entities', () => {
    const xml = '<a>&lt;&gt;&amp;&quot;&apos;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const textToken = r.value.find((t) => t.type === XmlTokenType.Text)
      expect(textToken?.value).toBe(`<>&"'`)
    }
  })

  it('rejects single-quoted attributes', () => {
    const xml = `<a name='value'/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts double-quoted attributes', () => {
    const xml = '<a name="value"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })
})

describe('xml-tokenizer happy path', () => {
  it('tokenizes simple element', () => {
    const r = tokenizeXml('<root/>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual([
        {
          type: XmlTokenType.StartTag,
          name: 'root',
          attrs: [],
          selfClosing: true,
        },
      ])
    }
  })

  it('tokenizes nested elements', () => {
    const r = tokenizeXml('<a><b>text</b></a>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((t) => t.type)).toEqual([
        XmlTokenType.StartTag,
        XmlTokenType.StartTag,
        XmlTokenType.Text,
        XmlTokenType.EndTag,
        XmlTokenType.EndTag,
      ])
    }
  })
})

test.prop([fc.uint8Array({ maxLength: 1024 })])(
  'tokenizeXml never throws on random bytes',
  (bytes) => {
    const xml = Buffer.from(bytes).toString('utf-8')
    const r = tokenizeXml(xml)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('xml-tokenizer additional branches', () => {
  it('rejects other <! declarations (not DOCTYPE/ENTITY/CDATA/comment)', () => {
    // e.g. <!NOTATION ...> or <!ELEMENT ...>
    const xml = '<!ELEMENT root ANY><root/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('rejects attribute name exceeding max length', () => {
    const longName = 'a'.repeat(65)
    const xml = `<a ${longName}="value"/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute missing = sign', () => {
    const xml = '<a name/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated end tag', () => {
    const xml = '<a></a'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated start tag', () => {
    const xml = '<a'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid end tag name', () => {
    const xml = '<a></1invalid>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects entity with no semicolon within 10 chars', () => {
    const xml = '<a>&toolongentityname</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated attribute value (no closing quote)', () => {
    const xml = '<a name="value/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects XML declaration without ?> terminator', () => {
    const xml = '<?xml version="1.0"'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts XML declaration with tab separator', () => {
    const xml = '<?xml\tversion="1.0"?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects text node exceeding XML_MAX_TEXT_LENGTH (1024)', () => {
    const xml = `<a>${'x'.repeat(1025)}</a>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects tag with name exceeding XML_MAX_TAG_NAME_LENGTH', () => {
    const name = 'a'.repeat(65)
    const xml = `<${name}/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute name starting with non-letter/underscore', () => {
    // After the tag name, the body has something that does not match attrNameMatch
    // Force an attribute name that starts with a digit
    const xml = '<a 1bad="val"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute value exceeding XML_MAX_ATTR_VALUE_LENGTH (256)', () => {
    const longVal = 'x'.repeat(257)
    const xml = `<a name="${longVal}"/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects more than XML_MAX_ATTRS_PER_ELEMENT (16) attributes', () => {
    const attrs = Array.from({ length: 17 }, (_, i) => `a${i}="v"`).join(' ')
    const xml = `<el ${attrs}/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid entity in attribute value', () => {
    // Triggers the decodeEntities error branch inside parseStartTag
    const xml = '<a name="&bad;"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })
})
