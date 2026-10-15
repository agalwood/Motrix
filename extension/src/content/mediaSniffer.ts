import {
  inspectFetchResponseBody,
  inspectMediaBodyText,
  MEDIA_BODY_LIMITS,
} from '@/content/mediaBodySniffer'
import { isWebStoreBuild } from '@/shared/buildFlags'
import {
  classifyMediaUrl,
  type DetectedMedia,
  inferMediaMimeType,
  type MediaCategory,
  mediaCategory,
  shouldExcludeHost,
} from '@/shared/media'

export interface SnifferPageContext {
  pageUrl: string
  pageTitle: string
}

export interface SnifferHandle {
  /** Harvest the current DOM and Resource Timing buffer without reinstalling hooks. */
  scan: (ctx?: SnifferPageContext) => void
  uninstall: () => void
}

type MediaEvidence =
  | 'img'
  | 'picture'
  | 'source'
  | 'video'
  | 'audio'
  | 'poster'
  | 'srcset'
  | 'current-src'
  | 'lazy'
  | 'css-background'
  | 'css-pseudo'
  | 'meta'
  | 'link'
  | 'input-image'
  | 'performance'
  | 'fetch'
  | 'xhr'
  | 'body-hls'
  | 'body-dash'
  | 'body-json'

export interface MediaUrlCandidate {
  url: string
  contentType?: string
  category?: MediaCategory
  width?: number
  height?: number
  alt?: string
  suggestedFilename?: string
  sizeBytes?: number
  previewable?: boolean
  evidence?: MediaEvidence[]
}

const MAX_REPORT_ITEMS = 100
const MAX_DOM_MEDIA_ELEMENTS = 1_200
const MAX_DOM_STYLE_ELEMENTS = 400
const MAX_DOM_CANDIDATES = 2_000
const MAX_PERFORMANCE_ENTRIES = 2_000
const MAX_RESOURCE_KEYS = 4_096
const MAX_BODY_INSPECTIONS_PER_SECOND = 8
const MAX_BODY_BYTES_PER_SECOND = 512 * 1024
const MAX_CONCURRENT_BODY_INSPECTIONS = 2
const MAX_MUTATION_ROOTS = 200
const MUTATION_BATCH_MS = 120
const MUTATION_WORK_WINDOW_MS = 1_000
const MAX_MUTATION_FLUSHES_PER_WINDOW = 4
const MAX_MUTATION_ROOT_WORK_PER_WINDOW = 400
const MAX_CANDIDATE_URL_LENGTH = 32_768
const MAX_SRCSET_LENGTH = 64 * 1024
const MAX_SRCSET_CANDIDATES = 32
const MIN_IMAGE_EDGE = 48
const MIN_IMAGE_AREA = 4_096
const MAX_TEXT_METADATA = 512
const LAZY_URL_ATTRIBUTES = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-url',
  'data-flickity-lazyload',
  'data-splide-lazy',
  'data-bg',
  'data-background-image',
  'data-thumb',
  'data-image',
] as const
const LAZY_SRCSET_ATTRIBUTES = ['data-srcset', 'data-lazy-srcset'] as const

const DOM_MEDIA_SELECTOR = [
  'video',
  'audio',
  'img',
  'video source',
  'audio source',
  'picture source',
  'input[type="image"]',
  'meta[property^="og:image"]',
  'meta[property^="og:video"]',
  'meta[property^="og:audio"]',
  'meta[name^="twitter:image"]',
  'meta[name^="twitter:player:stream"]',
  'meta[itemprop="image"]',
  'meta[itemprop="thumbnailUrl"]',
  'meta[itemprop="contentUrl"]',
  'link[rel~="image_src"]',
  'link[rel~="preload"][as="image"]',
  'link[rel~="preload"][as="video"]',
  'link[rel~="preload"][as="audio"]',
  ...LAZY_URL_ATTRIBUTES.map((attribute) => `[${attribute}]`),
  ...LAZY_SRCSET_ATTRIBUTES.map((attribute) => `[${attribute}]`),
].join(',')

const DOM_STYLE_SELECTOR = '[style], [class], [id]'

const STREAM_SEGMENT_RE =
  /\.(?:ts|m4s|cmfv|cmfa)(?:$|[?#])|\/(?:seg(?:ment)?|frag(?:ment)?|chunk)[-_./]?\d+[^/]*(?:$|[?#])/i

const resourceKey = (entry: PerformanceEntry): string => {
  const resource = entry as PerformanceResourceTiming
  return [
    resource.name,
    resource.startTime,
    resource.duration,
    resource.initiatorType,
  ].join('\n')
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

function boundedText(value: string | null | undefined): string | undefined {
  const normalized = [...(value ?? '').slice(0, MAX_TEXT_METADATA * 2)]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, MAX_TEXT_METADATA)
  return normalized || undefined
}

function isSvg(url: string, mimeType?: string): boolean {
  return (
    mimeType?.split(';', 1)[0]?.trim().toLowerCase() === 'image/svg+xml' ||
    /\.svgz?(?:$|[?#])/i.test(url)
  )
}

function isSmallDecorativeImage(
  category: MediaCategory,
  width?: number,
  height?: number
): boolean {
  if (category !== 'image' || width === undefined || height === undefined) {
    return false
  }
  return (
    width < MIN_IMAGE_EDGE ||
    height < MIN_IMAGE_EDGE ||
    width * height < MIN_IMAGE_AREA
  )
}

function mergeMedia(existing: DetectedMedia, incoming: DetectedMedia): void {
  const evidence = [
    ...new Set([...(existing.evidence ?? []), ...(incoming.evidence ?? [])]),
  ].slice(0, 8)
  if (evidence.length > 0) existing.evidence = evidence
  if (!existing.alt && incoming.alt) existing.alt = incoming.alt
  if (!existing.suggestedFilename && incoming.suggestedFilename) {
    existing.suggestedFilename = incoming.suggestedFilename
  }
  if (existing.mimeType?.endsWith('/*') && incoming.mimeType) {
    existing.mimeType = incoming.mimeType
  }
  if (incoming.width !== undefined && incoming.width > (existing.width ?? 0)) {
    existing.width = incoming.width
  }
  if (
    incoming.height !== undefined &&
    incoming.height > (existing.height ?? 0)
  ) {
    existing.height = incoming.height
  }
  if (
    incoming.sizeBytes !== undefined &&
    incoming.sizeBytes > (existing.sizeBytes ?? 0)
  ) {
    existing.sizeBytes = incoming.sizeBytes
  }
  if (incoming.previewable === false) existing.previewable = false
}

export function collectFromUrls(
  urls: MediaUrlCandidate[],
  ctx: { pageUrl: string; pageTitle: string; now: number; webStore: boolean }
): DetectedMedia[] {
  const items = new Map<string, DetectedMedia>()
  for (const candidate of urls) {
    let resolvedUrl: string
    let hostname: string
    try {
      let parsed: URL
      try {
        parsed = new URL(candidate.url)
      } catch {
        parsed = new URL(candidate.url, ctx.pageUrl)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      parsed.hash = ''
      resolvedUrl = parsed.toString()
      hostname = parsed.hostname
    } catch {
      continue
    }
    if (STREAM_SEGMENT_RE.test(resolvedUrl)) continue
    if (shouldExcludeHost(hostname, ctx.webStore)) continue

    const kind = classifyMediaUrl(resolvedUrl, candidate.contentType)
    if (!kind) continue
    const mimeType =
      inferMediaMimeType(resolvedUrl, candidate.contentType) ?? undefined
    const category =
      candidate.category ??
      mediaCategory({
        kind,
        url: resolvedUrl,
        ...(mimeType ? { mimeType } : {}),
      })
    const width = positiveInteger(candidate.width)
    const height = positiveInteger(candidate.height)
    if (isSmallDecorativeImage(category, width, height)) continue

    const previewable =
      category === 'image'
        ? candidate.previewable !== false && !isSvg(resolvedUrl, mimeType)
        : undefined
    const alt = boundedText(candidate.alt)
    const suggestedFilename = boundedText(candidate.suggestedFilename)
    const sizeBytes = positiveInteger(candidate.sizeBytes)
    const item: DetectedMedia = {
      kind,
      url: resolvedUrl,
      pageUrl: ctx.pageUrl,
      pageTitle: ctx.pageTitle,
      detectedAt: ctx.now,
      category,
      ...(mimeType ? { mimeType } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(alt ? { alt } : {}),
      ...(suggestedFilename ? { suggestedFilename } : {}),
      ...(sizeBytes ? { sizeBytes } : {}),
      ...(previewable !== undefined ? { previewable } : {}),
      ...(candidate.evidence && candidate.evidence.length > 0
        ? { evidence: [...new Set(candidate.evidence)].slice(0, 8) }
        : {}),
    }
    const existing = items.get(resolvedUrl)
    if (existing) mergeMedia(existing, item)
    else items.set(resolvedUrl, item)
  }
  return [...items.values()]
}

interface SrcsetCandidate {
  url: string
  width?: number
  height?: number
}

function srcsetCandidates(
  srcset: string | null | undefined,
  elementSize: { width?: number; height?: number } = {}
): SrcsetCandidate[] {
  if (!srcset) return []
  return srcset
    .slice(0, MAX_SRCSET_LENGTH)
    .split(',')
    .map((candidate): SrcsetCandidate | null => {
      const [url = '', descriptor = ''] = candidate.trim().split(/\s+/, 2)
      if (!url) return null
      const widthMatch = /^(\d+)w$/i.exec(descriptor)
      const width = positiveInteger(
        widthMatch?.[1] ? Number.parseInt(widthMatch[1], 10) : undefined
      )
      const height =
        width && elementSize.width && elementSize.height
          ? positiveInteger((width * elementSize.height) / elementSize.width)
          : undefined
      return {
        url,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }
    })
    .filter((candidate): candidate is SrcsetCandidate => candidate !== null)
    .slice(0, MAX_SRCSET_CANDIDATES)
}

function lazyAttributeUrls(value: string | null): string[] {
  if (!value) return []
  const embedded = cssUrls(value)
  return embedded.length > 0 ? embedded : [value]
}

function elementDimensions(element: Element): {
  width?: number
  height?: number
} {
  const media = element as Element & {
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
    width?: number
    height?: number
  }
  const width = positiveInteger(
    media.naturalWidth || media.videoWidth || media.width
  )
  const height = positiveInteger(
    media.naturalHeight || media.videoHeight || media.height
  )
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  }
}

function addElementCandidate(
  candidates: MediaUrlCandidate[],
  url: string | null | undefined,
  options: Omit<MediaUrlCandidate, 'url'>
): void {
  const value = url?.trim()
  if (
    !value ||
    value.length > MAX_CANDIDATE_URL_LENGTH ||
    candidates.length >= MAX_DOM_CANDIDATES
  ) {
    return
  }
  candidates.push({ url: value, ...options })
}

function sourceContext(element: Element): {
  category?: MediaCategory
  contentType?: string
  evidence: MediaEvidence[]
} {
  const explicitType = boundedText(element.getAttribute('type'))
  const picture = element.closest('picture')
  const audio = element.closest('audio')
  const video = element.closest('video')
  if (picture) {
    return {
      category: 'image',
      contentType: explicitType ?? 'image/*',
      evidence: ['picture', 'source'],
    }
  }
  if (audio) {
    return {
      category: 'audio',
      contentType: explicitType ?? 'audio/*',
      evidence: ['audio', 'source'],
    }
  }
  if (video) {
    return {
      category: 'video',
      contentType: explicitType ?? 'video/*',
      evidence: ['video', 'source'],
    }
  }
  return { evidence: ['source'] }
}

function metaCategory(element: Element): MediaCategory | undefined {
  const key = `${element.getAttribute('property') ?? ''} ${
    element.getAttribute('name') ?? ''
  } ${element.getAttribute('itemprop') ?? ''}`.toLowerCase()
  if (key.includes('audio')) return 'audio'
  if (key.includes('video') || key.includes('player')) return 'video'
  if (key.includes('image') || key.includes('thumbnail')) return 'image'
  return undefined
}

function collectElementMedia(
  element: Element,
  candidates: MediaUrlCandidate[]
): void {
  const tag = element.tagName.toLowerCase()
  const dimensions = elementDimensions(element)

  if (tag === 'img') {
    const image = element as HTMLImageElement
    const base = {
      category: 'image' as const,
      contentType: 'image/*',
      alt: image.alt,
      ...dimensions,
    }
    addElementCandidate(candidates, image.currentSrc, {
      ...base,
      evidence: ['img', 'current-src'],
    })
    addElementCandidate(candidates, element.getAttribute('src'), {
      ...base,
      evidence: ['img'],
    })
    for (const source of srcsetCandidates(
      element.getAttribute('srcset'),
      dimensions
    )) {
      addElementCandidate(candidates, source.url, {
        category: 'image',
        contentType: 'image/*',
        alt: image.alt,
        ...(source.width ? { width: source.width } : {}),
        ...(source.height ? { height: source.height } : {}),
        evidence: ['img', 'srcset'],
      })
    }
    for (const attribute of LAZY_URL_ATTRIBUTES) {
      for (const url of lazyAttributeUrls(element.getAttribute(attribute))) {
        addElementCandidate(candidates, url, {
          ...base,
          evidence: ['img', 'lazy'],
        })
      }
    }
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      for (const source of srcsetCandidates(
        element.getAttribute(attribute),
        dimensions
      )) {
        addElementCandidate(candidates, source.url, {
          category: 'image',
          contentType: 'image/*',
          alt: image.alt,
          ...(source.width ? { width: source.width } : {}),
          ...(source.height ? { height: source.height } : {}),
          evidence: ['img', 'srcset', 'lazy'],
        })
      }
    }
    return
  }

  if (tag === 'video' || tag === 'audio') {
    const media = element as HTMLMediaElement
    const category = tag as 'video' | 'audio'
    const contentType = `${category}/*`
    addElementCandidate(candidates, media.currentSrc, {
      category,
      contentType,
      ...dimensions,
      evidence: [category, 'current-src'],
    })
    addElementCandidate(candidates, element.getAttribute('src'), {
      category,
      contentType,
      ...dimensions,
      evidence: [category],
    })
    for (const attribute of LAZY_URL_ATTRIBUTES) {
      for (const url of lazyAttributeUrls(element.getAttribute(attribute))) {
        addElementCandidate(candidates, url, {
          category,
          contentType,
          ...dimensions,
          evidence: [category, 'lazy'],
        })
      }
    }
    if (tag === 'video') {
      addElementCandidate(candidates, element.getAttribute('poster'), {
        category: 'image',
        contentType: 'image/*',
        ...dimensions,
        evidence: ['video', 'poster'],
      })
    }
    return
  }

  if (tag === 'source') {
    const context = sourceContext(element)
    const dimensionElement =
      element.closest('picture')?.querySelector('img') ?? element.parentElement
    const parentDimensions = dimensionElement
      ? elementDimensions(dimensionElement)
      : {}
    addElementCandidate(candidates, element.getAttribute('src'), {
      ...context,
      ...parentDimensions,
    })
    for (const attribute of LAZY_URL_ATTRIBUTES) {
      for (const url of lazyAttributeUrls(element.getAttribute(attribute))) {
        addElementCandidate(candidates, url, {
          ...context,
          ...parentDimensions,
          evidence: [...context.evidence, 'lazy'],
        })
      }
    }
    for (const attribute of ['srcset', ...LAZY_SRCSET_ATTRIBUTES]) {
      for (const source of srcsetCandidates(
        element.getAttribute(attribute),
        parentDimensions
      )) {
        addElementCandidate(candidates, source.url, {
          ...context,
          ...(source.width ? { width: source.width } : {}),
          ...(source.height ? { height: source.height } : {}),
          evidence: [
            ...context.evidence,
            'srcset',
            ...(attribute !== 'srcset' ? (['lazy'] as const) : []),
          ],
        })
      }
    }
    return
  }

  if (
    tag === 'input' &&
    element.getAttribute('type')?.toLowerCase() === 'image'
  ) {
    const alt = element.getAttribute('alt') ?? undefined
    addElementCandidate(candidates, element.getAttribute('src'), {
      category: 'image',
      contentType: 'image/*',
      ...(alt ? { alt } : {}),
      ...dimensions,
      evidence: ['input-image'],
    })
    return
  }

  if (tag === 'meta') {
    const category = metaCategory(element)
    addElementCandidate(candidates, element.getAttribute('content'), {
      ...(category ? { category, contentType: `${category}/*` } : {}),
      evidence: ['meta'],
    })
    return
  }

  if (tag === 'link') {
    const category = element.getAttribute('as') as MediaCategory | null
    const suggestedFilename = element.getAttribute('download') ?? undefined
    addElementCandidate(candidates, element.getAttribute('href'), {
      ...(category === 'image' || category === 'video' || category === 'audio'
        ? { category, contentType: `${category}/*` }
        : { category: 'image' as const, contentType: 'image/*' }),
      ...(suggestedFilename ? { suggestedFilename } : {}),
      evidence: ['link'],
    })
    return
  }

  for (const attribute of LAZY_URL_ATTRIBUTES) {
    for (const url of lazyAttributeUrls(element.getAttribute(attribute))) {
      addElementCandidate(candidates, url, {
        category: 'image',
        contentType: 'image/*',
        ...dimensions,
        evidence: ['lazy'],
      })
    }
  }
  for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
    for (const source of srcsetCandidates(
      element.getAttribute(attribute),
      dimensions
    )) {
      addElementCandidate(candidates, source.url, {
        category: 'image',
        contentType: 'image/*',
        ...(source.width ? { width: source.width } : {}),
        ...(source.height ? { height: source.height } : {}),
        evidence: ['srcset', 'lazy'],
      })
    }
  }
}

function cssUrls(value: string | null | undefined): string[] {
  if (!value || value === 'none') return []
  const urls: string[] = []
  const pattern = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi
  for (;;) {
    const match = pattern.exec(value)
    if (!match) break
    const url = (match[2] ?? match[3] ?? '').trim()
    if (url) urls.push(url)
    if (urls.length >= MAX_SRCSET_CANDIDATES) break
  }
  return urls
}

function collectCssMedia(
  element: Element,
  candidates: MediaUrlCandidate[]
): void {
  let dimensions = elementDimensions(element)
  if (dimensions.width === undefined || dimensions.height === undefined) {
    try {
      const rect = element.getBoundingClientRect()
      const width = positiveInteger(rect.width)
      const height = positiveInteger(rect.height)
      dimensions = {
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }
    } catch {
      // Detached nodes may not expose layout.
    }
  }

  const readStyle = (
    pseudo?: '::before' | '::after'
  ): CSSStyleDeclaration | null => {
    try {
      return window.getComputedStyle(element, pseudo)
    } catch {
      return null
    }
  }
  const style = readStyle()
  for (const url of cssUrls(style?.backgroundImage)) {
    addElementCandidate(candidates, url, {
      category: 'image',
      contentType: 'image/*',
      ...dimensions,
      evidence: ['css-background'],
    })
  }
  for (const pseudo of ['::before', '::after'] as const) {
    const pseudoStyle = readStyle(pseudo)
    for (const value of [pseudoStyle?.backgroundImage, pseudoStyle?.content]) {
      for (const url of cssUrls(value)) {
        addElementCandidate(candidates, url, {
          category: 'image',
          contentType: 'image/*',
          ...dimensions,
          evidence: ['css-pseudo'],
        })
      }
    }
  }
}

function elementsInRoots(
  roots: ParentNode[],
  selector: string,
  limit: number
): Element[] {
  const elements = new Set<Element>()
  for (const root of roots) {
    if (root instanceof Element && root.matches(selector)) elements.add(root)
    for (const element of root.querySelectorAll(selector)) {
      elements.add(element)
      if (elements.size >= limit) return [...elements]
    }
  }
  return [...elements]
}

function collectDomCandidates(
  roots: ParentNode[] = [document]
): MediaUrlCandidate[] {
  const candidates: MediaUrlCandidate[] = []
  for (const element of elementsInRoots(
    roots,
    DOM_MEDIA_SELECTOR,
    MAX_DOM_MEDIA_ELEMENTS
  )) {
    collectElementMedia(element, candidates)
  }
  for (const element of elementsInRoots(
    roots,
    DOM_STYLE_SELECTOR,
    MAX_DOM_STYLE_ELEMENTS
  )) {
    collectCssMedia(element, candidates)
  }
  return candidates
}

function fetchRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function responseSize(headers: Headers): number | undefined {
  const raw = headers.get('content-length')
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function shouldInspectBody(url: string, contentType?: string): boolean {
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const kind = classifyMediaUrl(url, contentType)
  return (
    kind === 'hls' ||
    kind === 'dash' ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/xml' ||
    type === 'text/xml' ||
    type === 'text/plain' ||
    type === 'application/octet-stream'
  )
}

/**
 * Install continuous, backend-independent media discovery for one document.
 * The caller decides whether reports go directly to extension messaging
 * (an isolated-world fallback) or through the MAIN/isolated relay.
 */
export function installSniffer(
  report: (items: DetectedMedia[]) => void,
  initialCtx: SnifferPageContext,
  resolveContext?: () => SnifferPageContext
): SnifferHandle {
  const webStore = isWebStoreBuild()
  let currentCtx = initialCtx
  let active = true
  const deferBodyInspection = globalThis.queueMicrotask.bind(globalThis)
  const resourcePageByKey = new Map<string, string>()
  const resourcePageByEntry = new WeakMap<PerformanceEntry, string>()
  let bodyInspectionTokens = MAX_BODY_INSPECTIONS_PER_SECOND
  let bodyByteTokens = MAX_BODY_BYTES_PER_SECOND
  let bodyTokensUpdatedAt = Date.now()
  let concurrentBodyInspections = 0

  const acquireBodyInspection = (): ((actualBytes?: number) => void) | null => {
    const now = Date.now()
    const elapsed = Math.max(0, now - bodyTokensUpdatedAt)
    if (elapsed > 0) {
      const refillRatio = Math.min(1, elapsed / 1_000)
      bodyInspectionTokens = Math.min(
        MAX_BODY_INSPECTIONS_PER_SECOND,
        bodyInspectionTokens + MAX_BODY_INSPECTIONS_PER_SECOND * refillRatio
      )
      bodyByteTokens = Math.min(
        MAX_BODY_BYTES_PER_SECOND,
        bodyByteTokens + MAX_BODY_BYTES_PER_SECOND * refillRatio
      )
      bodyTokensUpdatedAt = now
    }
    // Reserve the maximum before reading. Content-Length may describe a
    // compressed body or be inaccurate, so trusting it would let a page spend
    // more decoded bytes than the bucket allows. Unused bytes are refunded.
    const reservedBytes = MEDIA_BODY_LIMITS.maxBytes
    if (
      !active ||
      concurrentBodyInspections >= MAX_CONCURRENT_BODY_INSPECTIONS ||
      bodyInspectionTokens < 1 ||
      bodyByteTokens < reservedBytes
    ) {
      return null
    }
    bodyInspectionTokens -= 1
    bodyByteTokens -= reservedBytes
    concurrentBodyInspections += 1
    let released = false
    return (actualBytes?: number) => {
      if (released) return
      released = true
      concurrentBodyInspections = Math.max(0, concurrentBodyInspections - 1)
      if (actualBytes !== undefined) {
        const consumedBytes = Math.min(reservedBytes, Math.max(0, actualBytes))
        bodyByteTokens = Math.min(
          MAX_BODY_BYTES_PER_SECOND,
          bodyByteTokens + reservedBytes - consumedBytes
        )
      }
    }
  }

  const getCurrentContext = (): SnifferPageContext => {
    try {
      return resolveContext?.() ?? currentCtx
    } catch {
      return currentCtx
    }
  }

  const reportUrls = (
    entries: MediaUrlCandidate[],
    ctx: SnifferPageContext = getCurrentContext()
  ): void => {
    if (!active || entries.length === 0) return
    try {
      const items = collectFromUrls(entries, {
        ...ctx,
        now: Date.now(),
        webStore,
      })
      for (let offset = 0; offset < items.length; offset += MAX_REPORT_ITEMS) {
        try {
          report(items.slice(offset, offset + MAX_REPORT_ITEMS))
        } catch {
          // Page instrumentation is observational; report failures are inert.
        }
      }
    } catch {
      // Malformed page-controlled getters must never affect page APIs.
    }
  }

  const push = (
    url: string,
    contentType: string | undefined,
    evidence: MediaEvidence,
    sizeBytes?: number
  ): void =>
    reportUrls([
      {
        url,
        ...(contentType ? { contentType } : {}),
        ...(sizeBytes ? { sizeBytes } : {}),
        evidence: [evidence],
      },
    ])

  const origFetch = window.fetch
  const wrappedFetch: typeof window.fetch = function (
    this: typeof window,
    ...args
  ) {
    // Call before adding Promise handlers so a patched/native synchronous
    // throw keeps exactly the same observable semantics.
    const result = Reflect.apply(origFetch, this, args)
    return result.then((response) => {
      if (!active) return response
      try {
        const requestUrl = fetchRequestUrl(args[0])
        const responseUrl = response.url || requestUrl
        const contentType = response.headers.get('content-type') ?? undefined
        const sizeBytes = responseSize(response.headers)
        push(responseUrl, contentType, 'fetch', sizeBytes)
        if (
          shouldInspectBody(responseUrl, contentType) &&
          (sizeBytes === undefined || sizeBytes <= MEDIA_BODY_LIMITS.maxBytes)
        ) {
          const release = acquireBodyInspection()
          if (!release) return response
          let inspectedBytes: number | undefined
          void inspectFetchResponseBody(response, requestUrl, (byteLength) => {
            inspectedBytes = byteLength
          })
            .then((candidates) => {
              reportUrls(
                candidates.map((candidate) => ({
                  ...candidate,
                  evidence: [...candidate.evidence, 'fetch'],
                }))
              )
            })
            .catch(() => undefined)
            .finally(() => release(inspectedBytes))
        }
      } catch {
        // Observation must never change a fulfilled fetch into a rejection.
      }
      return response
    })
  }
  window.fetch = wrappedFetch

  const origOpen = XMLHttpRequest.prototype.open
  const xhrUrls = new WeakMap<XMLHttpRequest, string>()
  const observedXhrs = new WeakSet<XMLHttpRequest>()
  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    // biome-ignore lint/suspicious/noExplicitAny: XHR signature passthrough
    ...rest: any[]
  ) {
    const result = Reflect.apply(origOpen, this, [method, url, ...rest])
    try {
      xhrUrls.set(this, String(url))
      if (!observedXhrs.has(this)) {
        observedXhrs.add(this)
        this.addEventListener('load', () => {
          if (!active) return
          try {
            let contentType: string | undefined
            let sizeBytes: number | undefined
            contentType = this.getResponseHeader('content-type') ?? undefined
            const length = this.getResponseHeader('content-length')
            const parsed = length ? Number.parseInt(length, 10) : Number.NaN
            if (Number.isSafeInteger(parsed) && parsed > 0) sizeBytes = parsed
            const responseUrl = this.responseURL || xhrUrls.get(this) || ''
            push(responseUrl, contentType, 'xhr', sizeBytes)
            if (
              !shouldInspectBody(responseUrl, contentType) ||
              (sizeBytes !== undefined &&
                sizeBytes > MEDIA_BODY_LIMITS.maxBytes)
            ) {
              return
            }
            // Keep body reads and JSON/XML parsing out of the page's load
            // listener. The URL/header observation above remains synchronous.
            deferBodyInspection(() => {
              if (!active) return
              const release = acquireBodyInspection()
              if (!release) return
              let inspectedBytes: number | undefined
              try {
                const responseType = this.responseType
                if (responseType === '' || responseType === 'text') {
                  const body = this.responseText
                  if (typeof body !== 'string') return
                  inspectedBytes = new TextEncoder().encode(body).byteLength
                  if (
                    body.length <= MEDIA_BODY_LIMITS.maxBytes &&
                    inspectedBytes <= MEDIA_BODY_LIMITS.maxBytes
                  ) {
                    reportUrls(
                      inspectMediaBodyText(body, responseUrl, contentType).map(
                        (candidate) => ({
                          ...candidate,
                          evidence: [...candidate.evidence, 'xhr'],
                        })
                      )
                    )
                  }
                }
              } catch {
                // Opaque/hostile getters remain inert in the deferred task.
              } finally {
                release(inspectedBytes)
              }
            })
          } catch {
            // Opaque/hostile getters are ignored after the page receives load.
          }
        })
      }
    } catch {
      // Instrumentation failure after a successful open is observational only.
    }
    return result
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = wrappedOpen

  const rememberResourceOwner = (
    entry: PerformanceEntry,
    key: string,
    pageUrl: string
  ): void => {
    resourcePageByEntry.set(entry, pageUrl)
    resourcePageByKey.delete(key)
    resourcePageByKey.set(key, pageUrl)
    while (resourcePageByKey.size > MAX_RESOURCE_KEYS) {
      const oldestKey = resourcePageByKey.keys().next().value
      if (typeof oldestKey !== 'string') break
      resourcePageByKey.delete(oldestKey)
    }
  }

  const resourceOwner = (
    entry: PerformanceEntry,
    key: string
  ): string | undefined => {
    const owner = resourcePageByEntry.get(entry) ?? resourcePageByKey.get(key)
    if (owner !== undefined) rememberResourceOwner(entry, key, owner)
    return owner
  }

  const harvestPerformance = (
    entries: PerformanceEntry[],
    ctx: SnifferPageContext,
    repeatedScan: boolean
  ): void => {
    const harvested: MediaUrlCandidate[] = []
    for (const entry of entries.slice(-MAX_PERFORMANCE_ENTRIES)) {
      const resource = entry as PerformanceResourceTiming
      if (typeof resource.name !== 'string' || resource.name.length === 0) {
        continue
      }
      const key = resourceKey(entry)
      const owningPage = resourceOwner(entry, key)
      if (owningPage === undefined) {
        rememberResourceOwner(entry, key, ctx.pageUrl)
      } else if (owningPage !== ctx.pageUrl) {
        continue
      } else if (!repeatedScan) {
        continue
      }
      const sizeBytes = positiveInteger(resource.decodedBodySize)
      harvested.push({
        url: resource.name,
        ...(sizeBytes ? { sizeBytes } : {}),
        evidence: ['performance'],
      })
    }
    reportUrls(harvested, ctx)
  }

  let performanceObserver: PerformanceObserver | null = null
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        harvestPerformance(list.getEntries(), getCurrentContext(), false)
      })
      performanceObserver.observe({ type: 'resource', buffered: true })
    } catch {
      performanceObserver = null
    }
  }

  const pendingRoots = new Set<Element>()
  let mutationTimer: number | undefined
  let mutationWindowStartedAt = Date.now()
  let mutationFlushes = 0
  let mutationRootWork = 0

  const resetMutationWindowIfNeeded = (): void => {
    if (Date.now() - mutationWindowStartedAt < MUTATION_WORK_WINDOW_MS) return
    mutationWindowStartedAt = Date.now()
    mutationFlushes = 0
    mutationRootWork = 0
  }

  function scheduleMutationFlush(delay = MUTATION_BATCH_MS): void {
    if (!active || mutationTimer !== undefined || pendingRoots.size === 0) {
      return
    }
    mutationTimer = window.setTimeout(flushMutations, delay)
  }

  function flushMutations(): void {
    mutationTimer = undefined
    if (!active || pendingRoots.size === 0) return
    resetMutationWindowIfNeeded()
    const remainingRootWork =
      MAX_MUTATION_ROOT_WORK_PER_WINDOW - mutationRootWork
    if (
      mutationFlushes >= MAX_MUTATION_FLUSHES_PER_WINDOW ||
      remainingRootWork <= 0
    ) {
      scheduleMutationFlush(
        Math.max(
          1,
          MUTATION_WORK_WINDOW_MS - (Date.now() - mutationWindowStartedAt)
        )
      )
      return
    }

    const roots = [...pendingRoots].slice(0, remainingRootWork)
    for (const root of roots) pendingRoots.delete(root)
    mutationFlushes += 1
    mutationRootWork += roots.length
    try {
      reportUrls(collectDomCandidates(roots))
    } catch {
      // A detached/hostile DOM subtree cannot escape the observer callback.
    }
    if (pendingRoots.size > 0) scheduleMutationFlush()
  }

  const addPendingRoot = (root: Element): void => {
    for (const existing of pendingRoots) {
      if (existing === root || existing.contains(root)) return
      if (root.contains(existing)) pendingRoots.delete(existing)
    }
    if (pendingRoots.size < MAX_MUTATION_ROOTS) pendingRoots.add(root)
  }

  const scheduleRoots = (roots: Iterable<Element>): void => {
    if (!active) return
    for (const root of roots) addPendingRoot(root)
    scheduleMutationFlush()
  }

  let mutationObserver: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver((records) => {
      const roots: Element[] = []
      for (const record of records) {
        if (record.target instanceof Element) roots.push(record.target)
        for (const node of record.addedNodes) {
          if (node instanceof Element) roots.push(node)
        }
        if (roots.length >= MAX_MUTATION_ROOTS) break
      }
      scheduleRoots(roots)
    })
    mutationObserver.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'src',
        'srcset',
        'poster',
        'content',
        'href',
        'style',
        'class',
        ...LAZY_URL_ATTRIBUTES,
        ...LAZY_SRCSET_ATTRIBUTES,
      ],
    })
  }

  const onResourceLoad = (event: Event): void => {
    if (!(event.target instanceof Element)) return
    if (
      event.target instanceof HTMLLinkElement &&
      event.target.relList.contains('stylesheet') &&
      document.documentElement
    ) {
      scheduleRoots([document.documentElement])
      return
    }
    scheduleRoots([event.target])
  }
  const onDocumentReady = (): void => {
    if (document.documentElement) scheduleRoots([document.documentElement])
  }
  document.addEventListener('load', onResourceLoad, true)
  document.addEventListener('DOMContentLoaded', onDocumentReady)
  window.addEventListener('load', onDocumentReady)

  const scan = (nextCtx: SnifferPageContext = getCurrentContext()): void => {
    if (nextCtx.pageUrl !== currentCtx.pageUrl) {
      resourcePageByKey.clear()
      pendingRoots.clear()
      if (mutationTimer !== undefined) {
        window.clearTimeout(mutationTimer)
        mutationTimer = undefined
      }
      mutationWindowStartedAt = Date.now()
      mutationFlushes = 0
      mutationRootWork = 0
    }
    currentCtx = nextCtx
    try {
      reportUrls(collectDomCandidates(), nextCtx)
    } catch {
      // Explicit rescans are best effort on page-controlled DOM.
    }
    try {
      harvestPerformance(
        performance.getEntriesByType('resource'),
        nextCtx,
        true
      )
    } catch {
      // Resource Timing unavailable — DOM scan + live hooks still apply.
    }
  }

  scan(initialCtx)

  return {
    scan,
    uninstall: () => {
      active = false
      mutationObserver?.disconnect()
      performanceObserver?.disconnect()
      document.removeEventListener('load', onResourceLoad, true)
      document.removeEventListener('DOMContentLoaded', onDocumentReady)
      window.removeEventListener('load', onDocumentReady)
      if (mutationTimer !== undefined) window.clearTimeout(mutationTimer)
      if (window.fetch === wrappedFetch) window.fetch = origFetch
      if (XMLHttpRequest.prototype.open === wrappedOpen) {
        XMLHttpRequest.prototype.open = origOpen
      }
    },
  }
}
