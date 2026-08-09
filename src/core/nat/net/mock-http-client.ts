import {
  type ParseResult,
  parseErr,
  parseOk,
} from '@core/nat/codecs/parse-result'
import { ErrorCode } from '@shared/errors'
import type { HttpClient, HttpRequestInput, HttpResponse } from './http-client'

interface Expectation {
  method: 'GET' | 'POST'
  host: string
  port: number
  path: string
  responseStatus: number
  responseHeaders: Record<string, string>
  responseBody: string
  delayMs: number
  consumed: boolean
}

interface ExpectationBuilder {
  delay(ms: number): ExpectationBuilder
  reply(args: {
    statusCode: number
    headers?: Record<string, string>
    body?: string
  }): ExpectationBuilder
}

export interface MockHttpHistory {
  expect(input: {
    method: 'GET' | 'POST'
    host: string
    port: number
    path: string
  }): ExpectationBuilder
  calls: HttpRequestInput[]
}

export function createMockHttpClient(): {
  client: HttpClient
  history: MockHttpHistory
} {
  const expectations: Expectation[] = []
  const calls: HttpRequestInput[] = []

  const client: HttpClient = {
    async request(input: HttpRequestInput): Promise<ParseResult<HttpResponse>> {
      calls.push(input)
      const match = expectations.find(
        (e) =>
          !e.consumed &&
          e.method === input.method &&
          e.host === input.host &&
          e.port === input.port &&
          e.path === input.path
      )
      if (!match) {
        return parseErr(
          ErrorCode.NatParseError,
          `no expectation for ${input.method} ${input.host}:${input.port}${input.path}`
        )
      }
      match.consumed = true
      if (match.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, match.delayMs)
          input.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true }
          )
        })
      }
      if (input.signal?.aborted) {
        return parseErr(ErrorCode.NatTimeout, 'aborted')
      }
      if (match.responseStatus >= 300 && match.responseStatus < 400) {
        return parseErr(
          ErrorCode.NatSecurityViolation,
          `unexpected redirect: ${match.responseStatus}`
        )
      }
      return parseOk({
        statusCode: match.responseStatus,
        headers: match.responseHeaders,
        body: match.responseBody,
      })
    },
  }

  const history: MockHttpHistory = {
    expect(input) {
      const exp: Expectation = {
        ...input,
        responseStatus: 200,
        responseHeaders: {},
        responseBody: '',
        delayMs: 0,
        consumed: false,
      }
      expectations.push(exp)
      const builder: ExpectationBuilder = {
        delay(ms: number) {
          exp.delayMs = ms
          return builder
        },
        reply({ statusCode, headers, body }) {
          exp.responseStatus = statusCode
          exp.responseHeaders = headers ?? {}
          exp.responseBody = body ?? ''
          return builder
        },
      }
      return builder
    },
    calls,
  }

  return { client, history }
}
