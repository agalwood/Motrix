import { ErrorCode } from '@shared/errors'
import { type ParseResult, parseErr, parseOk } from './parse-result'

export const DEFAULT_XML_MAX_SIZE = 64 * 1024
export const XML_MAX_TAG_NAME_LENGTH = 64
export const XML_MAX_ATTR_NAME_LENGTH = 64
export const XML_MAX_ATTR_VALUE_LENGTH = 256
export const XML_MAX_ATTRS_PER_ELEMENT = 16
export const XML_MAX_TEXT_LENGTH = 1024

export enum XmlTokenType {
  StartTag = 'start',
  EndTag = 'end',
  Text = 'text',
}

export interface XmlStartTag {
  type: XmlTokenType.StartTag
  name: string
  attrs: Array<{ name: string; value: string }>
  selfClosing: boolean
}
export interface XmlEndTag {
  type: XmlTokenType.EndTag
  name: string
}
export interface XmlText {
  type: XmlTokenType.Text
  value: string
}

export type XmlToken = XmlStartTag | XmlEndTag | XmlText

export interface TokenizerOptions {
  maxSize?: number
}

const ALLOWED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

function isAllowedByte(code: number): boolean {
  return (
    (code >= 0x20 && code <= 0x7e) ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d
  )
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_:\-.]/.test(ch)
}

export function tokenizeXml(
  xml: string,
  options: TokenizerOptions = {}
): ParseResult<XmlToken[]> {
  const maxSize = options.maxSize ?? DEFAULT_XML_MAX_SIZE

  if (xml.length > maxSize) {
    return parseErr(ErrorCode.NatSecurityViolation, 'xml exceeds max size')
  }

  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i)
    if (code > 0x7e) {
      return parseErr(ErrorCode.NatSecurityViolation, 'non-ASCII byte')
    }
    if (!isAllowedByte(code)) {
      return parseErr(ErrorCode.NatSecurityViolation, 'disallowed control char')
    }
  }

  const tokens: XmlToken[] = []
  let i = 0

  if (xml.startsWith('<?xml ', i) || xml.startsWith('<?xml\t', i)) {
    const end = xml.indexOf('?>', i)
    if (end < 0) {
      return parseErr(ErrorCode.NatParseError, 'unterminated XML declaration')
    }
    i = end + 2
    while (i < xml.length && /\s/.test(xml[i] ?? '')) i++
  }

  while (i < xml.length) {
    const ch = xml[i]

    if (ch === '<') {
      if (xml.startsWith('<!--', i)) {
        return parseErr(ErrorCode.NatSecurityViolation, 'comments forbidden')
      }
      if (xml.startsWith('<![CDATA[', i)) {
        return parseErr(ErrorCode.NatSecurityViolation, 'CDATA forbidden')
      }
      if (xml.startsWith('<!DOCTYPE', i)) {
        return parseErr(ErrorCode.NatSecurityViolation, 'DOCTYPE forbidden')
      }
      if (xml.startsWith('<!ENTITY', i)) {
        return parseErr(ErrorCode.NatSecurityViolation, 'ENTITY forbidden')
      }
      if (xml.startsWith('<!', i)) {
        return parseErr(ErrorCode.NatSecurityViolation, 'declaration forbidden')
      }
      if (xml.startsWith('<?', i)) {
        return parseErr(
          ErrorCode.NatSecurityViolation,
          'processing instruction forbidden'
        )
      }

      if (xml[i + 1] === '/') {
        const close = xml.indexOf('>', i + 2)
        if (close < 0) {
          return parseErr(ErrorCode.NatParseError, 'unterminated end tag')
        }
        const name = xml.slice(i + 2, close).trim()
        if (!validateName(name)) {
          return parseErr(ErrorCode.NatSecurityViolation, 'invalid tag name')
        }
        tokens.push({ type: XmlTokenType.EndTag, name })
        i = close + 1
        continue
      }

      const close = xml.indexOf('>', i)
      if (close < 0) {
        return parseErr(ErrorCode.NatParseError, 'unterminated start tag')
      }
      const inner = xml.slice(i + 1, close)
      const selfClosing = inner.endsWith('/')
      const body = selfClosing ? inner.slice(0, -1) : inner

      const tag = parseStartTag(body)
      if (!tag.ok) return tag
      tokens.push({ ...tag.value, selfClosing })
      i = close + 1
      continue
    }

    const nextLt = xml.indexOf('<', i)
    const textEnd = nextLt < 0 ? xml.length : nextLt
    const rawText = xml.slice(i, textEnd)

    if (rawText.length > XML_MAX_TEXT_LENGTH) {
      return parseErr(ErrorCode.NatSecurityViolation, 'text node too long')
    }

    const decoded = decodeEntities(rawText)
    if (!decoded.ok) return decoded
    tokens.push({ type: XmlTokenType.Text, value: decoded.value })
    i = textEnd
  }

  return parseOk(tokens)
}

function validateName(name: string): boolean {
  if (name.length === 0 || name.length > XML_MAX_TAG_NAME_LENGTH) return false
  if (!isNameStart(name[0] ?? '')) return false
  for (let i = 1; i < name.length; i++) {
    if (!isNameChar(name[i] ?? '')) return false
  }
  return true
}

function parseStartTag(
  body: string
): ParseResult<Omit<XmlStartTag, 'selfClosing'>> {
  const trimmed = body.trim()
  let p = 0
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_:\-.]*)/.exec(trimmed.slice(p))
  if (!nameMatch) return parseErr(ErrorCode.NatParseError, 'missing tag name')
  const name = nameMatch[1] ?? ''
  if (!validateName(name)) {
    return parseErr(ErrorCode.NatSecurityViolation, 'invalid tag name')
  }
  p += name.length

  const attrs: Array<{ name: string; value: string }> = []
  while (p < trimmed.length) {
    while (p < trimmed.length && /\s/.test(trimmed[p] ?? '')) p++
    if (p >= trimmed.length) break

    const attrNameMatch = /^([A-Za-z_][A-Za-z0-9_:\-.]*)/.exec(trimmed.slice(p))
    if (!attrNameMatch) {
      return parseErr(ErrorCode.NatParseError, 'invalid attribute name')
    }
    const attrName = attrNameMatch[1] ?? ''
    if (attrName.length > XML_MAX_ATTR_NAME_LENGTH) {
      return parseErr(ErrorCode.NatSecurityViolation, 'attribute name too long')
    }
    p += attrName.length

    while (p < trimmed.length && /\s/.test(trimmed[p] ?? '')) p++
    if (trimmed[p] !== '=') {
      return parseErr(
        ErrorCode.NatParseError,
        'expected = after attribute name'
      )
    }
    p++
    while (p < trimmed.length && /\s/.test(trimmed[p] ?? '')) p++
    if (trimmed[p] !== '"') {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'attribute values must use double quotes'
      )
    }
    p++
    const endQuote = trimmed.indexOf('"', p)
    if (endQuote < 0) {
      return parseErr(ErrorCode.NatParseError, 'unterminated attribute value')
    }
    const rawValue = trimmed.slice(p, endQuote)
    if (rawValue.length > XML_MAX_ATTR_VALUE_LENGTH) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'attribute value too long'
      )
    }
    const decoded = decodeEntities(rawValue)
    if (!decoded.ok) return decoded
    attrs.push({ name: attrName, value: decoded.value })
    p = endQuote + 1

    if (attrs.length > XML_MAX_ATTRS_PER_ELEMENT) {
      return parseErr(ErrorCode.NatSecurityViolation, 'too many attributes')
    }
  }

  return parseOk({ type: XmlTokenType.StartTag, name, attrs })
}

function decodeEntities(s: string): ParseResult<string> {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch !== '&') {
      out += ch
      i++
      continue
    }
    if (s[i + 1] === '#') {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'numeric character references forbidden'
      )
    }
    const semi = s.indexOf(';', i + 1)
    if (semi < 0 || semi - i > 10) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'unterminated entity reference'
      )
    }
    const name = s.slice(i + 1, semi)
    const replacement = ALLOWED_ENTITIES[name]
    if (replacement === undefined) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        `unknown entity: &${name};`
      )
    }
    out += replacement
    i = semi + 1
  }
  return parseOk(out)
}
