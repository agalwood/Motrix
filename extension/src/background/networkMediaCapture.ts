import type {
  MediaCredentialStore,
  NetworkMediaCredentialObservation,
} from '@/background/capture/MediaCredentialStore'
import type { MediaStore } from '@/background/MediaStore'
import { extensionBrowser } from '@/shared/browser'
import { isWebStoreBuild } from '@/shared/buildFlags'
import {
  sanitizeFilename,
  sanitizeFilenameWithExtension,
} from '@/shared/manualTask'
import {
  classifyMediaUrl,
  type DetectedMedia,
  extensionForMediaMimeType,
  inferMediaMimeType,
  mediaCategory,
  shouldExcludeHost,
} from '@/shared/media'

export const NETWORK_MEDIA_REQUEST_TYPES = [
  'media',
  'image',
  'xmlhttprequest',
  'object',
  'other',
  'sub_frame',
] as const

interface ResponseHeaderLike {
  name: string
  value?: string
}

export interface NetworkRequestDetails {
  requestId: string
  tabId: number
  url: string
  type: string
  frameId?: number
  parentFrameId?: number
  requestHeaders?: ResponseHeaderLike[]
  timeStamp?: number
  initiator?: string
  documentId?: string
  documentUrl?: string
}

export interface NetworkResponseDetails {
  requestId?: string
  tabId: number
  url: string
  type: string
  frameId?: number
  parentFrameId?: number
  responseHeaders?: ResponseHeaderLike[]
  timeStamp?: number
  initiator?: string
  documentId?: string
  /** Firefox exposes the owning frame URL here. */
  documentUrl?: string
  statusCode?: number
}

interface TabLike {
  url?: string
  title?: string
}

interface NavigationFrameLike {
  tabId: number
  frameId: number
  parentFrameId: number
  url: string
  documentId?: string
  timeStamp?: number
}

interface ListenerEvent<T extends (...args: never[]) => unknown> {
  addListener(listener: T, ...args: unknown[]): void
  removeListener?(listener: T): void
}

interface WebRequestLike {
  onSendHeaders?: ListenerEvent<(details: NetworkRequestDetails) => void>
  onHeadersReceived: ListenerEvent<(details: NetworkResponseDetails) => void>
}

interface WebNavigationLike {
  onCommitted?: ListenerEvent<(details: NavigationFrameLike) => void>
  onHistoryStateUpdated?: ListenerEvent<(details: NavigationFrameLike) => void>
  getAllFrames?: (details: {
    tabId: number
  }) => Promise<NavigationFrameLike[] | null>
}

interface TabsLike {
  get(tabId: number): Promise<TabLike>
  onUpdated?: ListenerEvent<
    (tabId: number, changeInfo: { url?: string }, tab: TabLike) => void
  >
  onRemoved?: ListenerEvent<
    (
      tabId: number,
      removeInfo: { isWindowClosing: boolean; windowId: number }
    ) => void
  >
}

type MediaStoreWriter = Pick<MediaStore, 'addForPage' | 'clear' | 'retainPage'>
type MediaCredentialWriter = Pick<
  MediaCredentialStore,
  'clear' | 'clearAll' | 'remember' | 'retainPage'
>

export interface NetworkMediaCaptureOptions {
  store: MediaStoreWriter
  credentialStore?: MediaCredentialWriter
  webRequest?: WebRequestLike
  webNavigation?: WebNavigationLike
  tabs?: TabsLike
  webStore?: boolean
  includeExtraHeaders?: boolean
  now?: () => number
}

/** Short-lived request/response correlation cache. */
export const REQUEST_HEADERS_TTL_MS = 30_000
export const MAX_PENDING_REQUEST_HEADERS = 512
export const MAX_NETWORK_MEDIA_URL_LENGTH = 32_768

const CAPTURED_REQUEST_HEADERS: ReadonlyMap<string, string> = new Map([
  ['cookie', 'Cookie'],
  ['origin', 'Origin'],
  ['referer', 'Referer'],
  ['accept', 'Accept'],
  ['accept-language', 'Accept-Language'],
  ['user-agent', 'User-Agent'],
  ['x-requested-with', 'X-Requested-With'],
])
const MAX_CAPTURED_HEADER_VALUE_LENGTH = 8_192

interface PendingRequestHeaders {
  tabId: number
  requestId: string
  url: string
  frameId?: number
  documentId?: string
  capturedAt: number
  headers: Record<string, string>
}

interface FrameOwner {
  frameId: number
  parentFrameId: number
  frameUrlKey: string
  documentId?: string
  topPageUrl: string
  generation: number
}

interface TabNavigationState {
  generation: number
  topPageUrl: string
  topPageKey: string
  frames: Map<number, FrameOwner>
}

interface CaptureContext {
  store: MediaStoreWriter
  credentialStore?: MediaCredentialWriter
  tabs: TabsLike
  webNavigation?: WebNavigationLike
  webStore: boolean
  now: () => number
  navigationByTab: Map<number, TabNavigationState>
  pendingRequestHeaders: Map<string, PendingRequestHeaders>
}

function headerValue(
  headers: ResponseHeaderLike[] | undefined,
  name: string
): string | undefined {
  const value = headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase()
  )?.value
  return value?.trim() || undefined
}

function contentTypeFrom(
  headers: ResponseHeaderLike[] | undefined
): string | undefined {
  return headerValue(headers, 'content-type')
}

function requestKey(tabId: number, requestId: string): string {
  return `${tabId}\u0000${requestId}`
}

function prunePendingRequestHeaders(context: CaptureContext): void {
  const oldestAllowed = context.now() - REQUEST_HEADERS_TTL_MS
  for (const [key, pending] of context.pendingRequestHeaders) {
    if (pending.capturedAt >= oldestAllowed) continue
    context.pendingRequestHeaders.delete(key)
  }
}

function capturedHeadersFrom(
  headers: ResponseHeaderLike[] | undefined
): Record<string, string> {
  const captured: Record<string, string> = {}
  for (const header of headers ?? []) {
    const outputName = CAPTURED_REQUEST_HEADERS.get(header.name.toLowerCase())
    const value = header.value?.trim()
    if (
      !outputName ||
      !value ||
      value.length > MAX_CAPTURED_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(value)
    ) {
      continue
    }
    captured[outputName] = value
  }
  return captured
}

function rememberRequestHeaders(
  details: NetworkRequestDetails,
  context: CaptureContext
): void {
  if (details.tabId < 0 || !details.requestId) return
  const url = parseHttpUrl(details.url)?.toString()
  if (!url) return
  prunePendingRequestHeaders(context)
  const key = requestKey(details.tabId, details.requestId)
  // Refreshing the same request (for example after a redirect) must also move
  // it to the newest insertion position for deterministic bounded eviction.
  context.pendingRequestHeaders.delete(key)
  context.pendingRequestHeaders.set(key, {
    tabId: details.tabId,
    requestId: details.requestId,
    url,
    ...(typeof details.frameId === 'number'
      ? { frameId: details.frameId }
      : {}),
    ...(details.documentId ? { documentId: details.documentId } : {}),
    capturedAt: context.now(),
    headers: capturedHeadersFrom(details.requestHeaders),
  })
  while (context.pendingRequestHeaders.size > MAX_PENDING_REQUEST_HEADERS) {
    const oldest = context.pendingRequestHeaders.keys().next().value
    if (typeof oldest !== 'string') break
    context.pendingRequestHeaders.delete(oldest)
  }
}

function takeRequestHeaders(
  details: NetworkResponseDetails,
  context: CaptureContext
): Record<string, string> | undefined {
  if (!details.requestId) return undefined
  const key = requestKey(details.tabId, details.requestId)
  const pending = context.pendingRequestHeaders.get(key)
  context.pendingRequestHeaders.delete(key)
  if (!pending) return undefined
  if (context.now() - pending.capturedAt > REQUEST_HEADERS_TTL_MS) {
    return undefined
  }
  const responseUrl = parseHttpUrl(details.url)?.toString()
  if (!responseUrl || responseUrl !== pending.url) return undefined
  if (
    typeof details.frameId === 'number' &&
    typeof pending.frameId === 'number' &&
    details.frameId !== pending.frameId
  ) {
    return undefined
  }
  if (
    details.documentId &&
    pending.documentId &&
    details.documentId !== pending.documentId
  ) {
    return undefined
  }
  return Object.keys(pending.headers).length > 0 ? pending.headers : undefined
}

function clearPendingForTab(tabId: number, context: CaptureContext): void {
  for (const [key, pending] of context.pendingRequestHeaders) {
    if (pending.tabId === tabId) context.pendingRequestHeaders.delete(key)
  }
}

function finitePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function responseSizeBytes(headers: ResponseHeaderLike[] | undefined): {
  sizeBytes?: number
  evidence?: 'content-range' | 'content-length'
} {
  const contentRange = headerValue(headers, 'content-range')
  const total = contentRange
    ? finitePositiveInteger(/\/\s*(\d+)\s*$/.exec(contentRange)?.[1])
    : undefined
  if (total) return { sizeBytes: total, evidence: 'content-range' }
  const contentLength = finitePositiveInteger(
    headerValue(headers, 'content-length')
  )
  return contentLength
    ? { sizeBytes: contentLength, evidence: 'content-length' }
    : {}
}

function decodeExtendedFilename(value: string): string {
  const match = /^[^']*'[^']*'(.*)$/.exec(value)
  const encoded = match?.[1] ?? value
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded.replace(/%([\da-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  }
}

function cleanSuggestedFilename(value: string | undefined): string | undefined {
  if (!value) return undefined
  const unescaped = value.replace(/\\(["\\])/g, '$1')
  const leaf = unescaped.split(/[\\/]/).at(-1)
  return leaf ? sanitizeFilename(leaf, 'download') : undefined
}

function contentDispositionFilename(
  headers: ResponseHeaderLike[] | undefined
): string | undefined {
  const disposition = headerValue(headers, 'content-disposition')
  if (!disposition) return undefined
  const extended =
    /(?:^|;)\s*filename\*\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(
      disposition
    )
  if (extended) {
    const decoded = decodeExtendedFilename(
      (extended[1] ?? extended[2] ?? '').trim()
    )
    const cleaned = cleanSuggestedFilename(decoded)
    if (cleaned) return cleaned
  }
  const basic = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(
    disposition
  )
  return cleanSuggestedFilename((basic?.[1] ?? basic?.[2])?.trim())
}

function filenameFromUrl(url: URL): string | undefined {
  const rawLeaf = url.pathname.split('/').at(-1)
  if (!rawLeaf) return undefined
  try {
    return cleanSuggestedFilename(decodeURIComponent(rawLeaf))
  } catch {
    return cleanSuggestedFilename(rawLeaf)
  }
}

function appendMimeExtension(
  filename: string,
  kind: DetectedMedia['kind'],
  mimeType: string | null
): string {
  const extension =
    extensionForMediaMimeType(mimeType ?? undefined) ??
    (kind === 'hls' ? 'm3u8' : kind === 'dash' ? 'mpd' : null)
  const fallback = kind === 'direct' ? 'download' : 'video'
  const filenameMime = normalizeMimeType(inferMediaMimeType(filename))
  if (mimeType && filenameMime === normalizeMimeType(mimeType)) {
    return sanitizeFilename(filename, fallback)
  }
  return extension
    ? sanitizeFilenameWithExtension(filename, extension, fallback)
    : sanitizeFilename(filename, fallback)
}

function normalizeMimeType(value: string | null): string | null {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mimeType || null
}

function parseHttpUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_NETWORK_MEDIA_URL_LENGTH) {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function pageKey(value: string): string | null {
  const url = parseHttpUrl(value)
  if (!url) return null
  url.hash = ''
  return url.toString()
}

function isNoisySegment(url: URL): boolean {
  return /\.(?:ts|m4s)$/i.test(url.pathname)
}

async function getTab(tabs: TabsLike, tabId: number): Promise<TabLike | null> {
  try {
    return await tabs.get(tabId)
  } catch {
    // The tab may close between the network event and this asynchronous lookup.
    return null
  }
}

async function getAllFrames(
  webNavigation: WebNavigationLike | undefined,
  tabId: number
): Promise<NavigationFrameLike[]> {
  if (!webNavigation?.getAllFrames) return []
  try {
    return (await webNavigation.getAllFrames({ tabId })) ?? []
  } catch {
    return []
  }
}

function buildNavigationState(
  topPageUrl: string,
  frames: NavigationFrameLike[],
  generation: number
): TabNavigationState | null {
  const topPageKey = pageKey(topPageUrl)
  if (!topPageKey) return null

  const topFrame = frames.find((frame) => frame.frameId === 0)
  if (topFrame && pageKey(topFrame.url) !== topPageKey) return null

  const owners = new Map<number, FrameOwner>()
  for (const frame of frames) {
    const frameUrlKey = pageKey(frame.url)
    if (!frameUrlKey) continue
    owners.set(frame.frameId, {
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      frameUrlKey,
      ...(frame.documentId ? { documentId: frame.documentId } : {}),
      topPageUrl,
      generation,
    })
  }
  if (!owners.has(0)) {
    owners.set(0, {
      frameId: 0,
      parentFrameId: -1,
      frameUrlKey: topPageKey,
      topPageUrl,
      generation,
    })
  }

  return { generation, topPageUrl, topPageKey, frames: owners }
}

async function refreshNavigationState(
  tabId: number,
  context: CaptureContext
): Promise<TabNavigationState | null> {
  const stateAtStart = context.navigationByTab.get(tabId)
  const [tab, frames] = await Promise.all([
    getTab(context.tabs, tabId),
    getAllFrames(context.webNavigation, tabId),
  ])
  const newerState = context.navigationByTab.get(tabId)
  if (newerState && newerState !== stateAtStart) return newerState
  if (!tab?.url) return null

  const state = buildNavigationState(
    tab.url,
    frames,
    stateAtStart?.generation ?? 0
  )
  if (state) context.navigationByTab.set(tabId, state)
  return state
}

function isDescendantOf(
  frameId: number,
  ancestorId: number,
  frames: Map<number, FrameOwner>
): boolean {
  let current = frames.get(frameId)
  const seen = new Set<number>()
  while (current && current.parentFrameId >= 0 && !seen.has(current.frameId)) {
    if (current.parentFrameId === ancestorId) return true
    seen.add(current.frameId)
    current = frames.get(current.parentFrameId)
  }
  return false
}

function commitNavigation(
  details: NavigationFrameLike,
  context: CaptureContext,
  newDocument: boolean
): void {
  const frameUrlKey = pageKey(details.url)
  if (!frameUrlKey || details.tabId < 0) return
  const current = context.navigationByTab.get(details.tabId)

  const pageChanged =
    details.frameId === 0 && current?.topPageUrl !== details.url
  if (newDocument || pageChanged) {
    for (const [key, pending] of context.pendingRequestHeaders) {
      if (pending.tabId !== details.tabId) continue
      if (
        details.frameId === 0 ||
        pending.frameId === details.frameId ||
        (typeof pending.frameId === 'number' &&
          current &&
          isDescendantOf(pending.frameId, details.frameId, current.frames))
      ) {
        context.pendingRequestHeaders.delete(key)
      }
    }
  }

  if (details.frameId === 0) {
    const generation =
      current === undefined
        ? 0
        : current.generation +
          (newDocument || current.topPageUrl !== details.url ? 1 : 0)
    const frames = newDocument
      ? new Map<number, FrameOwner>()
      : new Map(current?.frames)
    for (const [frameId, owner] of frames) {
      frames.set(frameId, {
        ...owner,
        topPageUrl: details.url,
        generation,
      })
    }
    frames.set(0, {
      frameId: 0,
      parentFrameId: -1,
      frameUrlKey,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      topPageUrl: details.url,
      generation,
    })
    context.navigationByTab.set(details.tabId, {
      generation,
      topPageUrl: details.url,
      topPageKey: frameUrlKey,
      frames,
    })
    context.credentialStore?.retainPage(details.tabId, details.url)
    void context.store.retainPage(details.tabId, details.url).catch(() => {
      // Navigation cleanup is best-effort and must not affect the SW.
    })
    return
  }

  if (!current) return
  const frames = new Map(current.frames)
  if (newDocument) {
    for (const frameId of frames.keys()) {
      if (
        frameId === details.frameId ||
        isDescendantOf(frameId, details.frameId, frames)
      ) {
        frames.delete(frameId)
      }
    }
  }
  frames.set(details.frameId, {
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    frameUrlKey,
    ...(details.documentId ? { documentId: details.documentId } : {}),
    topPageUrl: current.topPageUrl,
    generation: current.generation,
  })
  context.navigationByTab.set(details.tabId, { ...current, frames })
}

async function resolveFrameOwner(
  details: NetworkResponseDetails,
  context: CaptureContext
): Promise<{ owner: FrameOwner; state: TabNavigationState } | null> {
  let state = context.navigationByTab.get(details.tabId)
  let refreshed = false
  if (!state) {
    const restoredState = await refreshNavigationState(details.tabId, context)
    if (!restoredState) return null
    state = restoredState
    refreshed = true
  }

  let frameId = details.frameId
  if (typeof frameId !== 'number') {
    const documentUrlKey = details.documentUrl
      ? pageKey(details.documentUrl)
      : null
    if (documentUrlKey !== state.topPageKey) return null
    frameId = 0
  }

  const documentUrlKey = details.documentUrl
    ? pageKey(details.documentUrl)
    : null
  let owner = state.frames.get(frameId)
  // getAllFrames() can be briefly unavailable while an MV3 worker wakes. A
  // synthetic top-frame owner keeps Firefox's documentUrl path usable, but a
  // Chrome documentId cannot be authenticated until frame metadata recovers.
  // Retry on a later response instead of caching that incomplete state forever.
  const needsFrameMetadata =
    !owner ||
    Boolean(details.documentId && !owner.documentId && !documentUrlKey)
  if (needsFrameMetadata && !refreshed) {
    state = (await refreshNavigationState(details.tabId, context)) ?? state
    owner = state.frames.get(frameId)
  }
  if (!owner || owner.generation !== state.generation) return null

  if (
    details.documentId &&
    owner.documentId &&
    details.documentId !== owner.documentId
  ) {
    return null
  }
  if (documentUrlKey && documentUrlKey !== owner.frameUrlKey) return null
  // At least one browser-authenticated document signal is required. Without
  // one, a same-origin response from a document that navigated away cannot be
  // distinguished from the current page safely.
  if (!details.documentId && !documentUrlKey) return null
  if (details.documentId && !owner.documentId && !documentUrlKey) return null

  return { owner, state }
}

/**
 * Persist one response observed by webRequest. This path deliberately has no
 * Backend/ConnectionManager dependency: discovery remains useful while Motrix
 * is offline and submission is gated later by the Popup.
 */
export async function captureNetworkMediaResponse(
  details: NetworkResponseDetails,
  context: CaptureContext,
  requestHeaders?: Record<string, string>
): Promise<void> {
  if (details.tabId < 0) return
  if (
    typeof details.statusCode === 'number' &&
    details.statusCode >= 300 &&
    details.statusCode < 400
  ) {
    return
  }

  const resourceUrl = parseHttpUrl(details.url)
  if (!resourceUrl || isNoisySegment(resourceUrl)) return
  if (shouldExcludeHost(resourceUrl.hostname, context.webStore)) return

  const contentType = contentTypeFrom(details.responseHeaders)
  const kind = classifyMediaUrl(resourceUrl.toString(), contentType)
  if (!kind) return

  const resolved = await resolveFrameOwner(details, context)
  if (!resolved) return
  const { owner, state } = resolved
  const currentTab = await getTab(context.tabs, details.tabId)
  const currentPageUrl = currentTab?.url ? parseHttpUrl(currentTab.url) : null
  const currentPageKey = currentPageUrl
    ? pageKey(currentPageUrl.toString())
    : null
  const latestState = context.navigationByTab.get(details.tabId)
  if (
    !currentTab?.url ||
    !currentPageUrl ||
    shouldExcludeHost(currentPageUrl.hostname, context.webStore) ||
    currentPageKey !== state.topPageKey ||
    latestState !== state ||
    owner.generation !== state.generation
  ) {
    return
  }

  const inferredMime = normalizeMimeType(
    inferMediaMimeType(resourceUrl.toString(), contentType)
  )
  const dispositionFilename = contentDispositionFilename(
    details.responseHeaders
  )
  const baseFilename =
    dispositionFilename ??
    filenameFromUrl(resourceUrl) ??
    cleanSuggestedFilename(currentTab.title) ??
    'media'
  const suggestedFilename = appendMimeExtension(
    baseFilename,
    kind,
    inferredMime
  )
  const { sizeBytes, evidence: sizeEvidence } = responseSizeBytes(
    details.responseHeaders
  )
  const acceptsRanges = /^bytes$/i.test(
    headerValue(details.responseHeaders, 'accept-ranges') ?? ''
  )
  const evidence = new Set<string>(['network'])
  if (contentType) evidence.add('content-type')
  if (dispositionFilename) evidence.add('content-disposition')
  if (sizeEvidence) evidence.add(sizeEvidence)
  if (acceptsRanges) evidence.add('accept-ranges')
  const category = mediaCategory({
    kind,
    url: resourceUrl.toString(),
    ...(inferredMime ? { mimeType: inferredMime } : {}),
  })
  const isSvg =
    inferredMime === 'image/svg+xml' || /\.svgz?$/i.test(resourceUrl.pathname)
  const media: DetectedMedia = {
    kind,
    url: resourceUrl.toString(),
    pageUrl: currentTab.url,
    pageTitle: currentTab.title?.trim().slice(0, 512) || currentTab.url,
    detectedAt:
      typeof details.timeStamp === 'number' &&
      Number.isFinite(details.timeStamp)
        ? details.timeStamp
        : context.now(),
    ...(inferredMime ? { mimeType: inferredMime } : {}),
    category,
    suggestedFilename,
    ...(sizeBytes ? { sizeBytes } : {}),
    frameUrl: details.documentUrl || owner.frameUrlKey,
    evidence: [...evidence],
    ...(category === 'image' ? { previewable: !isSvg } : {}),
  }

  const credentialObservation: NetworkMediaCredentialObservation = {
    tabId: details.tabId,
    pageUrl: media.pageUrl,
    url: media.url,
    observedAt: context.now(),
    requestHeaders: requestHeaders ?? {},
  }
  context.credentialStore?.remember(credentialObservation)
  await context.store.addForPage(details.tabId, media.pageUrl, [media])
}

function resolveBrowserApis(): {
  webRequest: WebRequestLike | undefined
  webNavigation: WebNavigationLike | undefined
  tabs: TabsLike | undefined
} {
  const api = extensionBrowser as unknown as {
    webRequest?: WebRequestLike
    webNavigation?: WebNavigationLike
    tabs?: TabsLike
  }
  return {
    webRequest: api.webRequest,
    webNavigation: api.webNavigation,
    tabs: api.tabs,
  }
}

/** Register synchronously during service-worker evaluation. */
export function registerNetworkMediaCapture(
  options: NetworkMediaCaptureOptions
): () => void {
  const globals = resolveBrowserApis()
  const webRequest = options.webRequest ?? globals.webRequest
  const webNavigation = options.webNavigation ?? globals.webNavigation
  const tabs = options.tabs ?? globals.tabs
  if (!webRequest?.onHeadersReceived || !tabs?.get) return () => undefined

  const context: CaptureContext = {
    store: options.store,
    ...(options.credentialStore
      ? { credentialStore: options.credentialStore }
      : {}),
    tabs,
    ...(webNavigation ? { webNavigation } : {}),
    webStore: options.webStore ?? isWebStoreBuild(),
    now: options.now ?? Date.now,
    navigationByTab: new Map(),
    pendingRequestHeaders: new Map(),
  }

  const onSendHeaders = (details: NetworkRequestDetails): void => {
    if (context.webStore) {
      const topPageUrl = context.navigationByTab.get(details.tabId)?.topPageUrl
      // A cold worker has not yet authenticated the owning top document.
      // Fail closed instead of retaining request credentials until a response
      // or navigation event establishes the tab state.
      if (!topPageUrl) return
      const candidateUrls = [
        topPageUrl,
        details.documentUrl,
        details.initiator,
        details.url,
      ]
      try {
        for (const candidate of candidateUrls) {
          if (
            candidate &&
            shouldExcludeHost(new URL(candidate).hostname, true)
          ) {
            return
          }
        }
      } catch {
        return
      }
    }
    rememberRequestHeaders(details, context)
  }
  const onHeadersReceived = (details: NetworkResponseDetails): void => {
    // Consume synchronously so a reused requestId or later redirect cannot
    // inherit credentials from this response while async tab lookup runs.
    const requestHeaders = takeRequestHeaders(details, context)
    void captureNetworkMediaResponse(details, context, requestHeaders).catch(
      () => {
        // Resource discovery is best-effort. A malformed event, closed tab or
        // storage failure must never break unrelated service-worker listeners.
      }
    )
  }
  const onCommitted = (details: NavigationFrameLike): void => {
    commitNavigation(details, context, true)
  }
  const onHistoryStateUpdated = (details: NavigationFrameLike): void => {
    commitNavigation(details, context, false)
  }
  const onTabUpdated = (
    tabId: number,
    changeInfo: { url?: string },
    tab: TabLike
  ): void => {
    const pageUrl = changeInfo.url ?? tab.url
    if (!changeInfo.url || !pageUrl) return
    const current = context.navigationByTab.get(tabId)
    if (current?.topPageUrl === pageUrl) return
    commitNavigation(
      { tabId, frameId: 0, parentFrameId: -1, url: pageUrl },
      context,
      true
    )
  }
  const onTabRemoved = (tabId: number): void => {
    context.navigationByTab.delete(tabId)
    clearPendingForTab(tabId, context)
    context.credentialStore?.clear(tabId)
    void options.store.clear(tabId).catch(() => {
      // A closed tab should never be able to disturb other SW work.
    })
  }

  const cleanups: Array<() => void> = []
  const cleanup = (): void => {
    for (const remove of cleanups.splice(0).reverse()) {
      try {
        remove()
      } catch {
        // Continue rolling back the remaining listeners.
      }
    }
    context.pendingRequestHeaders.clear()
    context.credentialStore?.clearAll()
  }

  try {
    if (webRequest.onSendHeaders) {
      const requestFilter = {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      }
      let requestListenerRegistered = false
      if (options.includeExtraHeaders) {
        try {
          webRequest.onSendHeaders.addListener(onSendHeaders, requestFilter, [
            'requestHeaders',
            'extraHeaders',
          ])
          requestListenerRegistered = true
        } catch {
          // Firefox and older Chromium versions may reject `extraHeaders`.
          // Falling back is safe: unavailable Cookie provenance simply means
          // no cookies are replayed for that resource.
        }
      }
      if (!requestListenerRegistered) {
        webRequest.onSendHeaders.addListener(onSendHeaders, requestFilter, [
          'requestHeaders',
        ])
      }
      cleanups.push(() => {
        webRequest.onSendHeaders?.removeListener?.(onSendHeaders)
      })
    }
    webRequest.onHeadersReceived.addListener(
      onHeadersReceived,
      {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      },
      ['responseHeaders']
    )
    cleanups.push(() => {
      webRequest.onHeadersReceived.removeListener?.(onHeadersReceived)
    })
    if (webNavigation?.onCommitted) {
      webNavigation.onCommitted.addListener(onCommitted)
      cleanups.push(() => {
        webNavigation.onCommitted?.removeListener?.(onCommitted)
      })
    }
    if (webNavigation?.onHistoryStateUpdated) {
      webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated)
      cleanups.push(() => {
        webNavigation.onHistoryStateUpdated?.removeListener?.(
          onHistoryStateUpdated
        )
      })
    }
    if (tabs.onUpdated) {
      tabs.onUpdated.addListener(onTabUpdated)
      cleanups.push(() => {
        tabs.onUpdated?.removeListener?.(onTabUpdated)
      })
    }
    if (tabs.onRemoved) {
      tabs.onRemoved.addListener(onTabRemoved)
      cleanups.push(() => {
        tabs.onRemoved?.removeListener?.(onTabRemoved)
      })
    }
  } catch {
    cleanup()
    return () => undefined
  }

  return cleanup
}
