import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { isSensitiveDomain } from '@/background/capture/sensitiveDomains'
import type { ConfirmationResult } from '@/background/DownloadConfirmationService'
import { beforeDeadline } from '@/background/download-errors'
import {
  HandoffEndpointChangedError,
  type HandoffGuard,
} from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import {
  hostOf,
  type TakeoverConfig,
  type TakeoverTarget,
} from '@/shared/takeover'

export interface WebRequestEarlyConfirmDeps {
  confirmRequest: (
    target: TakeoverTarget,
    windowId: number | undefined,
    guard: HandoffGuard
  ) => Promise<ConfirmationResult>
}

const EARLY_KEY = 'motrix.earlyTakeover'
const CONFIG_KEY = 'motrix.takeoverConfig'
export const EARLY_PREFLIGHT_MS = 1500

interface EarlyRequestDetails {
  url: string
  method: string
  statusCode: number
  type: string
  tabId: number
  originUrl?: string
  documentUrl?: string
  responseHeaders?: { name: string; value?: string }[]
}

const BINARY_DOCUMENT_TYPES = new Set([
  'application/octet-stream',
  'application/x-gzip',
  'application/gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-msdownload',
  'application/vnd.android.package-archive',
  'application/iso-image',
  'application/x-iso9660-image',
])

function header(details: EarlyRequestDetails, name: string): string {
  return (
    details.responseHeaders?.find((h) => h.name.toLowerCase() === name)
      ?.value ?? ''
  )
}

function isCandidate(details: EarlyRequestDetails): boolean {
  if (details.tabId < 0) return false
  if (
    details.method !== 'GET' ||
    details.statusCode < 200 ||
    details.statusCode >= 300
  )
    return false
  if (!['main_frame', 'sub_frame', 'object'].includes(details.type))
    return false
  // Extension-initiated downloads include our fallback and confirmed browser
  // action, including redirects. Do not use a URL TTL: a later user request
  // for the same URL is a new download and must still obey the policy.
  if (
    [details.originUrl, details.documentUrl].some((url) =>
      url?.startsWith('moz-extension://')
    )
  )
    return false
  const disposition = header(details, 'content-disposition')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  if (disposition === 'attachment') return true
  if (disposition === 'inline' || details.type === 'sub_frame') return false
  return BINARY_DOCUMENT_TYPES.has(
    header(details, 'content-type').split(';')[0]?.trim().toLowerCase() ?? ''
  )
}

/** Extracts the real filename from a Content-Disposition header (RFC 5987
 * filename* takes precedence over the quoted plain form). Download links
 * like download.jsp?id=... name the file only through this header. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition)
  if (star) {
    const raw = star[1]?.trim().replace(/^"|"$/g, '')
    if (raw) {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
    return null
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(disposition)
  return plain ? (plain[2]?.trim() ?? null) : null
}

interface Prepared {
  target: TakeoverTarget
  cfg: TakeoverConfig
  guard: HandoffGuard
  windowId: number | undefined
}

/** The response has already been cancelled before this function runs. */
async function submitCancelled(
  prepared: Prepared,
  deps: ChromiumInterceptionDeps,
  confirmation: WebRequestEarlyConfirmDeps
): Promise<void> {
  const { target, cfg, guard, windowId } = prepared
  // Cache even a rejected attempt. Neither runHandoff's fallback nor an outer
  // catch may issue a second download for the same cancelled response.
  let fallback: Promise<unknown> | undefined
  const fallbackToBrowser = async (): Promise<void> => {
    fallback ??= Promise.resolve().then(() =>
      browser.downloads.download({ url: target.url })
    )
    await fallback
  }
  let owned = false
  try {
    guard.assertCurrent()
    if (cfg.downloadMode === 'confirm') {
      const result = await confirmation.confirmRequest(target, windowId, guard)
      if (result.action === 'unavailable' || result.action === 'unsupported')
        await fallbackToBrowser()
      // accepted/browser are owned by confirmation actions; cancel is final.
      return
    }
    const result = await runHandoff(
      target,
      makeOps({
        manager: deps.manager,
        guard,
        isPaired: deps.isPaired,
        gate: deps.gate,
        nudge: deps.nudge,
        cancelNative: async () => {},
        fallbackToBrowser,
        confirmSensitive: async () => false,
        notify: deps.notify,
      })
    )
    switch (result.kind) {
      case 'accepted':
        owned = true
        if (deps.popup && guard.endpointId && windowId !== undefined) {
          // Presentation errors cannot undo an accepted transfer.
          void deps.popup
            .present({
              ...result,
              endpointId: guard.endpointId,
              endpointRevision: guard.endpointRevision ?? 0,
              windowId,
              enabledAtCapture: cfg.openTaskPanelAfterSubmit,
              assertCurrent: guard.assertCurrent,
            })
            .catch(() => {})
        }
        return
      case 'browser':
      case 'unknown':
        owned = true
        return
      case 'skipped':
      case 'failed':
        await fallbackToBrowser()
    }
  } catch {
    if (owned) return
    // Do not log exceptions containing signed URLs or response credentials.
    log.debug('[early-takeover] handoff unavailable')
    try {
      await fallbackToBrowser()
    } catch {
      log.debug('[early-takeover] browser fallback unavailable')
    }
  }
}

/** Short, read-only preflight, then cancel and deliver in a separate task.
 * No user interaction or Motrix submission is awaited by the blocking event.
 * As with the native adapter, an accepted Motrix task must replay the URL;
 * strictly one-use URLs cannot be made replayable by this API.
 */
export function registerWebRequestEarlyTakeover(
  deps: ChromiumInterceptionDeps,
  confirmation: WebRequestEarlyConfirmDeps
): void {
  let earlyEnabled = true
  let generation = 0
  let earlyGeneration = 0
  const ready = (async () => {
    const initial = earlyGeneration
    try {
      const stored = await browser.storage.local.get(EARLY_KEY)
      if (earlyGeneration === initial)
        earlyEnabled =
          (stored[EARLY_KEY] as { enabled?: boolean } | undefined)?.enabled !==
          false
    } catch {
      if (earlyGeneration === initial) earlyEnabled = false
    }
  })()
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[EARLY_KEY]) {
      earlyGeneration += 1
      earlyEnabled =
        (changes[EARLY_KEY].newValue as { enabled?: boolean } | undefined)
          ?.enabled !== false
    }
    if (changes[EARLY_KEY] || changes[CONFIG_KEY]) generation += 1
  })

  const prepare = async (
    details: EarlyRequestDetails
  ): Promise<Prepared | null> => {
    await ready
    if (!earlyEnabled) return null
    const captured = generation
    const cfg = await deps.getConfig()
    if (!cfg.enabled) return null
    const guard = await deps.captureGuard()
    if (!guard) return null
    const tab =
      details.tabId >= 0
        ? await browser.tabs.get(details.tabId).catch(() => undefined)
        : undefined
    const length = Number(header(details, 'content-length'))
    const referrer = details.originUrl ?? details.documentUrl ?? tab?.url
    const suggested = filenameFromDisposition(
      header(details, 'content-disposition')
    )
    const target = normalizeTarget({
      url: details.url,
      ...(referrer ? { referrer } : {}),
      ...(suggested ? { suggestedFilename: suggested } : {}),
      mime: header(details, 'content-type'),
      sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
      origin: 'auto',
    })
    if (decideTakeover(cfg, target) !== 'motrix') return null
    if (cfg.downloadMode !== 'confirm') {
      if (isSensitiveDomain(hostOf(target.url))) return null
      if (
        deps.manager.getState() !== 'connected' &&
        (!(await deps.isPaired()) || !(await deps.gate.shouldAutoConnect()))
      )
        return null
    }
    const current: HandoffGuard = {
      ...guard,
      assertCurrent: () => {
        guard.assertCurrent()
        if (!earlyEnabled || captured !== generation)
          throw new HandoffEndpointChangedError()
      },
    }
    current.assertCurrent()
    return {
      target: { ...target, nativeDownloadCancelled: true },
      cfg,
      guard: current,
      windowId: tab?.windowId,
    }
  }

  const listener = async (
    details: EarlyRequestDetails
  ): Promise<Browser.webRequest.BlockingResponse> => {
    if (!isCandidate(details)) return {}
    try {
      const prepared = await beforeDeadline(
        prepare(details),
        Date.now() + EARLY_PREFLIGHT_MS
      )
      if (!prepared) return {}
      prepared.guard.assertCurrent()
      // Return cancellation before opening the form or starting a fallback.
      // Late preflight completion after a timeout has no side effects.
      setTimeout(() => {
        void submitCancelled(prepared, deps, confirmation)
      }, 0)
      return { cancel: true }
    } catch {
      log.debug(
        '[early-takeover] preflight unavailable; leaving response intact'
      )
      return {}
    }
  }
  browser.webRequest.onHeadersReceived.addListener(
    (details) =>
      listener(
        details as EarlyRequestDetails
      ) as unknown as Browser.webRequest.BlockingResponse,
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['main_frame', 'sub_frame', 'object'],
    },
    ['blocking', 'responseHeaders']
  )
}
