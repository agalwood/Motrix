import { ErrorCode } from '@shared/errors'
import { type ParseResult, parseErr, parseOk } from './parse-result'
import {
  DEFAULT_XML_MAX_SIZE,
  tokenizeXml,
  XmlTokenType,
} from './xml-tokenizer'

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  text: string
  children: XmlElement[]
}

export interface ParseXmlOptions {
  maxSize?: number
  maxDepth?: number
  maxElements?: number
}

export const XML_DEFAULT_MAX_DEPTH = 10
export const XML_DEFAULT_MAX_ELEMENTS = 1500

export function parseXml(
  xml: string,
  options: ParseXmlOptions = {}
): ParseResult<XmlElement> {
  const maxDepth = options.maxDepth ?? XML_DEFAULT_MAX_DEPTH
  const maxElements = options.maxElements ?? XML_DEFAULT_MAX_ELEMENTS

  const tokensResult = tokenizeXml(xml, {
    maxSize: options.maxSize ?? DEFAULT_XML_MAX_SIZE,
  })
  if (!tokensResult.ok) return tokensResult

  const tokens = tokensResult.value
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let elementCount = 0

  for (const token of tokens) {
    if (token.type === XmlTokenType.StartTag) {
      elementCount++
      if (elementCount > maxElements) {
        return parseErr(ErrorCode.NatSecurityViolation, 'too many elements')
      }
      if (stack.length >= maxDepth) {
        return parseErr(
          ErrorCode.NatSecurityViolation,
          'element depth exceeds max'
        )
      }
      const attrs: Record<string, string> = {}
      for (const a of token.attrs) attrs[a.name] = a.value
      const element: XmlElement = {
        name: token.name,
        attrs,
        text: '',
        children: [],
      }
      if (stack.length > 0) {
        const parent = stack[stack.length - 1]
        if (parent) parent.children.push(element)
      } else if (root === null) {
        root = element
      } else {
        return parseErr(ErrorCode.NatParseError, 'multiple root elements')
      }
      if (!token.selfClosing) stack.push(element)
    } else if (token.type === XmlTokenType.EndTag) {
      if (stack.length === 0) {
        return parseErr(ErrorCode.NatParseError, 'end tag without start')
      }
      const top = stack.pop()
      if (!top || top.name !== token.name) {
        return parseErr(
          ErrorCode.NatParseError,
          `mismatched end tag: expected ${top?.name ?? ''}, got ${token.name}`
        )
      }
    } else {
      if (stack.length === 0) {
        if (token.value.trim().length > 0) {
          return parseErr(ErrorCode.NatParseError, 'text outside root element')
        }
        continue
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.text += token.value
    }
  }

  if (stack.length > 0) {
    return parseErr(ErrorCode.NatParseError, 'unclosed elements')
  }
  if (root === null) {
    return parseErr(ErrorCode.NatParseError, 'no root element')
  }
  trimTextRecursively(root)
  return parseOk(root)
}

function trimTextRecursively(el: XmlElement): void {
  el.text = el.text.trim()
  for (const child of el.children) trimTextRecursively(child)
}

export function findChild(
  el: XmlElement,
  name: string
): XmlElement | undefined {
  for (const c of el.children) {
    if (c.name === name || localName(c.name) === name) return c
  }
  return undefined
}

export function findDescendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (e: XmlElement): void => {
    if (e.name === name || localName(e.name) === name) out.push(e)
    for (const c of e.children) walk(c)
  }
  for (const c of el.children) walk(c)
  return out
}

/**
 * Strip the namespace prefix from an XML qualified name, returning the local
 * part (`s:Envelope` → `Envelope`). Used by the SOAP and device-description
 * codecs, which compare element names without caring about the prefix.
 */
export function localName(qname: string): string {
  const ix = qname.indexOf(':')
  return ix >= 0 ? qname.slice(ix + 1) : qname
}
