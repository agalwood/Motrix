import { classifyMediaUrl, inferMediaMimeType } from '@/shared/media'

/**
 * Body inspection is deliberately small and bounded. A content script must not
 * turn a large streaming response into an in-memory copy just to discover a
 * manifest URL.
 */
export const MEDIA_BODY_LIMITS = {
  maxBytes: 256 * 1024,
  maxChunks: 64,
  maxJsonDepth: 6,
  maxJsonNodes: 2_000,
  maxCandidates: 100,
  maxStringLength: 32_768,
} as const

export interface BodyMediaCandidate {
  url: string
  contentType?: string
  evidence: Array<'body-hls' | 'body-dash' | 'body-json'>
}

function bareContentType(contentType?: string): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function resolveHttpUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MEDIA_BODY_LIMITS.maxStringLength) {
    return null
  }
  try {
    const parsed = new URL(trimmed, baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function playlistUrls(
  body: string,
  baseUrl: string
): Array<{ url: string; forceHls: boolean }> {
  const urls: Array<{ url: string; forceHls: boolean }> = []
  let expectsVariantUri = false
  for (const rawLine of body.split(/\r?\n/)) {
    if (urls.length >= MEDIA_BODY_LIMITS.maxCandidates) break
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF(?::|$)/i.test(line)) {
        expectsVariantUri = true
      }
      if (/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)(?::|$)/i.test(line)) {
        const uri = /(?:^|,)URI=(?:"([^"]+)"|([^,]+))/i.exec(line)
        const url = resolveHttpUrl(uri?.[1] ?? uri?.[2] ?? '', baseUrl)
        if (url) urls.push({ url, forceHls: true })
      }
      continue
    }
    const url = resolveHttpUrl(line, baseUrl)
    const forceHls = expectsVariantUri
    expectsVariantUri = false
    if (!url) continue
    const kind = classifyMediaUrl(url)
    // Nested playlists are useful. Media segments are intentionally ignored.
    if (forceHls || kind === 'hls') {
      urls.push({ url, forceHls: true })
    } else if (kind === 'dash') {
      urls.push({ url, forceHls: false })
    }
  }
  return urls
}

function jsonMediaUrls(value: unknown, baseUrl: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  let visitedNodes = 0

  const visit = (node: unknown, depth: number): void => {
    if (
      depth > MEDIA_BODY_LIMITS.maxJsonDepth ||
      visitedNodes >= MEDIA_BODY_LIMITS.maxJsonNodes ||
      urls.length >= MEDIA_BODY_LIMITS.maxCandidates
    ) {
      return
    }
    visitedNodes += 1

    if (typeof node === 'string') {
      const url = resolveHttpUrl(node, baseUrl)
      if (!url || seen.has(url) || classifyMediaUrl(url) === null) return
      seen.add(url)
      urls.push(url)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const child of Object.values(node as Record<string, unknown>)) {
      visit(child, depth + 1)
      if (
        visitedNodes >= MEDIA_BODY_LIMITS.maxJsonNodes ||
        urls.length >= MEDIA_BODY_LIMITS.maxCandidates
      ) {
        break
      }
    }
  }

  visit(value, 0)
  return urls
}

/** Inspect an already-bounded response body for manifests and media URLs. */
export function inspectMediaBodyText(
  body: string,
  responseUrl: string,
  contentType?: string
): BodyMediaCandidate[] {
  if (body.length === 0 || body.length > MEDIA_BODY_LIMITS.maxBytes) return []
  const trimmed = body.trimStart()
  const type = bareContentType(contentType)
  const candidates: BodyMediaCandidate[] = []
  const seen = new Set<string>()
  const add = (
    value: string,
    candidateType: string | undefined,
    evidence: BodyMediaCandidate['evidence'][number]
  ): void => {
    if (candidates.length >= MEDIA_BODY_LIMITS.maxCandidates) return
    const url = resolveHttpUrl(value, responseUrl)
    if (!url || seen.has(url)) return
    seen.add(url)
    candidates.push({
      url,
      ...(candidateType ? { contentType: candidateType } : {}),
      evidence: [evidence],
    })
  }

  if (trimmed.startsWith('#EXTM3U')) {
    add(responseUrl, 'application/vnd.apple.mpegurl', 'body-hls')
    for (const candidate of playlistUrls(body, responseUrl)) {
      add(
        candidate.url,
        candidate.forceHls
          ? 'application/vnd.apple.mpegurl'
          : (inferMediaMimeType(candidate.url) ?? undefined),
        'body-hls'
      )
    }
  }

  if (/^(?:<\?xml[^>]*>\s*)?<MPD\b/i.test(trimmed)) {
    add(responseUrl, 'application/dash+xml', 'body-dash')
  }

  const looksJson =
    type === 'application/json' ||
    type.endsWith('+json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  if (looksJson) {
    try {
      const parsed = JSON.parse(body) as unknown
      for (const url of jsonMediaUrls(parsed, responseUrl)) {
        add(url, inferMediaMimeType(url) ?? undefined, 'body-json')
      }
    } catch {
      // A mislabeled or truncated JSON response is not useful evidence.
    }
  }

  return candidates
}

function declaredBodyLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Read a cloned fetch response without ever consuming the response returned to
 * the page. Oversized or over-fragmented clones are cancelled and discarded.
 */
export async function readBoundedResponseText(
  response: Response,
  onBytesRead?: (byteLength: number) => void
): Promise<string | null> {
  const declaredLength = declaredBodyLength(response)
  if (declaredLength !== null && declaredLength > MEDIA_BODY_LIMITS.maxBytes) {
    return null
  }

  if (!response.body) {
    try {
      const text = await response.text()
      const byteLength = new TextEncoder().encode(text).byteLength
      if (byteLength > MEDIA_BODY_LIMITS.maxBytes) return null
      onBytesRead?.(byteLength)
      return text
    } catch {
      return null
    }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let chunkCount = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunkCount += 1
      byteLength += next.value.byteLength
      if (
        chunkCount > MEDIA_BODY_LIMITS.maxChunks ||
        byteLength > MEDIA_BODY_LIMITS.maxBytes
      ) {
        // A cloned Response is a tee. Awaiting cancellation can block until
        // the page consumes/cancels its original branch, so cancel in the
        // background and settle our observation immediately.
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    void reader.cancel().catch(() => undefined)
    return null
  }

  const combined = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  onBytesRead?.(byteLength)
  return new TextDecoder().decode(combined)
}

export async function inspectFetchResponseBody(
  response: Response,
  fallbackUrl: string,
  onBytesRead?: (byteLength: number) => void
): Promise<BodyMediaCandidate[]> {
  let clone: Response
  try {
    clone = response.clone()
  } catch {
    return []
  }
  const text = await readBoundedResponseText(clone, onBytesRead)
  if (text === null) return []
  return inspectMediaBodyText(
    text,
    response.url || fallbackUrl,
    response.headers.get('content-type') ?? undefined
  )
}
