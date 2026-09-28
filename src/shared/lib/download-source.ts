import {
  type DownloadSourceAnalysis,
  MAX_DOWNLOAD_URL_BYTES,
  type SourceCorrection,
  type SourceProtocol,
  type SourceReason,
} from '@shared/schemas/download-source'
import { infoHashToMagnetUri } from '@shared/schemas/magnet-input'

function failure(
  reason: SourceReason,
  start: number,
  end: number,
  corrections: SourceCorrection[] = []
): DownloadSourceAnalysis {
  const diagnostic = { reason, start, end }
  return corrections.length
    ? { status: 'needsCorrection', diagnostic, corrections }
    : { status: 'rejected', diagnostic }
}

/** Syntax and representation only: this performs no network or access-policy checks. */
export function analyzeDownloadSource(
  raw: string,
  protocols: readonly SourceProtocol[] = ['http', 'https', 'ftp', 'magnet']
): DownloadSourceAnalysis {
  if (
    raw.length > MAX_DOWNLOAD_URL_BYTES ||
    new TextEncoder().encode(raw).length > MAX_DOWNLOAD_URL_BYTES
  )
    return failure('urlTooLong', 0, raw.length)
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code <= 31 || code === 127) return failure('controlCharacter', i, i + 1)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        return failure('invalidUnicode', i, i + 1)
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff)
      return failure('invalidUnicode', i, i + 1)
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (!scheme) return failure('missingScheme', 0, raw.length)
  const protocol = scheme[1].toLowerCase() as SourceProtocol
  if (!protocols.includes(protocol))
    return failure('unsupportedProtocol', 0, scheme[1].length)
  const badPercent = /%(?![0-9a-f]{2})/i.exec(raw)
  if (badPercent)
    return failure(
      'invalidPercentEncoding',
      badPercent.index,
      badPercent.index + 1,
      [
        {
          action: 'encodeLiteralCharacters',
          url: raw.replace(/%(?![0-9a-f]{2})/gi, '%25'),
        },
      ]
    )
  if (protocol === 'magnet') {
    if (!/^magnet:\?/i.test(raw)) return failure('invalidMagnet', 0, raw.length)
    const topics = new URLSearchParams(
      raw.slice(raw.indexOf('?') + 1).split('#')[0]
    ).getAll('xt')
    if (
      !topics.some(
        (topic) =>
          /^urn:btih:/i.test(topic) &&
          topic.slice(9) === topic.slice(9).trim() &&
          infoHashToMagnetUri(topic.slice(9))
      )
    )
      return failure('invalidMagnet', 0, raw.length)
    const uri = `magnet:${raw.slice(scheme[0].length)}`
    return {
      status: 'accepted',
      protocol,
      sourceUrl: uri,
      requestUrl: uri,
      host: '',
    }
  }
  // A reverse solidus is data in a query, but changes the target in an authority/path.
  const queryStart = raw.search(/[?#]/)
  const structuralEnd = queryStart < 0 ? raw.length : queryStart
  const backslash = raw.slice(0, structuralEnd).indexOf('\\')
  if (backslash >= 0) {
    const prefix = raw.slice(0, structuralEnd)
    const suffix = raw.slice(structuralEnd)
    const pathStart = raw.indexOf('/', scheme[0].length + 2)
    const corrections: SourceCorrection[] = [
      {
        action: 'usePathSeparators',
        url: prefix.replaceAll('\\', '/') + suffix,
      },
    ]
    if (
      raw.startsWith('//', scheme[0].length) &&
      pathStart >= 0 &&
      backslash >= pathStart
    )
      corrections.push({
        action: 'encodeLiteralCharacters',
        url: prefix.replaceAll('\\', '%5C') + suffix,
      })
    return failure('ambiguousBackslash', backslash, backslash + 1, corrections)
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    const authority = raw.slice(scheme[0].length + 2).split(/[/?#]/)[0]
    return failure(
      /:\d*[^\d\]]*$/.test(authority) || /:\d+$/.test(authority)
        ? 'invalidPort'
        : 'invalidHost',
      scheme[0].length,
      structuralEnd
    )
  }
  const parts =
    /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw)
  if (!parts || !parsed.hostname)
    return failure('ambiguousStructure', scheme[0].length, structuralEnd, [
      { action: 'useCanonicalUrl', url: parsed.href },
    ])
  const [, authority, path, query = '', fragment = ''] = parts
  // Fetch drops an empty query marker while aria2 preserves it. Do not let
  // discovery and download select different signed request targets.
  if (query === '?')
    return failure(
      'ambiguousStructure',
      raw.indexOf('?'),
      raw.indexOf('?') + 1,
      [{ action: 'useCanonicalUrl', url: raw.replace(/\?(?=#|$)/, '') }]
    )
  if (authority.includes('@'))
    return failure(
      'credentialsInUrl',
      scheme[0].length + 2,
      scheme[0].length + 2 + authority.length
    )
  const space = raw.search(/[ <>"`{}|^]/)
  if (space >= 0)
    return failure('unescapedCharacter', space, space + 1, [
      {
        action: 'encodeLiteralCharacters',
        url: raw.replace(/[ <>"`{}|^]/g, (char) => encodeURIComponent(char)),
      },
    ])
  const encodeUnicode = (part: string) =>
    part.replace(/[^\x20-\x7e]/gu, (char) => encodeURIComponent(char))
  const requestPath = encodeUnicode(path || '/')
  const requestQuery = encodeUnicode(query)
  // WHATWG removes literal/encoded dot segments and expands legacy IPv4 spellings.
  const rawHost = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0]
  const hostRewritten =
    !rawHost.startsWith('[') &&
    /^[\x20-\x7e]+$/.test(rawHost) &&
    rawHost.toLowerCase() !== parsed.hostname
  if (
    hostRewritten ||
    requestPath !== parsed.pathname ||
    (requestQuery && requestQuery !== '?' && requestQuery !== parsed.search)
  )
    return failure('ambiguousStructure', scheme[0].length + 2, structuralEnd, [
      { action: 'useCanonicalUrl', url: parsed.href },
    ])
  const requestUrl = `${protocol}://${parsed.host}${requestPath}${requestQuery}`
  const sourceUrl = requestUrl + encodeUnicode(fragment)
  // The canonical representation is ASCII and must pass the next admission gate.
  if (sourceUrl.length > MAX_DOWNLOAD_URL_BYTES)
    return failure('urlTooLong', 0, raw.length)
  return {
    status: 'accepted',
    protocol,
    requestUrl,
    sourceUrl,
    host: parsed.host,
  }
}
