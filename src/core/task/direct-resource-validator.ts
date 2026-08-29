import type { Socket } from 'node:net'
import {
  INCOMPLETE_SUFFIX,
  MAX_DEDUP_ATTEMPTS,
} from '@shared/constants/incomplete'
import type { DirectResourceValidator } from '@shared/schemas/direct-replay-recipe'
import type { EngineFeatureReport } from '@shared/types/engine'
import type { Dispatcher } from 'undici'
import { isMotrixFork } from '../engine/aria2/feature-report'
import {
  decideAria2ProxyRoute,
  normalizeProxyUrl,
} from '../proxy/aria2-proxy-routing'

const DEFAULT_TIMEOUT_MS = 3_000
const MAX_FILENAME_REDIRECTS = 5
const ARIA2_REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308])
const ARIA2_WANT_DIGEST = 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1'
const MAX_FILESYSTEM_NAME_BYTES = 255
const MAX_DEDUP_SUFFIX_BYTES = Buffer.byteLength(
  ` (${MAX_DEDUP_ATTEMPTS})`,
  'utf8'
)
const MAX_FINAL_NAME_BYTES =
  MAX_FILESYSTEM_NAME_BYTES -
  Buffer.byteLength(INCOMPLETE_SUFFIX, 'utf8') -
  MAX_DEDUP_SUFFIX_BYTES

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
type UndiciRequestLike = typeof import('undici').request

interface ResourceHttpResponse {
  status: number
  headers: Headers
  cancel(): Promise<void> | void
}

type ResourceRequestLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<ResourceHttpResponse>

interface ResourceHttpClient {
  /** Production clients use request; injected tests may retain the fetch seam. */
  request?: ResourceRequestLike
  fetch?: FetchLike
  close(): Promise<void> | void
}

interface ProxyDispatcherOptions {
  proxy: string
  noProxy?: string
}

type ProxyHttpClientFactory = (
  options: ProxyDispatcherOptions
) => Promise<ResourceHttpClient | null>

export interface DirectResourceProxyOptions {
  proxy?: string
  noProxy?: string
  /** aria2's effective global User-Agent for recovery validation requests. */
  userAgent?: string
}

export interface DirectResourceRequestOptions
  extends DirectResourceProxyOptions {
  headers?: Readonly<Record<string, string>>
}

export type DirectResourceProxyOptionsProvider =
  () => DirectResourceProxyOptions | null

/**
 * Exact probe headers are guaranteed only for the bundled Motrix fork with
 * both corresponding compile-time features. An unprobed adapter reports
 * `unknown`; retain that test/startup compatibility, but fail closed for any
 * other concrete binary profile.
 */
export function canMirrorAria2MetadataHeaders(
  report: EngineFeatureReport | null | undefined
): boolean {
  if (!report || report.version === 'unknown') return true
  return (
    isMotrixFork(report) &&
    report.features.includes('GZip') &&
    report.features.includes('Message Digest')
  )
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
  'want-digest',
])
const EMPTY_CREDENTIAL_HEADERS = new Set(['authorization', 'cookie'])
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

const createProxyHttpClient: ProxyHttpClientFactory = async ({
  proxy,
  noProxy,
}) => {
  const parsed = normalizeProxyUrl(proxy)
  if (!parsed) return null

  const { request, Agent, ProxyAgent, Socks5ProxyAgent, buildConnector } =
    await import('undici')
  let proxyDispatcher: Dispatcher | undefined
  let directDispatcher: Dispatcher | undefined
  const socksSockets = new Set<Socket>()
  let closed = false
  try {
    if (parsed.protocol === 'socks5:') {
      const baseConnect = buildConnector({})
      const connect: typeof baseConnect = (options, callback) => {
        const hostname = unbracketHostname(options.hostname)
        return baseConnect(
          { ...options, hostname, host: hostname },
          (error, socket) => {
            if (error) {
              callback(error, null)
              return
            }
            if (!socket) {
              callback(new Error('SOCKS connector returned no socket'), null)
              return
            }
            if (closed) {
              socket.destroy()
              callback(new Error('SOCKS connector completed after close'), null)
              return
            }
            // Socks5ProxyAgent does not own the TCP socket until its greeting
            // finishes. Track it from connect so abort/teardown can also close
            // a proxy that accepts TCP and then stalls during negotiation.
            socksSockets.add(socket)
            socket.once('close', () => socksSockets.delete(socket))
            callback(null, socket)
          }
        )
      }
      proxyDispatcher = new Socks5ProxyAgent(parsed, { connect })
    } else {
      // aria2 treats an https:// proxy URI as an HTTP proxy declaration. Match
      // the download engine instead of attempting TLS to a different endpoint.
      const aria2Proxy = new URL(parsed)
      if (aria2Proxy.protocol === 'https:') {
        // Preserve the port selected while the URI still has HTTPS defaults.
        // Changing protocol first would silently turn an omitted 443 into 80.
        const effectivePort = aria2Proxy.port || '443'
        aria2Proxy.protocol = 'http:'
        aria2Proxy.port = effectivePort
      }
      proxyDispatcher = new ProxyAgent(aria2Proxy.toString())
    }
    directDispatcher = new Agent()
  } catch {
    await destroyDispatcher(proxyDispatcher)
    await destroyDispatcher(directDispatcher)
    return null
  }

  // A dispatcher is an Undici-internal protocol object. Bind it to request()
  // from the same module instance so Node/Electron's embedded Undici can never
  // receive a different major's handler contract.
  const requestWithDispatcher: ResourceRequestLike = (input, init) => {
    const route = decideAria2ProxyRoute(input, noProxy)
    if (route === 'unsupported') {
      return Promise.reject(new TypeError('Unsupported proxy route target'))
    }
    if (
      route === 'proxy' &&
      parsed.protocol === 'socks5:' &&
      isBracketedIpv6Target(input)
    ) {
      // Undici 8.10 serializes an IPv6 SOCKS target as the literal domain
      // "[::1]". Decline the optional request until upstream can encode ATYP 4.
      return Promise.reject(new TypeError('Unsupported IPv6 SOCKS target'))
    }
    if (route !== 'proxy' || parsed.protocol !== 'socks5:' || !init?.signal) {
      return requestResource(
        request,
        input,
        init,
        route === 'direct' ? directDispatcher : proxyDispatcher
      )
    }

    // Socks5ProxyAgent does not own the TCP socket until its greeting
    // completes. Its request promise therefore cannot abort a proxy that
    // accepts TCP and stalls before the greeting response. Close the sockets
    // tracked by our connector as soon as this request is aborted.
    const signal = init.signal
    const abortSockets = () => {
      for (const socket of socksSockets) socket.destroy()
    }
    return new Promise<ResourceHttpResponse>((resolve, reject) => {
      let settled = false
      const succeed = (response: ResourceHttpResponse) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(response)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const onAbort = () => {
        abortSockets()
        fail(new DOMException('The operation was aborted', 'AbortError'))
      }

      // Register before request() starts connecting so a very short timeout
      // cannot race past our ownership of the pre-handshake TCP socket.
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      void requestResource(request, input, init, proxyDispatcher).then(
        succeed,
        fail
      )
    })
  }

  return {
    request: requestWithDispatcher,
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of socksSockets) {
        socket.destroy()
      }
      socksSockets.clear()
      if (parsed.protocol === 'socks5:') {
        // Undici 8 waits for its fixed authentication timer even after a
        // pre-handshake socket closes. Invoke package-owned teardown without
        // extending our bounded metadata timeout while that timer settles.
        void destroyDispatcher(proxyDispatcher)
        await destroyDispatcher(directDispatcher)
      } else {
        await Promise.allSettled([
          destroyDispatcher(directDispatcher),
          destroyDispatcher(proxyDispatcher),
        ])
      }
    },
  }
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
 * Every request uses GET like aria2 and cancels the response body immediately
 * after headers; resume verification additionally requests a one-byte range.
 */
export class DirectResourceValidatorService {
  constructor(
    private readonly fetchImpl: FetchLike | undefined = undefined,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
    private readonly proxyHttpClientFactory: ProxyHttpClientFactory = createProxyHttpClient
  ) {}

  /** Resolve the filename and resumability validator in one bounded probe. */
  async probe(
    uri: string,
    options: DirectResourceRequestOptions = {}
  ): Promise<DirectResourceMetadata | null> {
    const initialUrl = parseHttpUrl(uri)
    if (!initialUrl) return null
    const headers = probeHeaders(options.headers, options.userAgent)
    if (!headers) return null

    const client = await this.resolveHttpClient(options)
    if (client === null) return null

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const metadata = await this.requestMetadata(
        initialUrl,
        uri,
        headers,
        client,
        controller.signal
      )
      if (!metadata || metadata.status < 200 || metadata.status >= 300) {
        return null
      }
      return {
        filename: filenameFromMetadata(initialUrl, metadata),
        validator: readMetadataValidator(metadata, this.now()),
      }
    } finally {
      clearTimeout(timeout)
      await closeHttpClient(client)
    }
  }

  async capture(
    uri: string,
    options: DirectResourceRequestOptions = {}
  ): Promise<DirectResourceValidator | null> {
    const initialUrl = parseHttpUrl(uri)
    if (!initialUrl) return null
    const headers = probeHeaders(options.headers, options.userAgent)
    if (!headers) return null

    const client = await this.resolveHttpClient(options)
    if (client === null) return null

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const metadata = await this.requestMetadata(
        initialUrl,
        uri,
        headers,
        client,
        controller.signal
      )
      if (!metadata || metadata.status < 200 || metadata.status >= 300) {
        return null
      }
      return readMetadataValidator(metadata, this.now())
    } finally {
      clearTimeout(timeout)
      await closeHttpClient(client)
    }
  }

  async verify(
    uri: string,
    expected: DirectResourceValidator,
    options: DirectResourceProxyOptions = {}
  ): Promise<DirectResourceValidationResult> {
    const initialUrl = parseHttpUrl(uri)
    if (!initialUrl) return { outcome: 'unverifiable', ifRange: null }
    const client = await this.resolveHttpClient(options)
    if (client === null) return { outcome: 'unverifiable', ifRange: null }
    const headers = probeHeaders(undefined, options.userAgent)
    if (!headers) {
      await closeHttpClient(client)
      return { outcome: 'unverifiable', ifRange: null }
    }
    headers.range = 'bytes=0-0'
    headers['if-range'] = expected.value

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const metadata = await this.requestMetadata(
        initialUrl,
        uri,
        headers,
        client,
        controller.signal
      )
      if (!metadata || (metadata.status !== 200 && metadata.status !== 206)) {
        return { outcome: 'unverifiable', ifRange: null }
      }

      const current = readMetadataValidator(metadata, this.now())
      const currentValue = validatorValueForKind(current, expected.kind)
      if (!currentValue) {
        return { outcome: 'unverifiable', ifRange: null }
      }
      if (currentValue !== expected.value) {
        return { outcome: 'source-changed', ifRange: null }
      }

      const currentLength = totalMetadataLength(metadata)
      if (
        expected.contentLength !== undefined &&
        currentLength !== null &&
        currentLength !== expected.contentLength
      ) {
        return { outcome: 'source-changed', ifRange: null }
      }

      return metadata.status === 206
        ? { outcome: 'unchanged', ifRange: expected.value }
        : { outcome: 'range-unsupported', ifRange: null }
    } finally {
      clearTimeout(timeout)
      await closeHttpClient(client)
    }
  }

  private async requestMetadata(
    initialUrl: URL,
    initialRequestUrl: string,
    initialHeaders: Record<string, string>,
    client: ResourceHttpClient,
    signal: AbortSignal
  ): Promise<ResourceMetadata | null> {
    let currentUrl = initialUrl
    let currentRequestUrl = requestUrlPreservingAuthority(
      initialRequestUrl,
      initialUrl
    )
    if (!currentRequestUrl) return null
    let headers = initialHeaders

    for (let redirects = 0; redirects <= MAX_FILENAME_REDIRECTS; redirects++) {
      let response: ResourceHttpResponse
      try {
        response = await issueResourceRequest(client, currentRequestUrl, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal,
        })
      } catch {
        return null
      }

      const location = response.headers.get('location')
      if (ARIA2_REDIRECT_STATUSES.has(response.status) && location) {
        await cancelResourceResponse(response)
        if (redirects === MAX_FILENAME_REDIRECTS) return null
        let nextUrl: URL
        try {
          nextUrl = new URL(location, currentUrl)
        } catch {
          return null
        }
        if (!isHttpUrl(nextUrl)) return null
        const nextRequestUrl = redirectRequestUrl(
          location,
          currentRequestUrl,
          nextUrl
        )
        if (!nextRequestUrl) return null
        const nextHeaders = redirectHeaders(headers, currentUrl, nextUrl)
        if (!nextHeaders) return null
        headers = nextHeaders
        currentUrl = nextUrl
        currentRequestUrl = nextRequestUrl
        continue
      }

      const metadata = {
        finalUrl: currentUrl.toString(),
        headers: response.headers,
        status: response.status,
      }
      await cancelResourceResponse(response)
      return metadata
    }

    return null
  }

  private async resolveHttpClient(
    options: DirectResourceProxyOptions
  ): Promise<ResourceHttpClient | null> {
    const proxy = options.proxy?.trim()
    if (!proxy) {
      if (!this.fetchImpl) {
        try {
          const { request, Agent } = await import('undici')
          const dispatcher = new Agent()
          return {
            request: (input, init) =>
              requestResource(request, input, init, dispatcher),
            close: () => destroyDispatcher(dispatcher),
          }
        } catch {
          return null
        }
      }
      return {
        fetch: this.fetchImpl,
        close: async () => undefined,
      }
    }
    try {
      return await this.proxyHttpClientFactory({
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
    if (
      hasC0SpaceOrDel(uri) ||
      uri.includes('\\') ||
      decideAria2ProxyRoute(uri) === 'unsupported' ||
      requestUrlPreservingAuthority(uri, url) === null
    ) {
      return null
    }
    return isHttpUrl(url) ? url : null
  } catch {
    return null
  }
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function requestUrlPreservingAuthority(
  input: string,
  normalized: URL
): string | null {
  const authority = rawUrlAuthority(input)
  const suffix = rawUrlPathAndSearch(input)
  if (!authority || suffix === null) return null
  const requestSuffix =
    suffix === '' || suffix.startsWith('?') ? `/${suffix}` : suffix
  if (requestSuffix !== `${normalized.pathname}${normalized.search}`) {
    return null
  }
  return `${normalized.protocol}//${authority}${requestSuffix}`
}

function redirectRequestUrl(
  location: string,
  currentRequestUrl: string,
  normalized: URL
): string | null {
  if (hasC0SpaceOrDel(location)) return null
  const value = location.trim()
  // aria2 treats backslashes as path text, while WHATWG can reinterpret them
  // as authority separators for special URLs. Decline instead of probing a
  // host the download engine would never select.
  if (!value || value.includes('\\')) return null
  if (unsafeRedirectReference(value)) return null

  const absoluteScheme = /^([A-Za-z][A-Za-z\d+.-]*):\/\//.exec(value)?.[1]
  if (
    absoluteScheme !== undefined &&
    absoluteScheme !== 'http' &&
    absoluteScheme !== 'https'
  ) {
    return null
  }

  const authoritySource = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)
    ? value
    : value.startsWith('//')
      ? `${normalized.protocol}${value}`
      : currentRequestUrl
  const authority = rawUrlAuthority(authoritySource)
  if (!authority) return null
  if (authoritySource !== currentRequestUrl) {
    const suffix = rawUrlPathAndSearch(authoritySource)
    if (suffix === null) return null
    const requestSuffix =
      suffix === '' || suffix.startsWith('?') ? `/${suffix}` : suffix
    if (requestSuffix !== `${normalized.pathname}${normalized.search}`) {
      return null
    }
  }
  const requestUrl = `${normalized.protocol}//${authority}${normalized.pathname}${normalized.search}`
  return decideAria2ProxyRoute(requestUrl) === 'unsupported' ? null : requestUrl
}

function rawUrlAuthority(input: string): string | null {
  const match = /^[\r\n\t ]*[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(input)
  return match?.[1] || null
}

function rawUrlPathAndSearch(input: string): string | null {
  const match = /^[\r\n\t ]*[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*([^#]*)/.exec(
    input
  )
  return match?.[1] ?? null
}

function unsafeRedirectReference(value: string): boolean {
  if (value.startsWith('?') || value.startsWith('#')) return true
  if (hasC0SpaceOrDel(value)) return true
  if (/^[A-Za-z][A-Za-z\d+.-]*:(?!\/\/)/.test(value)) return true

  const withoutFragment = value.split('#', 1)[0] ?? ''
  const path = withoutFragment.split('?', 1)[0] ?? ''
  const querySeparator = withoutFragment.indexOf('?')
  const query =
    querySeparator === -1 ? null : withoutFragment.slice(querySeparator + 1)
  if (/%2e/i.test(path)) return true
  if (/[\^`{}]/.test(path)) return true
  // aria2 preserves apostrophes in Location query text, while WHATWG's
  // special-query serializer changes them to %27. It also preserves an empty
  // query delimiter and percent-encodes the response's original non-ASCII
  // bytes rather than re-encoding JavaScript code points as UTF-8.
  if (query === '' || query?.includes("'") || hasNonAscii(value)) {
    return true
  }

  const pathWithoutAuthority = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(path)
    ? path.slice(path.indexOf('/', path.indexOf('//') + 2))
    : path.startsWith('//')
      ? path.slice(path.indexOf('/', 2))
      : path
  return pathWithoutAuthority.includes('//')
}

export function canRepresentDirectResourceHeaders(
  input?: Readonly<Record<string, string>>
): boolean {
  return normalizedTaskHeaders(input) !== null
}

function normalizedTaskHeaders(
  input?: Readonly<Record<string, string>>
): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase()
    if (
      !name ||
      rawName !== rawName.trim() ||
      REQUEST_HEADER_DENYLIST.has(name) ||
      INVALID_HEADER_NAME.test(name) ||
      !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(rawName) ||
      /[\r\n]/.test(value) ||
      Object.hasOwn(result, name)
    ) {
      return null
    }
    result[name] = value
  }
  return result
}

function probeHeaders(
  input?: Readonly<Record<string, string>>,
  userAgent?: string
): Record<string, string> | null {
  const result = normalizedTaskHeaders(input)
  if (!result) return null
  if (!Object.hasOwn(result, 'user-agent') && userAgent !== undefined) {
    if (hasC0OrDel(userAgent)) return null
    result['user-agent'] = userAgent
  }
  if (!Object.hasOwn(result, 'accept')) result.accept = '*/*'
  // The bundled aria2.conf enables http-accept-gzip. Preserve an explicit task
  // override; otherwise mirror aria2's compiled-with-zlib request value.
  if (!Object.hasOwn(result, 'accept-encoding')) {
    result['accept-encoding'] = 'deflate, gzip'
  }
  if (!Object.hasOwn(result, 'want-digest')) {
    result['want-digest'] = ARIA2_WANT_DIGEST
  }
  // Metadata-eligible aria2 tasks carry the same empty custom fields. Their
  // presence suppresses aria2's process-wide CookieStorage and AuthConfig
  // factories without replacing an explicit task credential.
  if (!Object.hasOwn(result, 'cookie')) result.cookie = ''
  if (!Object.hasOwn(result, 'authorization')) result.authorization = ''
  return result
}

function redirectHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL
): Record<string, string> | null {
  if (from.origin === to.origin) return headers
  return Object.entries(headers).every(([name, value]) => {
    const normalizedName = name.toLowerCase()
    return (
      REDIRECT_SAFE_HEADERS.has(normalizedName) ||
      (value === '' && EMPTY_CREDENTIAL_HEADERS.has(normalizedName))
    )
  })
    ? headers
    : null
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
      // aria2's default content-disposition-default-utf8=false interprets a
      // legacy filename using locale-dependent bytes. Undici exposes a JS
      // string instead, so only consume the portable ASCII subset here. For a
      // non-ASCII legacy value, filenameFromMetadata falls back to the URL and
      // pins that result as aria2's `out`; RFC 5987 filename* stays supported.
      if (/^[\x20-\x7e]*$/.test(rawValue)) basic = rawValue
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

async function closeHttpClient(client: ResourceHttpClient): Promise<void> {
  try {
    await client.close()
  } catch {
    // Best-effort teardown must not turn a filename fallback into a failure.
  }
}

async function issueResourceRequest(
  client: ResourceHttpClient,
  input: string | URL,
  init: RequestInit
): Promise<ResourceHttpResponse> {
  if (client.request) return client.request(input, init)
  if (!client.fetch) throw new TypeError('HTTP client has no request method')
  const response = await client.fetch(input, init)
  return {
    status: response.status,
    headers: response.headers,
    cancel: () => cancelBody(response),
  }
}

async function requestResource(
  requestImpl: UndiciRequestLike,
  input: string | URL,
  init: RequestInit | undefined,
  dispatcher: Dispatcher | undefined
): Promise<ResourceHttpResponse> {
  const response = await requestImpl(input, {
    dispatcher,
    method: init?.method ?? 'GET',
    // Some Undici versions append synthesized fields (notably Host) to the
    // supplied header object. Never let that mutate our per-hop replay set:
    // doing so can either leak a stale authority or falsely block a safe
    // cross-origin redirect.
    headers:
      init?.headers === undefined
        ? undefined
        : { ...(init.headers as Record<string, string>) },
    signal: init?.signal ?? undefined,
    maxRedirections: 0,
  } as Parameters<UndiciRequestLike>[1])

  // Contract tests retain their Response-based seam; production takes the
  // lower-level Undici response branch and never applies Fetch defaults.
  if (response instanceof Response) {
    return {
      status: response.status,
      headers: response.headers,
      cancel: () => cancelBody(response),
    }
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return {
    status: response.statusCode,
    headers,
    cancel: () => destroyResponseBody(response.body),
  }
}

async function destroyResponseBody(
  body: import('node:stream').Readable
): Promise<void> {
  if (body.closed) return
  // Undici emits RequestAbortedError when a BodyReadable is destroyed. Install
  // the listener first so cancellation cannot become an unhandled process-level
  // error in Node or Electron. The owning client destroys its dispatcher next.
  body.once('error', () => undefined)
  body.destroy()
  // Let Undici process the abort before a redirect reuses this dispatcher.
  // Do not wait indefinitely for `close`: a malformed/truncated body may only
  // settle when the owning dispatcher is destroyed in the caller's finally.
  await new Promise<void>((resolve) => {
    body.once('close', resolve)
    setImmediate(resolve)
  })
}

async function cancelResourceResponse(
  response: ResourceHttpResponse
): Promise<void> {
  await Promise.resolve(response.cancel()).catch(() => {})
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
    // RFC entity-tag opaque bytes exclude DQUOTE, SP, controls and DEL.
    // Reject non-Latin-1 code points too: a combined duplicate header such as
    // `"a", "b"` must never be mistaken for one strong validator.
    /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) &&
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

function totalMetadataLength(metadata: ResourceMetadata): number | null {
  const contentRange = metadata.headers.get('content-range')
  const match = contentRange?.match(/\/([0-9]+)$/)
  if (match?.[1]) return parseContentLength(match[1])
  return metadata.status === 200
    ? parseContentLength(metadata.headers.get('content-length'))
    : null
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function isBracketedIpv6Target(input: string | URL): boolean {
  try {
    const url = typeof input === 'string' ? new URL(input) : input
    return url.hostname.startsWith('[') && url.hostname.endsWith(']')
  } catch {
    return true
  }
}

function hasC0SpaceOrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) return true
  }
  return false
}

function hasC0OrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function hasNonAscii(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true
  }
  return false
}

async function destroyDispatcher(
  dispatcher: Dispatcher | undefined
): Promise<void> {
  if (!dispatcher) return
  await dispatcher.destroy().catch(() => {})
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}
