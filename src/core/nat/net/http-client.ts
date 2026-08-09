import http from 'node:http'
import {
  isIpv4String,
  isLinkLocalIpv4,
  isPrivateIpv4,
} from '@core/nat/codecs/ip-utils'
import {
  type ParseResult,
  parseErr,
  parseOk,
} from '@core/nat/codecs/parse-result'
import { ErrorCode } from '@shared/errors'

export const HTTP_MAX_RESPONSE_SIZE = 128 * 1024 // 128KB cap
export const HTTP_DEFAULT_TIMEOUT_MS = 5000

export interface HttpRequestInput {
  method: 'GET' | 'POST'
  host: string // MUST be literal IPv4 in private/link-local range
  port: number
  path: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HttpResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

export interface HttpClient {
  request(input: HttpRequestInput): Promise<ParseResult<HttpResponse>>
}

export class NodeHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<ParseResult<HttpResponse>> {
    // Enforce IP-literal host (prevents DNS resolution and thus DNS rebinding)
    if (!isIpv4String(input.host)) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'host must be literal IPv4'
      )
    }
    if (!isPrivateIpv4(input.host) && !isLinkLocalIpv4(input.host)) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'host must be private or link-local IPv4'
      )
    }

    const timeoutMs = input.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS

    return new Promise<ParseResult<HttpResponse>>((resolve) => {
      let settled = false
      const settle = (r: ParseResult<HttpResponse>) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(r)
      }

      const req = http.request(
        {
          method: input.method,
          host: input.host,
          port: input.port,
          path: input.path,
          headers: input.headers ?? {},
          // Prevent any hostname resolution path by omitting 'lookup' and passing only literal IP
          family: 4,
        },
        (res) => {
          const status = res.statusCode ?? 0
          // Reject 3xx as protocol error — never follow redirects
          if (status >= 300 && status < 400) {
            res.destroy()
            return settle(
              parseErr(
                ErrorCode.NatSecurityViolation,
                `unexpected redirect: ${status}`
              )
            )
          }
          let bytes = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > HTTP_MAX_RESPONSE_SIZE) {
              res.destroy()
              return settle(
                parseErr(
                  ErrorCode.NatSecurityViolation,
                  'http response too large'
                )
              )
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              headers[k.toLowerCase()] = Array.isArray(v)
                ? v.join(',')
                : (v ?? '')
            }
            settle(parseOk({ statusCode: status, headers, body }))
          })
          res.on('error', (e) =>
            settle(parseErr(ErrorCode.NatParseError, e.message))
          )
        }
      )

      req.setTimeout(timeoutMs, () => {
        req.destroy()
        settle(
          parseErr(ErrorCode.NatTimeout, `http timeout after ${timeoutMs}ms`)
        )
      })

      req.on('error', (e) => {
        settle(parseErr(ErrorCode.NatGatewayUnreachable, e.message))
      })

      const onAbort = () => {
        req.destroy()
        settle(parseErr(ErrorCode.NatTimeout, 'aborted'))
      }
      if (input.signal) {
        if (input.signal.aborted) {
          onAbort()
          return
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
      }

      function cleanup() {
        input.signal?.removeEventListener('abort', onAbort)
      }

      if (input.body !== undefined) {
        req.end(input.body)
      } else {
        req.end()
      }
    })
  }
}

export const nodeHttpClient: HttpClient = new NodeHttpClient()
