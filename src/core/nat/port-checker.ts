import { ErrorCode } from '@shared/errors'
import type { ParseResult } from './codecs/parse-result'
import { parseErr, parseOk } from './codecs/parse-result'
import { natLogger } from './logger'

const log = natLogger('port-checker')
const MAX_ENDPOINTS = 10

export interface PortCheckResult {
  reachable: boolean
  rawBody: string
}

export type FetchFn = (
  url: string,
  options: { timeoutMs: number; signal?: AbortSignal }
) => Promise<{ ok: boolean; body: string }>

export interface PortCheckerOptions {
  fetcher?: FetchFn
}

export interface CheckPortOptions {
  endpoints: string[] // https:// URLs only
  externalIp: string
  port: number
  timeoutMs: number
  signal?: AbortSignal
}

export class PortChecker {
  private readonly fetcher: FetchFn

  constructor(opts: PortCheckerOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultFetch
  }

  async checkPortReachable(
    options: CheckPortOptions
  ): Promise<ParseResult<PortCheckResult>> {
    if (options.endpoints.length === 0) {
      return parseErr(
        ErrorCode.NatTimeout,
        'no port-checker endpoints configured'
      )
    }
    if (options.endpoints.length > MAX_ENDPOINTS) {
      return parseErr(ErrorCode.NatTimeout, 'too many port-checker endpoints')
    }
    const nonHttps = options.endpoints.find((e) => !e.startsWith('https://'))
    if (nonHttps) {
      return parseErr(ErrorCode.NatSecurityViolation, 'endpoint must use HTTPS')
    }
    for (const endpoint of options.endpoints) {
      const url = composeUrl(endpoint, options.externalIp, options.port)
      try {
        const { ok, body } = await this.fetcher(url, {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        })
        if (!ok) continue
        const reachable = decodeReachability(body)
        return parseOk({ reachable, rawBody: body })
      } catch (err) {
        log.warn({ err, endpoint }, 'port-checker endpoint failed')
      }
    }
    return parseErr(ErrorCode.NatTimeout, 'all port-checker endpoints failed')
  }
}

function decodeReachability(body: string): boolean {
  const NEGATIVE =
    /\b(unreachable|not\s+reachable|false|closed|failure|failed)\b/i
  const POSITIVE = /\b(reachable|true|open|success)\b/i
  if (NEGATIVE.test(body)) return false
  return POSITIVE.test(body)
}

function composeUrl(endpoint: string, ip: string, port: number): string {
  const sep = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${sep}ip=${encodeURIComponent(ip)}&port=${port}`
}

async function defaultFetch(
  url: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<{ ok: boolean; body: string }> {
  // Intentionally uses global fetch, which is available in Node 20+.
  // This is the ONE place in the NAT module where an external host is
  // contacted, and only if the caller has explicitly enabled
  // portReachabilityCheckEnabled.
  const safeTimeout = Math.max(1, options.timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), safeTimeout)
  const forwardedAbort = () => controller.abort()
  if (options.signal) {
    options.signal.addEventListener('abort', forwardedAbort, { once: true })
  }
  try {
    const res = await fetch(url, { signal: controller.signal })
    const body = await res.text()
    return { ok: res.ok, body }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardedAbort)
  }
}
