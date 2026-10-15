import { send } from '@/background/MessageBus'
import { extensionBrowser as browser } from '@/shared/browser'
import type { MessageResponse } from '@/shared/messages'

/**
 * In-page grab overlay — the IDM / Neat-style "download this video" affordance.
 *
 * The generic sniffer already finds media (network + DOM); this script only
 * presents it: a floating pill that lists the tab's detected media and hands a
 * chosen item to the background, which submits it to Motrix through the same
 * path the popup uses.
 *
 * Rendering lives in a closed shadow root so page CSS cannot restyle it and
 * the page's own layout cannot be disturbed. Every value that reaches the DOM
 * comes from the background projection (label, height, size) — never the
 * stored stream URL — and is inserted via `textContent`.
 */

const POLL_INTERVAL_MS = 2_000
const MAX_VISIBLE_ITEMS = 6
const HOST_ID = 'motrix-grab-overlay'

type Snapshot = MessageResponse<'bg.grabberSnapshot'>
type GrabItem = Snapshot['media'][number]

type HostElement = HTMLElement & { __motrixGrabShadow?: ShadowRoot }

function t(key: string, fallback: string): string {
  try {
    const message = browser.i18n?.getMessage(key)
    return message || fallback
  } catch {
    return fallback
  }
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

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `grab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function ensureHost(): HostElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing as HostElement
  const host = document.createElement('div')
  host.id = HOST_ID
  // The host itself is position:fixed and invisible to hit-testing; the shadow
  // root paints. `display:none`-safe: the page may hide unknown top-level divs.
  host.style.cssText =
    'position:fixed;inset:auto 0 0 0;z-index:2147483647;pointer-events:none;'
  const shadow = host.attachShadow({ mode: 'closed' })
  ;(host as HostElement).__motrixGrabShadow = shadow
  ;(document.body ?? document.documentElement).appendChild(host)
  return host as HostElement
}

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed; right: 16px; bottom: 16px;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; color: #fff; direction: ltr;
    pointer-events: auto;
  }
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
  .kind {
    font-size: 10px; font-weight: 700; letter-spacing: .04em;
    color: #9aa2c4; text-transform: uppercase;
  }
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

  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.hidden = true
  toast.setAttribute('role', 'status')

  const render = (): void => {
    wrap.replaceChildren()
    if (items.length === 0) return

    if (panelOpen) {
      const panel = document.createElement('div')
      panel.className = 'panel'
      const heading = document.createElement('h2')
      heading.textContent = t(
        'grabberPanelTitle',
        connected ? 'Download with Motrix' : 'Motrix is not connected'
      )
      panel.appendChild(heading)

      const list = document.createElement('div')
      list.className = 'list'
      for (const item of items.slice(0, MAX_VISIBLE_ITEMS)) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'row'
        row.disabled = busy || !connected

        const text = document.createElement('span')
        text.className = 'label'
        text.textContent = item.label
        text.title = item.label

        const meta = document.createElement('span')
        meta.className = 'meta'
        const description = itemDescription(item)
        meta.textContent = description || item.kind

        row.append(text, meta)
        row.addEventListener('click', () => {
          void submit(item)
        })
        list.appendChild(row)
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
    if (items.length > 1) {
      const count = document.createElement('span')
      count.className = 'count'
      count.textContent = String(items.length)
      pill.appendChild(count)
    }
    pill.addEventListener('click', () => {
      panelOpen = !panelOpen
      render()
    })
    wrap.appendChild(pill)
    wrap.appendChild(toast)
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

  const submit = async (item: GrabItem): Promise<void> => {
    if (busy) return
    busy = true
    render()
    try {
      await send('bg.grabberSubmit', {
        mediaKey: item.key,
        idempotencyKey: newIdempotencyKey(),
      })
      panelOpen = false
      showToast(t('grabberSent', 'Sent to Motrix'))
    } catch (error) {
      showToast(
        `${t('grabberFailed', 'Could not send to Motrix')}: ${(error as Error)?.message ?? ''}`.trim(),
        'error'
      )
    } finally {
      busy = false
      render()
    }
  }

  const refresh = async (): Promise<void> => {
    let snapshot: Snapshot | null = null
    try {
      snapshot = await send('bg.grabberSnapshot', undefined)
    } catch {
      // Service worker asleep or the extension was reloaded; retry on the
      // next tick rather than tearing down the overlay.
      return
    }
    if (!snapshot) return
    const next = snapshot.media ?? []
    const changed =
      next.length !== items.length ||
      next.some((item, index) => item.key !== items[index]?.key)
    connected = snapshot.connected
    items = next
    if (changed || panelOpen) render()
  }

  void refresh()
  setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
}

installGrabOverlay()
