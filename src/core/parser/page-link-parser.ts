import { extractExtension } from '@shared/lib/path-ext'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type PageLinkResource,
  type ParsePageLinksResult,
  parsePageLinksRequestSchema,
} from '@shared/schemas/page-parse'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_LINKS = 500

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

// biome-ignore lint/complexity/useRegexLiterals: avoids a literal control range
const FILENAME_FORBIDDEN = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001F]', 'g')

/** Minimal structural shape of a fetch Response (real Response satisfies it). */
export interface PageFetchResponse {
  url: string
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
  text(): Promise<string>
}

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<PageFetchResponse>

export interface PageLinkParserOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike
  timeoutMs?: number
  maxBodyBytes?: number
  maxLinks?: number
  /** Extension whitelist: only links whose path extension is in the set are
   *  surfaced. An empty/absent set yields no links (pure whitelist). */
  extensionFilter?: ReadonlySet<string>
}

/**
 * Host-neutral AutoParser service: fetches a page and statically extracts its
 * downloadable file links. No page scripts are executed - links must appear in
 * the served HTML (markup, attributes, or inline script/JSON payloads).
 */
export class PageLinkParser {
  private readonly fetchLike: FetchLike
  private readonly timeoutMs: number
  private readonly maxBodyBytes: number
  private readonly maxLinks: number
  private readonly extensionFilter?: ExtractPageLinksInput['extensionFilter']

  constructor(options: PageLinkParserOptions = {}) {
    this.fetchLike =
      options.fetch ??
      ((input: string, init?: RequestInit) =>
        globalThis.fetch(input, init) as Promise<PageFetchResponse>)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS
    this.extensionFilter = options.extensionFilter
  }

  async parse(input: unknown): Promise<ParsePageLinksResult> {
    const parsed = parsePageLinksRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.IpcInvalidPayload,
        'invalid ParsePageLinks payload'
      )
    }
    const request = parsed.data
    const pageUrl = this.requireHttpUrl(request.url)

    let response: PageFetchResponse
    try {
      response = await this.fetchLike(pageUrl, {
        redirect: 'follow',
        headers: this.buildHeaders(request.headers),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        ErrorCode.PageParseFailed,
        `failed to fetch page: ${(error as Error)?.message ?? error}`,
        error
      )
    }
    if (!response.ok) {
      throw new AppError(
        ErrorCode.PageParseFailed,
        `page request failed with HTTP ${response.status}`
      )
    }

    const html = await this.readCappedBody(response)
    const finalUrl = response.url || pageUrl
    return extractPageLinks({
      pageUrl,
      finalUrl,
      html,
      maxLinks: this.maxLinks,
      extensionFilter: this.extensionFilter,
    })
  }

  private requireHttpUrl(raw: string): string {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new AppError(ErrorCode.PageParseFailed, `invalid page URL: ${raw}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError(
        ErrorCode.PageParseFailed,
        `unsupported page URL protocol: ${url.protocol}`
      )
    }
    return url.toString()
  }

  private buildHeaders(
    headers: ReadonlyArray<{ name: string; value: string }>
  ) {
    const out = new Headers()
    let hasUserAgent = false
    for (const { name, value } of headers) {
      out.set(name, value)
      if (name.toLowerCase() === 'user-agent') hasUserAgent = true
    }
    // A browser-like UA avoids bot walls on many download pages.
    if (!hasUserAgent) out.set('User-Agent', DEFAULT_USER_AGENT)
    return out
  }

  /** Reads the body up to `maxBodyBytes`; the truncated prefix still parses. */
  private async readCappedBody(response: PageFetchResponse): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return response.text()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > this.maxBodyBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    return text
  }
}

// ── Static extraction (pure, unit-testable without network) ─────────────

const ATTRIBUTE_NAME =
  'href|src|data-src|data-url|data-href|data-file|data-download'
const ATTRIBUTE_RE = new RegExp(
  `\\s(?:${ATTRIBUTE_NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  'gi'
)
const SRCSET_RE = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>\\)\]}]+/gi
const BASE_HREF_RE = /<base\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(amp|lt|gt|quot|#39|apos|nbsp);/g,
    (match) => HTML_ENTITY_MAP[match] ?? match
  )
}

function sanitizeFilename(name: string): string {
  const cleaned = decodeHtmlEntities(name)
    .replace(FILENAME_FORBIDDEN, '_')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 255) : ''
}

function safeDecodeUri(component: string): string {
  try {
    return decodeURIComponent(component)
  } catch {
    return component
  }
}

function filenameFromUrl(url: URL, fallbackIndex: number): string {
  const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? ''
  const decoded = sanitizeFilename(safeDecodeUri(lastSegment))
  if (decoded) return decoded
  return `file-${fallbackIndex + 1}`
}

export interface ExtractPageLinksInput {
  pageUrl: string
  finalUrl: string
  html: string
  maxLinks?: number
  /** Extension whitelist: only links whose path extension is in the set are
   *  surfaced. An empty/absent set yields no links (pure whitelist). */
  extensionFilter?: ReadonlySet<string>
}

/** Viewer-to-download URL rewrites. Model hosts (ModelScope, HuggingFace)
 * link file rows to HTML viewer pages (`…/file/view/master/x.bin`,
 * `…/blob/main/x.bin`); the raw file is served from the parallel
 * `…/resolve/…` path. The download button constructs that URL in JS, so
 * it never appears in the DOM — we rewrite the viewer URL instead. */
const VIEWER_URL_REWRITES: ReadonlyArray<{
  hostSuffix: string
  viewerSegment: string
}> = [
  { hostSuffix: '.modelscope.cn', viewerSegment: '/file/view/' },
  { hostSuffix: 'huggingface.co', viewerSegment: '/blob/' },
  { hostSuffix: '.hf-mirror.com', viewerSegment: '/blob/' },
]

function rewriteViewerUrl(resolved: URL): URL {
  const host = resolved.hostname.toLowerCase()
  for (const rule of VIEWER_URL_REWRITES) {
    const bare = rule.hostSuffix.replace(/^\./, '')
    if (host !== bare && !host.endsWith(rule.hostSuffix)) continue
    const idx = resolved.pathname.indexOf(rule.viewerSegment)
    if (idx < 0) continue
    const rewritten = new URL(resolved.toString())
    rewritten.pathname = resolved.pathname.replace(
      rule.viewerSegment,
      '/resolve/'
    )
    // Viewer query params (e.g. ?status=2) are meaningless for the file
    // endpoint; stripping them also collapses duplicate rows cleanly.
    rewritten.search = ''
    return rewritten
  }
  return resolved
}

/**
 * Extract downloadable links from raw HTML. Candidates come from link/media
 * attributes, srcset entries, and absolute URLs inside inline scripts
 * (JSON payloads rendered by the page). Relative candidates resolve against
 * `<base href>` (or the final URL), duplicates collapse, and only links
 * whose path extension matches the whitelist survive.
 */
export function extractPageLinks(
  input: ExtractPageLinksInput
): ParsePageLinksResult {
  const { pageUrl, finalUrl, html } = input

  const baseMatch = BASE_HREF_RE.exec(html)
  let baseHref: string | undefined
  if (baseMatch) baseHref = baseMatch[1] ?? baseMatch[2] ?? undefined

  return extractPageLinksFromCandidates({
    pageUrl,
    finalUrl,
    candidates: collectCandidates(html),
    title: extractHtmlTitle(html),
    baseHref,
    maxLinks: input.maxLinks,
    extensionFilter: input.extensionFilter,
  })
}

function extractHtmlTitle(html: string): string | null {
  const titleMatch = TITLE_RE.exec(html)
  return titleMatch
    ? decodeHtmlEntities(titleMatch[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    : null
}

export interface ExtractPageLinksFromCandidatesInput {
  pageUrl: string
  finalUrl: string
  /** Explicit candidate URLs (already collected by the caller). */
  candidates: Iterable<string>
  title?: string | null
  /** Base for resolving relative candidates; defaults to the final URL. */
  baseHref?: string
  maxLinks?: number
  /** Extension whitelist: only links whose path extension is in the set are
   *  surfaced. An empty/absent set yields no links (pure whitelist). */
  extensionFilter?: ReadonlySet<string>
}

/**
 * Shared resolve→rewrite→dedupe→filter pipeline over explicit candidate
 * URLs. The rendered-DOM parser feeds this with anchors collected from the
 * live DOM, so page chrome loaded via script/img tags (e.g. ModelScope's
 * `<script src="…alicdn.com/…/modelscope-fe.json">` app manifest) never
 * enters the candidate set and cannot masquerade as downloadable content.
 */
export function extractPageLinksFromCandidates(
  input: ExtractPageLinksFromCandidatesInput
): ParsePageLinksResult {
  const { pageUrl, finalUrl } = input
  const maxLinks = input.maxLinks ?? DEFAULT_MAX_LINKS

  let base: URL
  try {
    base = input.baseHref
      ? new URL(input.baseHref, finalUrl)
      : new URL(finalUrl)
  } catch {
    base = new URL(finalUrl)
  }

  const seen = new Set<string>()
  const links: PageLinkResource[] = []

  for (const raw of input.candidates) {
    if (links.length >= maxLinks) break
    let resolved: URL
    try {
      resolved = new URL(raw, base)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      continue
    }
    // Fragment-only variants of the same resource are the same download.
    resolved.hash = ''
    // Model hosts expose viewer URLs where the download button would use
    // the parallel resolve URL — swap before filtering/dedupe so queued
    // tasks fetch the raw file instead of the viewer page.
    resolved = rewriteViewerUrl(resolved)
    const dedupeKey = resolved.toString()
    if (seen.has(dedupeKey)) continue

    const pathname = safeDecodeUri(resolved.pathname)
    const extension = extractExtension(pathname)
    // Pure whitelist: only links whose path extension matches the user
    // whitelist survive. A missing extension can never match.
    if (!extension || !input.extensionFilter?.has(extension)) continue

    seen.add(dedupeKey)
    links.push({
      index: links.length,
      url: dedupeKey,
      filename: filenameFromUrl(resolved, links.length),
      extension,
      size: null,
    })
  }

  return { pageUrl, finalUrl, title: input.title ?? null, links }
}

function collectCandidates(html: string): string[] {
  const candidates: string[] = []

  // Strip script/link open tags before the attribute scan: their src/href
  // are page chrome (app manifests like ModelScope's
  // <script src="…alicdn.com/…/modelscope-fe.json">, favicons,
  // stylesheets) — never downloads. A manifest whose extension matches
  // the user whitelist would otherwise surface as a phantom file. Script
  // BODIES are still scanned below via SCRIPT_BLOCK_RE.
  const stripped = html
    .replace(/<script\b[^>]*>/gi, '<script>')
    .replace(/<link\b[^>]*\/?>/gi, '')

  for (const match of stripped.matchAll(ATTRIBUTE_RE)) {
    const value = match[1] ?? match[2]
    if (value) candidates.push(value.trim())
  }

  for (const match of stripped.matchAll(SRCSET_RE)) {
    const value = match[1] ?? match[2] ?? ''
    for (const part of value.split(',')) {
      const url = part.trim().split(/\s+/)[0]
      if (url) candidates.push(url)
    }
  }

  // Inline scripts often embed the real download endpoints in JSON payloads;
  // scan only those blocks so stylesheets/markup noise stays out.
  for (const match of html.matchAll(SCRIPT_BLOCK_RE)) {
    const block = match[1] ?? ''
    for (const url of block.match(ABSOLUTE_URL_RE) ?? []) {
      candidates.push(url)
    }
  }

  return candidates
}