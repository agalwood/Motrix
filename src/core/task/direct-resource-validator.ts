import type { DirectResourceValidator } from '@shared/schemas/direct-replay-recipe'

const DEFAULT_TIMEOUT_MS = 3_000

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

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
      globalThis.fetch(input, init),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly now: () => number = Date.now
  ) {}

  async capture(uri: string): Promise<DirectResourceValidator | null> {
    const response = await this.request(uri, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'identity' },
    })
    if (!response?.ok) return null
    return readValidator(response.headers, this.now())
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
}

function readValidator(
  headers: Headers,
  capturedAt: number
): DirectResourceValidator | null {
  const contentLength = parseContentLength(headers.get('content-length'))
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
