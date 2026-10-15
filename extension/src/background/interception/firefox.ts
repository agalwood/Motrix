import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { type ProbeResult, probeTarget } from '@/background/capture/probeSize'
import { isFaithfulReplay } from '@/background/capture/replayFidelity'
import { makeOps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import {
  isEligibleDownload,
  pickDownloadUrl,
} from '@/background/interception/eligibility'
import {
  firefoxDownloadSize,
  readActiveFirefoxDownload,
  waitForFirefoxMetadata,
} from '@/background/interception/firefoxMetadata'
import { describeUrlForLog, log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'

const pendingDownloads = new Set<number>()

export async function cancelFirefoxDownload(id: number): Promise<void> {
  await browser.downloads.cancel(id)
  try {
    await browser.downloads.erase({ id })
  } catch (error) {
    // The native item is already cancelled at this point. History cleanup is
    // cosmetic and must not abort the Motrix submit, which would otherwise
    // leave the user with a cancelled download and no replacement.
    log.debug('[takeover] Firefox download history cleanup failed', error)
  }
}

export function registerFirefoxInterception(
  deps: ChromiumInterceptionDeps
): void {
  browser.downloads?.onCreated?.addListener((item) => {
    if (
      !isEligibleDownload(
        item as unknown as {
          url: string
          finalUrl?: string
          byExtensionId?: string
        },
        deps.selfExtensionId
      )
    )
      return
    void handleFirefoxDownloadSafely(item, deps)
  })
}

/** Firefox's downloads event ignores returned promises. Keep a rejected
 * startup barrier or handoff contained without logging URL-bearing errors. */
export async function handleFirefoxDownloadSafely(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  if (pendingDownloads.has(item.id)) return
  pendingDownloads.add(item.id)
  try {
    await handle(item, deps)
  } catch {
    log.debug('[takeover] Firefox handoff unavailable')
  } finally {
    pendingDownloads.delete(item.id)
  }
}

async function handle(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const popupWindow = deps.popup?.captureWindow()
  let cfg = await deps.getConfig()
  if (!cfg.enabled) {
    log.debug('[takeover] Firefox automatic takeover disabled')
    return
  }
  const guard = await deps.captureGuard()
  if (guard === null) {
    log.debug('[takeover] Firefox automatic takeover unavailable for backend')
    return
  }
  if (cfg.downloadMode === 'confirm') {
    if (!deps.confirm) return
    const current = await waitForFirefoxMetadata(item.id)
    if (!current) return
    guard.assertCurrent()
    cfg = await deps.getConfig()
    if (!cfg.enabled || cfg.downloadMode !== 'confirm') return
    await confirmInterceptedDownload(current, cfg, popupWindow, deps, guard)
    return
  }
  const url = pickDownloadUrl(item)

  // Probe at most once within the same 3 s window as native metadata reads.
  // Its failure must not discard the size Firefox learned in the meantime.
  let probe: ProbeResult | null = null
  let probePromise: Promise<ProbeResult> | undefined
  const runProbe = async (): Promise<ProbeResult> => {
    probePromise ??= probeTarget(url, { fetch: globalThis.fetch }).then(
      (result) => {
        probe = result
        return result
      }
    )
    return probePromise
  }
  if (firefoxDownloadSize(item) === null) void runProbe()
  const observed = await waitForFirefoxMetadata(
    item.id,
    () => probe?.sizeBytes ?? null
  )
  if (!observed) return
  if (probePromise && firefoxDownloadSize(observed) === null) await probePromise
  const latest = await readActiveFirefoxDownload(item.id)
  if (!latest) return
  cfg = await deps.getConfig()
  if (!cfg.enabled || cfg.downloadMode === 'confirm') return

  const makeTarget = (current: Browser.downloads.DownloadItem) =>
    normalizeTarget({
      url: pickDownloadUrl(current),
      ...(current.referrer ? { referrer: current.referrer } : {}),
      ...(current.filename ? { suggestedFilename: current.filename } : {}),
      ...(current.mime ? { mime: current.mime } : {}),
      sizeBytes: firefoxDownloadSize(current) ?? probe?.sizeBytes ?? null,
      origin: 'auto',
    })
  let target = makeTarget(latest)
  const logDecision = () =>
    log.debug(
      '[takeover] Firefox decision=',
      decideTakeover(cfg, target),
      'mime=',
      item.mime,
      'totalBytes=',
      item.totalBytes,
      'sizeBytes=',
      target.sizeBytes,
      'sizeSource=',
      firefoxDownloadSize(item) !== null
        ? 'browser'
        : probe?.sizeBytes != null
          ? 'probe'
          : 'unknown',
      'url=',
      describeUrlForLog(target.url)
    )
  item = latest
  logDecision()
  if (decideTakeover(cfg, target) !== 'motrix') return

  const { contentType } = await runProbe()
  const current = await readActiveFirefoxDownload(item.id)
  if (!current) return
  item = current
  cfg = await deps.getConfig()
  target = makeTarget(current)
  logDecision()
  if (
    cfg.downloadMode === 'confirm' ||
    decideTakeover(cfg, target) !== 'motrix' ||
    !isEligibleDownload(current, deps.selfExtensionId)
  )
    return
  if (
    !isFaithfulReplay({
      itemMime: item.mime ?? '',
      suggestedFilename: target.suggestedFilename,
      probedContentType: contentType,
    })
  ) {
    // Firefox has not cancelled the native download yet; leaving it alone
    // lets the browser finish the file it actually negotiated.
    log.debug(
      '[takeover] declined: GET replay would not be faithful; contentType=',
      contentType
    )
    return
  }

  const ops = makeOps({
    manager: deps.manager,
    guard,
    isPaired: deps.isPaired,
    gate: deps.gate,
    nudge: deps.nudge,
    cancelNative: async () => {
      // Connecting/cookie capture may outlive the browser transfer. Never
      // cancel or resubmit a file that finished or was paused by the user.
      const active = await readActiveFirefoxDownload(item.id)
      const config = await deps.getConfig()
      guard.assertCurrent()
      if (
        !active ||
        config.downloadMode === 'confirm' ||
        decideTakeover(config, makeTarget(active)) !== 'motrix'
      )
        throw new Error('Firefox native download no longer eligible')
      await cancelFirefoxDownload(item.id)
    },
    fallbackToBrowser: async () => {
      await browser.downloads.download({ url })
    },
    // MVP: no blocking confirm UI in the SW, so sensitive domains auto-decline (leaves the native download intact). Real per-download confirm UI is deferred to Plan 2/3.
    confirmSensitive: async () => false,
    notify: deps.notify,
  })
  const result = await runHandoff(target, ops)
  if (result?.kind === 'accepted' && deps.popup && guard.endpointId) {
    const windowId = await popupWindow
    if (windowId != null)
      void deps.popup.present({
        ...result,
        endpointId: guard.endpointId,
        endpointRevision: guard.endpointRevision ?? 0,
        windowId,
        enabledAtCapture: cfg.openTaskPanelAfterSubmit,
        assertCurrent: guard.assertCurrent,
      })
  }
}
