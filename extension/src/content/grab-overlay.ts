import { send } from '@/background/MessageBus'
import { extensionBrowser as browser } from '@/shared/browser'
import { newDownloadOperationId } from '@/shared/integration'
import type { QualityLabel } from '@/shared/mediaFormats'
import type { MessageResponse } from '@/shared/messages'

/**
 * In-page grab overlay — the IDM / Neat-style "download this video" affordance.
 *
 * The generic sniffer already finds media (network + DOM); this script only
 * presents it: a pill anchored to the top-right corner of the page's playing
 * <video> element that lists the tab's detected media and hands a chosen item
 * to the background, which submits it to Motrix through the same path the
 * popup uses. Pages whose sniffer finds nothing (e.g. YouTube watch pages)
 * still get a single row that submits the page URL for server-side resolution.
 *
 * Rendering lives in a closed shadow root so page CSS cannot restyle it and
 * the page's own layout cannot be disturbed. Every value that reaches the DOM
 * comes from the background projection (label, height, size) — never the
 * stored stream URL — and is inserted via `textContent`.
 *
 * If the extension is reloaded or updated while this script is alive, every
 * message call throws "Extension context invalidated". The overlay detects
 * that and removes itself so no dead button is left behind on the page.
 */

const POLL_INTERVAL_MS = 2_000
const MAX_VISIBLE_ITEMS = 6
const EDGE_INSET = 12
const HOST_ID = 'motrix-grab-overlay'
/** Format listings are stable for a while — refetch at most this often. */
const FORMATS_TTL_MS = 60_000
/** Videos smaller than this (CSS px) are treated as decorative, not content. */
const MIN_VIDEO_WIDTH = 120
const MIN_VIDEO_HEIGHT = 80

type Snapshot = MessageResponse<'bg.grabberSnapshot'>
type GrabItem = Snapshot['media'][number]
type FormatEntry =
  MessageResponse<'bg.grabberFormats'>['formats']['entries'][number]

type HostElement = HTMLElement & { __motrixGrabShadow?: ShadowRoot }

function t(key: string, fallback: string): string {
  try {
    const message = browser.i18n?.getMessage(key)
    return message || fallback
  } catch {
    return fallback
  }
}

function isContextInvalidated(error: unknown): boolean {
  const message = (error as Error)?.message ?? ''
  return /context invalidated/i.test(message)
}

function formatBytes(sizeBytes?: number): string {
  if (!Number.isFinite(sizeBytes ?? 0) || (sizeBytes ?? 0) <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = sizeBytes as number
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

function itemDescription(item: GrabItem): string {
  const parts: string[] = []
  if (item.height) parts.push(`${item.height}p`)
  const size = formatBytes(item.sizeBytes)
  if (size) parts.push(size)
  if (parts.length === 0 && item.mimeType) parts.push(item.mimeType)
  return parts.join(' · ')
}

function formatEntryDescription(entry: FormatEntry): string {
  const parts: string[] = []
  if (entry.ext) parts.push(entry.ext)
  const size = formatBytes(entry.sizeBytes)
  if (size) parts.push(size)
  return parts.join(' · ')
}

/** The video worth anchoring to: playing beats paused, visible area breaks ties. */
function pickTargetVideo(): HTMLVideoElement | null {
  const videos = document.querySelectorAll('video')
  let best: HTMLVideoElement | null = null
  let bestScore = 0
  for (const video of videos) {
    const rect = video.getBoundingClientRect()
    if (rect.width < MIN_VIDEO_WIDTH || rect.height < MIN_VIDEO_HEIGHT) continue
    const visibleWidth =
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
    const visibleHeight =
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    if (visibleWidth <= 0 || visibleHeight <= 0) continue
    const playing = !video.paused && !video.ended && video.readyState >= 2
    const score = visibleWidth * visibleHeight * (playing ? 4 : 1)
    if (score > bestScore) {
      bestScore = score
      best = video
    }
  }
  return best
}

function hasPlayingVideo(): boolean {
  const videos = document.querySelectorAll('video')
  for (const video of videos) {
    if (!video.paused && !video.ended && video.readyState >= 2) return true
  }
  return false
}

function ensureHost(): HostElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing as HostElement
  const host = document.createElement('div')
  host.id = HOST_ID
  // The host itself is position:fixed and invisible to hit-testing; the shadow
  // root paints. `display:none`-safe: the page may hide unknown top-level divs.
  host.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
  const shadow = host.attachShadow({ mode: 'closed' })
  ;(host as HostElement).__motrixGrabShadow = shadow
  ;(document.body ?? document.documentElement).appendChild(host)
  return host as HostElement
}

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed; left: 0; top: 0;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; color: #fff; direction: ltr;
    pointer-events: auto;
  }
  .wrap[hidden] { display: none; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 999px; border: 0; cursor: pointer;
    background: #5b6bff; color: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,.28);
    font: inherit; font-weight: 600;
    transition: transform .12s ease, background .12s ease;
  }
  .pill:hover { background: #4a59e6; transform: translateY(-1px); }
  .pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .count {
    background: rgba(255,255,255,.22); border-radius: 999px;
    padding: 1px 7px; font-size: 11px; font-weight: 700;
  }
  .panel {
    width: min(320px, calc(100vw - 32px));
    background: #1f2230; color: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 12px 32px rgba(0,0,0,.4);
  }
  .panel h2 {
    margin: 0; padding: 10px 12px; font-size: 12px; font-weight: 600;
    background: #262a3b; color: #c9cee6;
  }
  .list { max-height: 260px; overflow-y: auto; }
  .row {
    display: grid; grid-template-columns: minmax(0,1fr) auto;
    align-items: center; gap: 10px; width: 100%;
    padding: 9px 12px; border: 0; border-top: 1px solid #2c3043;
    background: transparent; color: inherit; font: inherit; text-align: start;
    cursor: pointer;
  }
  .row:hover { background: #262a3b; }
  .row:focus-visible { outline: 2px solid #7c8bff; outline-offset: -2px; }
  .row[disabled] { opacity: .55; cursor: default; }
  .label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    direction: ltr;
  }
  .meta { color: #9aa2c4; font-size: 11px; white-space: nowrap; }
  .section {
    padding: 7px 12px 5px; font-size: 11px; font-weight: 600;
    color: #9aa2c4; background: #191c28; border-top: 1px solid #2c3043;
  }
  .note { opacity: .65; cursor: default; }
  .note:hover { background: transparent; }
  .toast {
    padding: 8px 12px; border-radius: 10px; background: #1f2230;
    color: #fff; box-shadow: 0 8px 20px rgba(0,0,0,.35); font-size: 12px;
  }
  .toast[data-tone='error'] { background: #7f1d1d; }
`

export function installGrabOverlay(): void {
  if (typeof document === 'undefined' || !document.body) return
  if (window !== window.top) return

  const host = ensureHost()
  const shadow = host.__motrixGrabShadow
  if (!shadow) return

  const style = document.createElement('style')
  style.textContent = STYLE
  shadow.appendChild(style)

  const wrap = document.createElement('div')
  wrap.className = 'wrap'
  shadow.appendChild(wrap)

  let items: GrabItem[] = []
  let connected = false
  let panelOpen = false
  let busy = false
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let pillElement: HTMLElement | null = null
  // Last yt-dlp format listing, valid for the URL it was fetched for.
  let formats: MessageResponse<'bg.grabberFormats'>['formats'] | null = null
  let formatsForUrl: string | null = null
  let formatsFetchedAt = 0
  let formatsFlight = false

  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.hidden = true
  toast.setAttribute('role', 'status')

  const hasContent = (): boolean =>
    items.length > 0 || hasPlayingVideo() || pickTargetVideo() !== null

  const videoEntries = (): FormatEntry[] =>
    (formats?.entries ?? []).filter((entry) => entry.kind === 'video')
  const audioEntries = (): FormatEntry[] =>
    (formats?.entries ?? []).filter((entry) => entry.kind === 'audio')

  const render = (): void => {
    wrap.replaceChildren()
    pillElement = null
    if (!hasContent()) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    const qualityVideos = videoEntries()
    const qualityAudio = audioEntries()

    if (panelOpen) {
      const panel = document.createElement('div')
      panel.className = 'panel'
      const heading = document.createElement('h2')
      heading.textContent = connected
        ? t('grabberPanelTitle', 'Download with Motrix')
        : t('grabberNotConnected', 'Motrix is not connected — open the app')
      panel.appendChild(heading)

      const list = document.createElement('div')
      list.className = 'list'
      const appendNote = (text: string): void => {
        const note = document.createElement('div')
        note.className = 'row note'
        const label = document.createElement('span')
        label.className = 'label'
        label.textContent = text
        note.append(label)
        list.appendChild(note)
      }
      const appendRow = (
        label: string,
        meta: string,
        onClick: () => void
      ): void => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'row'
        row.disabled = busy || !connected
        const text = document.createElement('span')
        text.className = 'label'
        text.textContent = label
        text.title = label
        const metaSpan = document.createElement('span')
        metaSpan.className = 'meta'
        metaSpan.textContent = meta
        row.append(text, metaSpan)
        row.addEventListener('click', onClick)
        list.appendChild(row)
      }
      const appendSection = (key: string, fallback: string): void => {
        const section = document.createElement('div')
        section.className = 'section'
        section.textContent = t(key, fallback)
        list.appendChild(section)
      }

      // yt-dlp quality rows: the desktop's own view of what this page
      // offers. The row's key echoes back as meta.qualityLabel on submit.
      if (qualityVideos.length > 0) {
        appendSection('grabberSectionVideo', 'Video')
        for (const entry of qualityVideos) {
          appendRow(entry.label, formatEntryDescription(entry), () => {
            void resolvePage(entry.key as QualityLabel)
          })
        }
      }
      if (qualityAudio.length > 0) {
        appendSection('grabberSectionAudio', 'Audio')
        for (const entry of qualityAudio) {
          const label =
            entry.key === 'mp3'
              ? t('grabberMp3', 'MP3 (audio only)')
              : entry.label
          appendRow(label, formatEntryDescription(entry), () => {
            void resolvePage(entry.key as QualityLabel)
          })
        }
      }
      if (connected && formatsFlight) {
        appendNote(t('grabberFormatsLoading', 'Loading qualities…'))
      } else if (
        formats &&
        !formats.available &&
        formatsForUrl === location.href &&
        qualityVideos.length === 0 &&
        qualityAudio.length === 0
      ) {
        appendNote(t('grabberFormatsUnavailable', 'No downloadable qualities'))
      }

      // Sniffed media (network + DOM) always keeps its rows.
      if (items.length === 0 && qualityVideos.length === 0) {
        // Nothing sniffed and no quality rows (common on watch pages) but
        // Motrix can still resolve the page URL itself.
        appendRow(
          t('grabberButtonLabel', 'Download video'),
          t('grabberPageMeta', 'this page'),
          () => {
            void resolvePage()
          }
        )
      }
      for (const item of items.slice(0, MAX_VISIBLE_ITEMS)) {
        appendRow(item.label, itemDescription(item) || item.kind, () => {
          void submit(item)
        })
      }
      panel.appendChild(list)
      wrap.appendChild(panel)
    }

    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'pill'
    pill.setAttribute('aria-expanded', panelOpen ? 'true' : 'false')
    pill.setAttribute('aria-label', t('grabberButtonLabel', 'Download video'))
    const icon = document.createElement('span')
    icon.textContent = '↓'
    icon.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.textContent = t('grabberButtonLabel', 'Download video')
    pill.append(icon, label)
    const offerCount = items.length + qualityVideos.length + qualityAudio.length
    if (offerCount > 1) {
      const count = document.createElement('span')
      count.className = 'count'
      count.textContent = String(offerCount)
      pill.appendChild(count)
    }
    pill.addEventListener('click', () => {
      panelOpen = !panelOpen
      render()
      if (panelOpen) void fetchFormats()
    })
    wrap.appendChild(pill)
    pillElement = pill
    wrap.appendChild(toast)
    position()
  }

  /**
   * Anchor the pill to the playing video's top-right corner (IDM/Neat style),
   * shifting up when the open panel would push it out of view. Falls back to
   * the screen corner when the page has no anchorable <video>. The whole wrap
   * is hidden while the anchor video is scrolled off-screen.
   */
  const position = (): void => {
    const video = pickTargetVideo()
    const wrapWidth = wrap.offsetWidth
    const wrapHeight = wrap.offsetHeight
    const pillHeight = pillElement?.offsetHeight ?? 36
    if (!video) {
      wrap.hidden = !hasContent()
      wrap.style.left = ''
      wrap.style.top = ''
      wrap.style.right = `${EDGE_INSET + 4}px`
      wrap.style.bottom = `${EDGE_INSET + 4}px`
      return
    }
    const rect = video.getBoundingClientRect()
    const offscreen =
      rect.bottom < pillHeight + 2 * EDGE_INSET ||
      rect.top > window.innerHeight - EDGE_INSET ||
      rect.right < EDGE_INSET ||
      rect.left > window.innerWidth - EDGE_INSET
    wrap.hidden = offscreen || !hasContent()
    if (offscreen) return
    let top = rect.top + EDGE_INSET
    if (panelOpen) top -= wrapHeight - pillHeight + 8
    top = Math.max(
      EDGE_INSET,
      Math.min(top, window.innerHeight - pillHeight - EDGE_INSET)
    )
    const left = Math.max(
      EDGE_INSET,
      Math.min(
        rect.right - EDGE_INSET - wrapWidth,
        window.innerWidth - wrapWidth - EDGE_INSET
      )
    )
    wrap.style.right = ''
    wrap.style.bottom = ''
    wrap.style.left = `${Math.round(left)}px`
    wrap.style.top = `${Math.round(top)}px`
  }

  let positionScheduled = false
  const schedulePosition = (): void => {
    if (positionScheduled) return
    positionScheduled = true
    requestAnimationFrame(() => {
      positionScheduled = false
      position()
    })
  }

  const showToast = (
    message: string,
    tone: 'info' | 'error' = 'info'
  ): void => {
    toast.textContent = message
    toast.dataset.tone = tone
    toast.hidden = false
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.hidden = true
    }, 4_000)
    if (!items.length) render()
  }

  const teardown = (): void => {
    clearInterval(pollTimer)
    window.removeEventListener('scroll', schedulePosition, true)
    window.removeEventListener('resize', schedulePosition)
    document.removeEventListener('play', onVideoEvent, true)
    document.removeEventListener('pause', onVideoEvent, true)
    resizeObserver?.disconnect()
    host.remove()
  }

  const submit = async (item: GrabItem): Promise<void> => {
    if (busy) return
    busy = true
    render()
    try {
      await send('bg.grabberSubmit', {
        mediaKey: item.key,
        idempotencyKey: newDownloadOperationId(),
      })
      panelOpen = false
      showToast(t('grabberSent', 'Sent to Motrix'))
    } catch (error) {
      if (isContextInvalidated(error)) {
        teardown()
        return
      }
      showToast(
        `${t('grabberFailed', 'Could not send to Motrix')}: ${(error as Error)?.message ?? ''}`.trim(),
        'error'
      )
    } finally {
      busy = false
      render()
    }
  }

  const resolvePage = async (qualityLabel?: QualityLabel): Promise<void> => {
    if (busy) return
    busy = true
    render()
    try {
      await send('bg.resolvePageDownload', {
        idempotencyKey: newDownloadOperationId(),
        ...(qualityLabel ? { qualityLabel } : {}),
      })
      panelOpen = false
      showToast(t('grabberSent', 'Sent to Motrix'))
    } catch (error) {
      if (isContextInvalidated(error)) {
        teardown()
        return
      }
      showToast(
        `${t('grabberFailed', 'Could not send to Motrix')}: ${(error as Error)?.message ?? ''}`.trim(),
        'error'
      )
    } finally {
      busy = false
      render()
    }
  }

  /**
   * Ask the desktop for this page's yt-dlp format list (quality picker).
   * Auto-runs when a video starts playing and when the panel opens; the
   * URL-keyed TTL keeps polling cheap. Never throws — a disconnected
   * desktop or a listing failure simply leaves the sniffed rows as the
   * only offering (the background answers `{ available: false }`).
   */
  const fetchFormats = async (): Promise<void> => {
    if (formatsFlight || !connected) return
    if (
      formatsForUrl === location.href &&
      formats &&
      Date.now() - formatsFetchedAt < FORMATS_TTL_MS
    ) {
      return
    }
    formatsFlight = true
    if (panelOpen) render()
    try {
      const response = await send('bg.grabberFormats', {
        url: location.href,
      })
      formats = response.formats
      formatsForUrl = location.href
      formatsFetchedAt = Date.now()
      connected = response.connected
    } catch (error) {
      if (isContextInvalidated(error)) {
        teardown()
        return
      }
      // Transient failure — retry on the next trigger (play / open / poll).
    } finally {
      formatsFlight = false
      render()
    }
  }

  const refresh = async (): Promise<void> => {
    let snapshot: Snapshot | null = null
    try {
      snapshot = await send('bg.grabberSnapshot', undefined)
    } catch (error) {
      if (isContextInvalidated(error)) {
        teardown()
        return
      }
      // Service worker asleep or the extension was reloaded; retry on the
      // next tick rather than tearing down the overlay.
      return
    }
    if (!snapshot) return
    const next = snapshot.media ?? []
    const changed =
      next.length !== items.length ||
      next.some((item, index) => item.key !== items[index]?.key)
    // SPA navigation invalidates the previous page's listing.
    if (formatsForUrl !== null && formatsForUrl !== location.href) {
      formats = null
      formatsFetchedAt = 0
    }
    connected = snapshot.connected
    items = next
    if (changed || panelOpen) render()
    schedulePosition()
    // Auto-fetch qualities for any page the overlay would show (playing video
    // OR sniffed media) so the picker is populated by the time the panel
    // opens. fetchFormats dedupes via the URL-keyed TTL cache.
    if (connected && hasContent()) void fetchFormats()
  }

  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(schedulePosition)
      : null
  const onVideoEvent = (): void => {
    schedulePosition()
    void refresh()
  }

  window.addEventListener('scroll', schedulePosition, true)
  window.addEventListener('resize', schedulePosition)
  // 'play' and 'pause' do not bubble, but they are observable in the capture
  // phase — that is how the overlay notices a video starting after load.
  document.addEventListener('play', onVideoEvent, true)
  document.addEventListener('pause', onVideoEvent, true)
  const pollTimer = setInterval(() => {
    void refresh()
    schedulePosition()
  }, POLL_INTERVAL_MS)

  render()
  void refresh()
}

installGrabOverlay()
