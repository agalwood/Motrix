import {
  INCOMPLETE_SUFFIX,
  MAX_DEDUP_ATTEMPTS,
} from '@shared/constants/incomplete'
import type { DirectResourceValidator } from '@shared/schemas/direct-replay-recipe'

const DEFAULT_TIMEOUT_MS = 3_000
const MAX_FILENAME_REDIRECTS = 5
const MAX_FILESYSTEM_NAME_BYTES = 255
const MAX_DEDUP_SUFFIX_BYTES = Buffer.byteLength(
  ` (${MAX_DEDUP_ATTEMPTS})`,
  'utf8'
)
const MAX_FINAL_NAME_BYTES =
  MAX_FILESYSTEM_NAME_BYTES -
  Buffer.byteLength(INCOMPLETE_SUFFIX, 'utf8') -
  MAX_DEDUP_SUFFIX_BYTES

interface ProxyDispatcher {
  close?(): Promise<void> | void
  destroy?(): Promise<void> | void
}

interface ResourceRequestInit extends RequestInit {
  /** Node/undici extension used by the main and server runtimes. */
  dispatcher?: ProxyDispatcher
}

type FetchLike = (
  input: string | URL | Request,
  init?: ResourceRequestInit
) => Promise<Response>

interface ProxyDispatcherOptions {
  proxy: string
  noProxy?: string
}

type ProxyDispatcherFactory = (
  options: ProxyDispatcherOptions
) => Promise<ProxyDispatcher | null>

export interface DirectResourceRequestOptions {
  headers?: Readonly<Record<string, string>>
  proxy?: string
  noProxy?: string
}

export interface DirectResourceMetadata {
  filename: string | null
  validator: DirectResourceValidator | null
}

interface ResourceMetadata {
  finalUrl: string
  headers: Headers
  status: number
}

const REDIRECT_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'pragma',
  'range',
  'user-agent',
])

const REQUEST_HEADER_DENYLIST = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// biome-ignore lint/complexity/useRegexLiterals: keeps controls escaped in source
const INVALID_HEADER_NAME = new RegExp('[\\u0000-\\u001F\\u007F]')
// biome-ignore lint/complexity/useRegexLiterals: avoids a literal control range
const FILENAME_FORBIDDEN = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001F]', 'g')

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/gzip': '.gz',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/vnd.debian.binary-package': '.deb',
  'application/vnd.microsoft.portable-executable': '.exe',
  'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/x-apple-diskimage': '.dmg',
  'application/x-bittorrent': '.torrent',
  'application/x-gzip': '.gz',
  'application/x-msdownload': '.exe',
  'application/x-rar-compressed': '.rar',
  'application/x-rpm': '.rpm',
  'application/x-tar': '.tar',
  'application/zip': '.zip',
  'audio/flac': '.flac',
  'audio/mpeg': '.mp3',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
}

const createProxyDispatcher: ProxyDispatcherFactory = async ({
  proxy,
  noProxy,
}) => {
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    return null
  }

  const { EnvHttpProxyAgent, Socks5ProxyAgent } = await import('undici')
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return new EnvHttpProxyAgent({
      httpProxy: parsed.toString(),
      httpsProxy: parsed.toString(),
      noProxy: noProxy ?? '',
    })
  }
  if (parsed.protocol === 'socks5:') {
    // Socks5ProxyAgent has no NO_PROXY equivalent. Silently ignoring a global
    // bypass list would change the user's routing policy, so decline the
    // optional probe instead of sending it through the wrong route.
    if (noProxy?.trim()) return null
    return new Socks5ProxyAgent(parsed)
  }
  return null
}

export type DirectResourceValidationOutcome =
  | 'unchanged'
  | 'source-changed'
  | 'range-unsupported'
  | 'unverifiable'

export interface DirectResourceValidationResult {
  outcome: DirectResourceValidationOutcome
  ifRange: string | null
}

/**
 * Captures and verifies non-secret HTTP validators for URI-only direct tasks.
 * A verifier never downloads a response body: capture uses HEAD, while resume
 * verification cancels a one-byte Range response immediately after headers.
 */
export class DirectResourceValidatorService {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) =>
      globalThis.fetch(input, init as RequestInit),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
    private readonly proxyDispatcherFactory: ProxyDispatcherFactory = createProxyDispatcher
  ) {}

  /** Resolve the filename and resumability validator in one bounded probe. */
  async probe(
    uri: string,
    options: DirectResourceRequestOptions = {}
  ): Promise<DirectResourceMetadata | null> {
    const initialUrl = parseHttpUrl(uri)
    if (!initialUrl) return null

    const dispatcher = await this.resolveDispatcher(options)
    if (dispatcher === null) return null

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = probeHeaders(options.headers)
    try {
      const head = await this.requestMetadata(
        initialUrl,
        'HEAD',
        headers,
        dispatcher,
        controller.signal
      )
      let validator: DirectResourceValidator | null = null
      if (head && head.status >= 200 && head.status < 300) {
        validator = readMetadataValidator(head, this.now())
        const filename = filenameFromMetadata(initialUrl, head)
        if (filename) return { filename, validator }
      } else if (head && head.status !== 405 && head.status !== 501) {
        return null
      }

      if (controller.signal.aborted) {
        return validator ? { filename: null, validator } : null
      }
      const ranged = await this.requestMetadata(
        initialUrl,
        'GET',
        { ...headers, range: 'bytes=0-0' },
        dispatcher,
        controller.signal
      )
      if (!ranged || ranged.status < 200 || ranged.status >= 300) {
        return validator ? { filename: null, validator } : null
      }
      return {
        filename: filenameFromMetadata(initialUrl, ranged),
        validator: validator ?? readMetadataValidator(ranged, this.now()),
      }
    } finally {
      clearTimeout(timeout)
      await closeDispatcher(dispatcher)
    }
  }

  async capture(
    uri: string,
    options: DirectResourceRequestOptions = {}
  ): Promise<DirectResourceValidator | null> {
    const initialUrl = parseHttpUrl(uri)
    if (!initialUrl) return null

    const dispatcher = await this.resolveDispatcher(options)
    if (dispatcher === null) return null

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const metadata = await this.requestMetadata(
        initialUrl,
        'HEAD',
        probeHeaders(),
        dispatcher,
        controller.signal
      )
      if (!metadata || metadata.status < 200 || metadata.status >= 300) {
        return null
      }
      return readMetadataValidator(metadata, this.now())
    } finally {
      clearTimeout(timeout)
      await closeDispatcher(dispatcher)
    }
  }

  async verify(
    uri: string,
    expected: DirectResourceValidator
  ): Promise<DirectResourceValidationResult> {
    const response = await this.request(uri, {
      method: 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-0',
        'If-Range': expected.value,
      },
    })
    if (!response) return { outcome: 'unverifiable', ifRange: null }
    if (response.status !== 200 && response.status !== 206) {
      await cancelBody(response)
      return { outcome: 'unverifiable', ifRange: null }
    }

    const current = readValidator(response.headers, this.now())
    const currentValue = validatorValueForKind(current, expected.kind)
    if (!currentValue) {
      await cancelBody(response)
      return { outcome: 'unverifiable', ifRange: null }
    }
    if (currentValue !== expected.value) {
      await cancelBody(response)
      return { outcome: 'source-changed', ifRange: null }
    }

    const currentLength = totalResponseLength(response)
    if (
      expected.contentLength !== undefined &&
      currentLength !== null &&
      currentLength !== expected.contentLength
    ) {
      await cancelBody(response)
      return { outcome: 'source-changed', ifRange: null }
    }

    const rangeSatisfied = response.status === 206
    await cancelBody(response)
    return rangeSatisfied
      ? { outcome: 'unchanged', ifRange: expected.value }
      : { outcome: 'range-unsupported', ifRange: null }
  }

  private async request(
    uri: string,
    init: RequestInit
  ): Promise<Response | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(uri, {
        ...init,
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestMetadata(
    initialUrl: URL,
    method: 'HEAD' | 'GET',
    initialHeaders: Record<string, string>,
    dispatcher: ProxyDispatcher | undefined,
    signal: AbortSignal
  ): Promise<ResourceMetadata | null> {
    let currentUrl = initialUrl
    let headers = initialHeaders

    for (let redirects = 0; redirects <= MAX_FILENAME_REDIRECTS; redirects++) {
      let response: Response
      try {
        response = await this.fetchImpl(currentUrl, {
          method,
          headers,
          redirect: 'manual',
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        })
      } catch {
        return null
      }

      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        await cancelBody(response)
        if (redirects === MAX_FILENAME_REDIRECTS) return null
        let nextUrl: URL
        try {
          nextUrl = new URL(location, currentUrl)
        } catch {
          return null
        }
        if (!isHttpUrl(nextUrl)) return null
        headers = redirectHeaders(headers, currentUrl, nextUrl)
        currentUrl = nextUrl
        continue
      }

      const metadata = {
        finalUrl: currentUrl.toString(),
        headers: response.headers,
        status: response.status,
      }
      await cancelBody(response)
      return metadata
    }

    return null
  }

  private async resolveDispatcher(
    options: DirectResourceRequestOptions
  ): Promise<ProxyDispatcher | undefined | null> {
    const proxy = options.proxy?.trim()
    if (!proxy) return undefined
    try {
      return await this.proxyDispatcherFactory({
        proxy,
        ...(options.noProxy === undefined ? {} : { noProxy: options.noProxy }),
      })
    } catch {
      // A configured proxy that cannot be represented must never fall back to
      // a direct metadata request.
      return null
    }
  }
}

/** A URI/path-derived name is untrusted input, even before a network probe. */
export function sanitizeRemoteFilename(input: string): string | null {
  const leaf = input
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.trim()
  if (!leaf || leaf === '.' || leaf === '..') return null

  let safe = leaf
    .replace(FILENAME_FORBIDDEN, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!safe || safe === '.' || safe === '..') return null
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
    safe = `_${safe}`
  }
  if (Buffer.byteLength(safe, 'utf8') <= MAX_FINAL_NAME_BYTES) return safe
  const extension = safe.match(/(\.[A-Za-z0-9]{2,10})$/)?.[1] ?? ''
  if (!extension) return truncateUtf8(safe, MAX_FINAL_NAME_BYTES)
  const base = safe.slice(0, -extension.length)
  return `${truncateUtf8(
    base,
    MAX_FINAL_NAME_BYTES - Buffer.byteLength(extension, 'utf8')
  )}${extension}`
}

export function hasLikelyFileExtension(filename: string | null): boolean {
  return Boolean(filename && /\.[A-Za-z0-9]{2,10}$/.test(filename))
}

function parseHttpUrl(uri: string): URL | null {
  try {
    const url = new URL(uri)
    return isHttpUrl(url) ? url : null
  } catch {
    return null
  }
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function probeHeaders(
  input?: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase()
    if (!name || REQUEST_HEADER_DENYLIST.has(name)) continue
    if (INVALID_HEADER_NAME.test(name) || /[\r\n]/.test(value)) continue
    result[name] = value
  }
  result['accept-encoding'] = 'identity'
  return result
}

function redirectHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL
): Record<string, string> {
  if (from.origin === to.origin) return headers
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      REDIRECT_SAFE_HEADERS.has(name.toLowerCase())
    )
  )
}

function filenameFromMetadata(
  initialUrl: URL,
  metadata: ResourceMetadata
): string | null {
  const disposition = contentDispositionFilename(
    metadata.headers.get('content-disposition')
  )
  const finalUrlName = urlFilename(metadata.finalUrl)
  const initialUrlName = urlFilename(initialUrl.toString())
  let filename =
    sanitizeRemoteFilename(disposition ?? '') ?? finalUrlName ?? initialUrlName
  if (!filename) filename = 'download'

  if (!hasLikelyFileExtension(filename)) {
    const contentType = metadata.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    const extension = contentType
      ? CONTENT_TYPE_EXTENSIONS[contentType]
      : undefined
    if (extension) filename += extension
  }

  // Returning the same extensionless URL token ("stable", "latest", …)
  // provides no new information. Let the caller retain its normal fallback.
  if (
    !hasLikelyFileExtension(filename) &&
    filename === initialUrlName &&
    !disposition
  ) {
    return null
  }
  return sanitizeRemoteFilename(filename)
}

function urlFilename(uri: string): string | null {
  try {
    const url = new URL(uri)
    const encoded = url.pathname.split('/').filter(Boolean).pop()
    if (!encoded) return null
    let decoded = encoded
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      // Preserve the literal leaf if percent-encoding is malformed.
    }
    return sanitizeRemoteFilename(decoded)
  } catch {
    return null
  }
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value || /[\r\n]/.test(value)) return null
  const parameters = splitDispositionParameters(value)
  let basic: string | null = null
  for (const parameter of parameters.slice(1)) {
    const separator = parameter.indexOf('=')
    if (separator <= 0) continue
    const name = parameter.slice(0, separator).trim().toLowerCase()
    const rawValue = unquote(parameter.slice(separator + 1).trim())
    if (name === 'filename*') {
      const extended = decodeExtendedFilename(rawValue)
      if (extended) return extended
    } else if (name === 'filename' && !basic) {
      basic = rawValue
    }
  }
  return basic
}

function splitDispositionParameters(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (quoted && char === '\\') {
      current += char
      escaped = true
      continue
    }
    if (char === '"') quoted = !quoted
    if (char === ';' && !quoted) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return value
}

function decodeExtendedFilename(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value)
  if (!match) return null
  const charset = match[1]?.toLowerCase()
  const encoded = match[2] ?? ''
  try {
    if (!charset || charset === 'utf-8' || charset === 'us-ascii') {
      return decodeURIComponent(encoded)
    }
    if (charset === 'iso-8859-1') {
      return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      )
    }
  } catch {
    return null
  }
  return null
}

async function closeDispatcher(
  dispatcher: ProxyDispatcher | undefined
): Promise<void> {
  if (!dispatcher) return
  try {
    if (dispatcher.destroy) await dispatcher.destroy()
    else if (dispatcher.close) await dispatcher.close()
  } catch {
    // Best-effort teardown must not turn a filename fallback into a failure.
  }
}

function readValidator(
  headers: Headers,
  capturedAt: number,
  knownContentLength: number | null = parseContentLength(
    headers.get('content-length')
  )
): DirectResourceValidator | null {
  const contentLength = knownContentLength
  const etag = headers.get('etag')?.trim()
  if (
    etag &&
    !etag.startsWith('W/') &&
    etag.startsWith('"') &&
    etag.endsWith('"') &&
    !/[\r\n]/.test(etag) &&
    etag.length <= 512
  ) {
    return {
      kind: 'strong-etag',
      value: etag,
      ...(contentLength === null ? {} : { contentLength }),
      capturedAt,
    }
  }

  const lastModified = headers.get('last-modified')?.trim()
  if (
    lastModified &&
    contentLength !== null &&
    Number.isFinite(Date.parse(lastModified)) &&
    !/[\r\n]/.test(lastModified) &&
    lastModified.length <= 512
  ) {
    return {
      kind: 'last-modified',
      value: lastModified,
      contentLength,
      capturedAt,
    }
  }
  return null
}

function readMetadataValidator(
  metadata: ResourceMetadata,
  capturedAt: number
): DirectResourceValidator | null {
  const contentRange = metadata.headers.get('content-range')
  const totalMatch = contentRange?.match(/\/([0-9]+)$/)
  const contentLength = totalMatch?.[1]
    ? parseContentLength(totalMatch[1])
    : parseContentLength(metadata.headers.get('content-length'))
  return readValidator(metadata.headers, capturedAt, contentLength)
}

function truncateUtf8(input: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const codePoint of input) {
    const width = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + width > maxBytes) break
    result += codePoint
    bytes += width
  }
  return result
}

function validatorValueForKind(
  current: DirectResourceValidator | null,
  expectedKind: DirectResourceValidator['kind']
): string | null {
  return current?.kind === expectedKind ? current.value : null
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function totalResponseLength(response: Response): number | null {
  const contentRange = response.headers.get('content-range')
  const match = contentRange?.match(/\/([0-9]+)$/)
  if (match?.[1]) return parseContentLength(match[1])
  return response.status === 200
    ? parseContentLength(response.headers.get('content-length'))
    : null
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}
