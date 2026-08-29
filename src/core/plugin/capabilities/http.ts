// http capability — plugin-facing outbound HTTP primitive.
//
// Each plugin with `permissions: ['http']` receives an HttpCapabilityHost
// instance scoped to their CookieJar (when cookies: 'jar' is requested).
//
// Spec §4 L1154-1200. Phase 1A surface:
//   - Scheme allowlist: http: and https: only.
//   - Body cap: default 50 MB; hard max 200 MB; configurable per-request.
//   - Timeout: default 30 s; hard cap 300 s.
//   - Redirect: 'follow' (up to 10), 'manual', or 'error' (reject any 3xx).
//   - Range: `{start, end}` generates a `Range: bytes=start-end` header.
//   - Proxy: `http://host:port` / `https://host:port`; per-request override.
//   - Cookies: opt-in via cookies: 'jar' (reads jar before, captures after).
//   - AbortSignal chaining: plugin's signal + internal timeout both abort.
//   - JSON body shorthand: body.type === 'json' auto-serializes + Content-Type.
//
// Redirects are tracked manually via a `manualAgent` + per-hop loop. This
// lets us return `finalUrl` and `redirected` accurately and implement the
// `redirect: 'error'` mode uniformly.

import type { Dispatcher } from 'undici'
import { Agent, ProxyAgent, request as undiciRequest } from 'undici'
import { urlMatchesHostPermissions } from '../hooks/eligibility'
import type { CookieJar } from './http-cookies'

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpResponseType = 'text' | 'json' | 'bytes'

export interface HttpRequestBody {
  type: 'string' | 'json' | 'bytes'
  data: string | object | Uint8Array
}

export interface HttpHeader {
  name: string
  value: string
}

export interface HttpRequestOptions<R extends HttpResponseType = 'text'> {
  url: string
  method?: string
  /**
   * Outbound headers — array form per spec §4 L1171 to allow duplicate names
   * and preserve case. Internally folded into a Record for undici, with last
   * value winning on duplicates among request headers (browsers behave the
   * same way for non-Set-Cookie outbound headers).
   */
  headers?: ReadonlyArray<HttpHeader>
  body?: HttpRequestBody
  /** Required per spec §4 L1173 — no implicit fallback. */
  responseType: R
  /** Default 30_000 ms; clamped to [1_000, 300_000]. */
  timeoutMs?: number
  /** Default 50<<20; hard cap 200<<20. */
  maxBodyBytes?: number
  /**
   * follow (default) — chase up to 10 redirects.
   * manual — return the 3xx response directly.
   * error  — throw plugin.http.redirect_not_allowed on any 3xx.
   */
  redirect?: 'follow' | 'manual' | 'error'
  cookies?: 'jar' | 'none'
  /** Partial download via `Range: bytes=start-end`. */
  range?: { start: number; end: number }
  /** `http://` or `https://` URL; per-request override. */
  proxy?: string
  signal?: AbortSignal
}

export type HttpResponseBody<R extends HttpResponseType> = R extends 'json'
  ? unknown
  : R extends 'bytes'
    ? Uint8Array
    : string

export interface HttpResponse<R extends HttpResponseType> {
  status: number
  /** Array form per spec §4 L1184; preserves duplicates (e.g. Set-Cookie). */
  headers: ReadonlyArray<HttpHeader>
  body: HttpResponseBody<R>
  /** URL after redirect chain (equals opts.url when no redirect occurred). */
  finalUrl: string
  /** True when at least one 3xx redirect was followed. */
  redirected: boolean
}

export interface HttpCapabilityHostOptions {
  cookieJar?: CookieJar
  defaultTimeoutMs?: number
  defaultMaxBodyBytes?: number
  /**
   * Manifest hostPermissions patterns this instance is confined to. When
   * present, the initial URL and every redirect hop must match one pattern
   * (empty array denies everything, mirroring eligibility rule I29).
   * Undefined skips host confinement — only for host-agnostic instances in
   * tests; the capability bridge always passes the manifest's list.
   */
  hostPermissions?: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Constants — spec §4 L1174 defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000

const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024 // 50 MB
const HARD_MAX_BODY_BYTES = 200 * 1024 * 1024 // 200 MB

const MAX_REDIRECTS = 10

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

// Shared dispatcher for non-proxied requests; per-call ProxyAgent is built
// fresh when `opts.proxy` is provided.
const sharedAgent = new Agent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new HttpError('plugin.http.invalid_url', `Invalid URL: ${raw}`)
  }
}

function checkScheme(parsed: URL): void {
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new HttpError(
      'plugin.http.scheme_not_allowed',
      `URL scheme '${parsed.protocol}' is not allowed; use http: or https:`
    )
  }
}

function clampTimeout(ms: number | undefined, defaultMs: number): number {
  // Reject non-finite values (NaN/Infinity) — http.get/post reach this with
  // unvalidated opts, and Math.min(MAX, NaN) is NaN, disabling the timeout.
  if (ms === undefined || !Number.isFinite(ms)) return defaultMs
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, ms))
}

function clampMaxBody(
  requested: number | undefined,
  defaultBytes: number
): number {
  // Only accept a finite, positive request. A NaN (Math.min(NaN, HARD) = NaN)
  // would disable the body cap entirely → unbounded heap on a large response;
  // 0 / negative would make every response fail as "too large". Anything else
  // falls back to the default. http.get/post pass these through unvalidated.
  const base =
    requested !== undefined && Number.isFinite(requested) && requested > 0
      ? requested
      : defaultBytes
  return Math.min(base, HARD_MAX_BODY_BYTES)
}

function headersArrayToRecord(
  arr: ReadonlyArray<HttpHeader>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of arr) {
    out[h.name.toLowerCase()] = h.value
  }
  return out
}

function headersToArray(
  raw: Record<string, string | string[] | undefined>
): HttpHeader[] {
  const out: HttpHeader[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: v })
    } else {
      out.push({ name, value })
    }
  }
  return out
}

function buildBodyPayload(body: HttpRequestBody): {
  bodyStr: string | Uint8Array
  contentType: string | null
} {
  if (body.type === 'json') {
    return {
      bodyStr: JSON.stringify(body.data),
      contentType: 'application/json',
    }
  }
  if (body.type === 'string') {
    return { bodyStr: body.data as string, contentType: null }
  }
  // bytes
  return { bodyStr: body.data as Uint8Array, contentType: null }
}

interface DispatcherLease {
  dispatcher: Dispatcher
  owned: boolean
}

function pickDispatcher(proxy: string | undefined): DispatcherLease {
  if (!proxy) return { dispatcher: sharedAgent, owned: false }

  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    throw new HttpError('plugin.http.invalid_proxy', 'Invalid proxy URL')
  }

  if (parsed.protocol === 'socks:' || parsed.protocol === 'socks5:') {
    // Undici 8.10's experimental SOCKS dispatcher does not own a TCP socket
    // until after the SOCKS greeting. Abort/destroy therefore cannot close a
    // proxy that accepts TCP and then stalls. Plugin-provided proxies cannot
    // use the app's managed SOCKS-to-HTTP bridge, so fail closed instead of
    // allowing an untrusted plugin to accumulate sockets and timers.
    throw new HttpError(
      'plugin.http.proxy_scheme_not_supported',
      'SOCKS proxies are not supported for plugin HTTP requests'
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(
      'plugin.http.proxy_scheme_not_supported',
      `Proxy scheme '${parsed.protocol}' is not supported`
    )
  }

  return {
    dispatcher: new ProxyAgent({ uri: parsed.toString() }),
    owned: true,
  }
}

async function destroyOwnedDispatcher(
  lease: DispatcherLease | undefined
): Promise<void> {
  if (!lease?.owned) return
  try {
    await lease.dispatcher.destroy()
  } catch {
    // Teardown must not replace the request's result with a cleanup failure.
  }
}

async function cancelResponseBody(body: unknown): Promise<void> {
  const responseBody = body as {
    destroy?: (error?: Error) => unknown
    cancel?: (reason?: unknown) => Promise<void>
    once?: (event: 'error', listener: () => void) => unknown
  }
  try {
    if (typeof responseBody.destroy === 'function') {
      // Undici BodyReadable emits RequestAbortedError asynchronously for an
      // intentional destroy. A surrounding try/catch cannot catch an Event
      // Emitter error, so attach the cleanup listener before destroying it.
      responseBody.once?.('error', () => undefined)
      responseBody.destroy()
      return
    }
    if (typeof responseBody.cancel === 'function') {
      await responseBody.cancel()
    }
  } catch {
    // Cancellation is best-effort and must not replace the original error.
  }
}

async function drainResponseBody(body: unknown): Promise<void> {
  const responseBody = body as { dump?: () => Promise<void> }
  try {
    if (typeof responseBody.dump === 'function') {
      await responseBody.dump()
      return
    }
  } catch {
    // Fall through to cancellation when draining fails.
  }
  await cancelResponseBody(body)
}

function abortError(
  signal: AbortSignal,
  timeoutMs: number
): HttpError | undefined {
  if (!signal.aborted) return undefined
  if (signal.reason === 'timeout') {
    return new HttpError(
      'plugin.http.timeout',
      `Request timed out after ${timeoutMs}ms`
    )
  }
  if (signal.reason === 'plugin_abort') {
    return new HttpError('plugin.http.aborted', 'Request aborted by plugin')
  }
  return new HttpError('plugin.http.aborted', 'Request aborted')
}

// ---------------------------------------------------------------------------
// HttpCapabilityHost
// ---------------------------------------------------------------------------

export class HttpCapabilityHost {
  private readonly cookieJar: CookieJar | undefined
  private readonly defaultTimeoutMs: number
  private readonly defaultMaxBodyBytes: number
  private readonly hostPermissions: ReadonlyArray<string> | undefined

  constructor(opts?: HttpCapabilityHostOptions) {
    this.cookieJar = opts?.cookieJar
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultMaxBodyBytes =
      opts?.defaultMaxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.hostPermissions = opts?.hostPermissions
  }

  private checkHostPermitted(url: string): void {
    if (this.hostPermissions === undefined) return
    if (urlMatchesHostPermissions(this.hostPermissions, url)) return
    throw new HttpError(
      'plugin.http.host_not_permitted',
      `URL is outside the plugin's hostPermissions: ${url}`
    )
  }

  // -------------------------------------------------------------------------
  // request
  // -------------------------------------------------------------------------

  async request<R extends HttpResponseType>(
    opts: HttpRequestOptions<R>
  ): Promise<HttpResponse<R>> {
    if (opts.responseType === undefined) {
      throw new HttpError(
        'plugin.http.response_type_required',
        'responseType is required (text | json | bytes)'
      )
    }

    const parsed = parseUrl(opts.url)
    checkScheme(parsed)
    this.checkHostPermitted(parsed.toString())

    const timeoutMs = clampTimeout(opts.timeoutMs, this.defaultTimeoutMs)
    const maxBodyBytes = clampMaxBody(
      opts.maxBodyBytes,
      this.defaultMaxBodyBytes
    )
    const method = (opts.method ?? 'GET').toUpperCase() as Dispatcher.HttpMethod
    const redirect = opts.redirect ?? 'follow'
    const useCookies = opts.cookies === 'jar'
    // ---- Outbound headers (Record, lowercased) ----
    const reqHeaders: Record<string, string> = {}
    if (opts.headers) {
      Object.assign(reqHeaders, headersArrayToRecord(opts.headers))
    }
    if (opts.range) {
      reqHeaders.range = `bytes=${opts.range.start}-${opts.range.end}`
    }

    // ---- Request body ----
    let bodyPayload: string | Uint8Array | undefined
    if (opts.body) {
      const { bodyStr, contentType } = buildBodyPayload(opts.body)
      bodyPayload = bodyStr
      if (contentType && !reqHeaders['content-type']) {
        reqHeaders['content-type'] = contentType
      }
    }

    // ---- Abort plumbing ----
    const internalCtrl = new AbortController()
    const cleanup: (() => void)[] = []

    const doCleanup = () => {
      for (const fn of cleanup) fn()
    }

    // ---- Per-hop loop ----
    let currentUrl = opts.url
    let redirected = false
    let hops = 0
    let lease: DispatcherLease | undefined

    try {
      if (opts.signal) {
        if (opts.signal.aborted) {
          throw new HttpError(
            'plugin.http.aborted',
            'Request aborted by plugin'
          )
        }
        const onPluginAbort = () => internalCtrl.abort('plugin_abort')
        opts.signal.addEventListener('abort', onPluginAbort, { once: true })
        cleanup.push(() =>
          opts.signal?.removeEventListener('abort', onPluginAbort)
        )
      }

      const timer = setTimeout(() => internalCtrl.abort('timeout'), timeoutMs)
      cleanup.push(() => clearTimeout(timer))

      lease = pickDispatcher(opts.proxy)

      while (true) {
        // Cookie jar inject (uses currentUrl so cookies follow the host).
        if (useCookies && this.cookieJar) {
          const cookieHeader = this.cookieJar.cookieHeader(currentUrl)
          if (cookieHeader) {
            reqHeaders.cookie = cookieHeader
          } else {
            // Drop a stale cookie header carried from a previous hop on a
            // different host.
            delete reqHeaders.cookie
          }
        }

        let response: Awaited<ReturnType<typeof undiciRequest>>
        try {
          response = await undiciRequest(currentUrl, {
            method,
            headers: reqHeaders,
            body: bodyPayload,
            signal: internalCtrl.signal,
            dispatcher: lease.dispatcher,
          })
        } catch (err: unknown) {
          const aborted = abortError(internalCtrl.signal, timeoutMs)
          if (aborted) throw aborted
          if (
            err instanceof Error &&
            (err.name === 'AbortError' ||
              err.name === 'DOMException' ||
              err.constructor?.name === 'DOMException')
          ) {
            throw new HttpError(
              'plugin.http.aborted',
              'Request aborted by plugin'
            )
          }
          throw new HttpError(
            'plugin.http.network',
            `Network error: ${err instanceof Error ? err.message : String(err)}`
          )
        }

        try {
          // Capture cookies from response on this hop.
          if (useCookies && this.cookieJar) {
            const rawSetCookie = response.headers['set-cookie']
            const arr = Array.isArray(rawSetCookie)
              ? rawSetCookie
              : typeof rawSetCookie === 'string'
                ? [rawSetCookie]
                : []
            if (arr.length > 0) {
              this.cookieJar.captureFromResponseHeaders(currentUrl, arr)
            }
          }

          const status = response.statusCode
          const location = response.headers.location
          const isRedirect = status >= 300 && status < 400 && location

          if (isRedirect) {
            if (redirect === 'manual') {
              // Surface the 3xx as-is.
              return await buildResponse<R>(
                response,
                opts.responseType,
                maxBodyBytes,
                timeoutMs,
                internalCtrl,
                currentUrl,
                redirected
              )
            }
            if (redirect === 'error') {
              await drainResponseBody(response.body)
              throw new HttpError(
                'plugin.http.redirect_not_allowed',
                `redirect: 'error' set; refusing to follow ${status} to ${location}`
              )
            }
            // redirect === 'follow'
            if (hops >= MAX_REDIRECTS) {
              await drainResponseBody(response.body)
              throw new HttpError(
                'plugin.http.too_many_redirects',
                `Too many redirects (>${MAX_REDIRECTS})`
              )
            }
            await drainResponseBody(response.body)
            const loc = Array.isArray(location) ? (location[0] ?? '') : location
            const nextUrl = new URL(loc, currentUrl)
            // Re-validate the scheme and host confinement on every hop. Both
            // only ran on the initial URL, so a 3xx Location to file:// (or to
            // a host outside hostPermissions) would otherwise escape.
            checkScheme(nextUrl)
            this.checkHostPermitted(nextUrl.toString())
            currentUrl = nextUrl.toString()
            redirected = true
            hops += 1
            continue
          }

          return await buildResponse<R>(
            response,
            opts.responseType,
            maxBodyBytes,
            timeoutMs,
            internalCtrl,
            currentUrl,
            redirected
          )
        } catch (error) {
          await cancelResponseBody(response.body)
          throw error
        }
      }
    } finally {
      doCleanup()
      await destroyOwnedDispatcher(lease)
    }
  }

  // -------------------------------------------------------------------------
  // get / post — internal default responseType = 'text' so external callers
  // can use ergonomic shorthand without violating M10 at the host edge.
  // -------------------------------------------------------------------------

  get<R extends HttpResponseType = 'text'>(
    url: string,
    opts?: Omit<
      HttpRequestOptions<R>,
      'url' | 'method' | 'body' | 'responseType'
    > & {
      responseType?: R
    }
  ): Promise<HttpResponse<R>> {
    return this.request<R>({
      ...(opts as object),
      url,
      method: 'GET',
      responseType: (opts?.responseType ?? 'text') as R,
    } as HttpRequestOptions<R>)
  }

  post<R extends HttpResponseType = 'text'>(
    url: string,
    body: HttpRequestBody,
    opts?: Omit<
      HttpRequestOptions<R>,
      'url' | 'method' | 'body' | 'responseType'
    > & {
      responseType?: R
    }
  ): Promise<HttpResponse<R>> {
    return this.request<R>({
      ...(opts as object),
      url,
      method: 'POST',
      body,
      responseType: (opts?.responseType ?? 'text') as R,
    } as HttpRequestOptions<R>)
  }
}

// ---------------------------------------------------------------------------
// Helper: drain body + assemble HttpResponse
// ---------------------------------------------------------------------------

async function buildResponse<R extends HttpResponseType>(
  response: Awaited<ReturnType<typeof undiciRequest>>,
  responseType: R,
  maxBodyBytes: number,
  timeoutMs: number,
  internalCtrl: AbortController,
  finalUrl: string,
  redirected: boolean
): Promise<HttpResponse<R>> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let capped = false
  try {
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.byteLength
      if (totalBytes > maxBodyBytes) {
        capped = true
        internalCtrl.abort('body_too_large')
        await cancelResponseBody(response.body)
        break
      }
      chunks.push(buf)
    }
  } catch (error) {
    await cancelResponseBody(response.body)
    if (!capped) {
      const aborted = abortError(internalCtrl.signal, timeoutMs)
      if (aborted) throw aborted
      throw new HttpError(
        'plugin.http.network',
        `Network error while reading response body: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (capped) {
    throw new HttpError(
      'plugin.http.response_too_large',
      `Response body exceeded ${maxBodyBytes} bytes`
    )
  }

  const aborted = abortError(internalCtrl.signal, timeoutMs)
  if (aborted) throw aborted

  const rawBody = Buffer.concat(chunks)
  let parsedBody: unknown
  if (responseType === 'bytes') {
    parsedBody = new Uint8Array(
      rawBody.buffer,
      rawBody.byteOffset,
      rawBody.byteLength
    )
  } else if (responseType === 'json') {
    parsedBody = JSON.parse(rawBody.toString('utf8'))
  } else {
    parsedBody = rawBody.toString('utf8')
  }

  return {
    status: response.statusCode,
    headers: headersToArray(
      response.headers as Record<string, string | string[] | undefined>
    ),
    body: parsedBody as HttpResponseBody<R>,
    finalUrl,
    redirected,
  }
}
