import type { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import type { ConnectionGate } from '@/background/ConnectionGate'
import type { ConnectionManager } from '@/background/ConnectionManager'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { type ProbeResult, probeTarget } from '@/background/capture/probeSize'
import { isFaithfulReplay } from '@/background/capture/replayFidelity'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { type HandoffResult, runHandoff } from '@/background/handoff/runHandoff'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import {
  isEligibleDownload,
  pickDownloadUrl,
} from '@/background/interception/eligibility'
import { createHold } from '@/background/interception/holdController'
import { describeUrlForLog, log } from '@/background/log'
import type { PairNudge } from '@/background/pairNudge'
import { decideTakeover } from '@/background/policy/decideTakeover'
import { extensionBrowser as browser, nativeBrowser } from '@/shared/browser'
import type { Notify } from '@/shared/notifications'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

export interface ChromiumInterceptionDeps {
  popup?: AutoOpenPopupService
  confirm?: (
    target: TakeoverTarget,
    windowId: number | undefined,
    guard: HandoffGuard
  ) => Promise<void>
  captureGuard: () => Promise<HandoffGuard | null>
  getConfig: () => Promise<TakeoverConfig>
  manager: ConnectionManager
  /** `PairingEndpointService.isActivePaired` — see `OpsDeps.isPaired`. */
  isPaired: () => Promise<boolean>
  gate: ConnectionGate
  nudge: PairNudge
  notify: Notify
  selfExtensionId: string
}

/**
 * Chromium suspends a determination for at most 15s once the listener
 * returns true (ExtensionDownloadsEventRouterData::determine_filename_timeout_).
 * Our guard fires first so a hung handoff can never race the browser's
 * timeout into a post-suggest cancel. Budget: probe ≤3s + connect ≤8s.
 */
export const HOLD_DEADLINE_MS = 12_000

interface DeterminingItem {
  id: number
  url: string
  finalUrl?: string
  byExtensionId?: string | undefined
  totalBytes?: number
  referrer?: string
  filename?: string
  mime?: string
}

export function registerChromiumInterception(
  deps: ChromiumInterceptionDeps
): void {
  // Feature-detect: onDeterminingFilename is Chromium-only. Register on the
  // NATIVE chrome namespace — the async protocol needs the listener's raw
  // `return true` to reach Chrome's bindings, so the webextension-polyfill
  // must not sit in between (spec §2 finding 5).
  const event = nativeBrowser.downloads?.onDeterminingFilename
  if (!event) return

  event.addListener((item, suggest) => {
    // Sync declines return undefined WITHOUT suggesting: Chrome then
    // auto-suggests, and our own re-issued downloads are never held.
    if (!isEligibleDownload(item, deps.selfExtensionId)) return undefined
    void handleHeld(item, pickDownloadUrl(item), suggest, deps)
    return true // suspend determination until we release or commit
  })
}

async function handleHeld(
  item: DeterminingItem,
  url: string,
  suggest: () => void,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  const popupWindow = deps.popup?.captureWindow()
  let presentation:
    | {
        result: Extract<HandoffResult, { kind: 'accepted' }>
        guard: HandoffGuard
        enabled: boolean
      }
    | undefined
  const deadlineAt = Date.now() + 8000
  const hold = createHold(
    {
      suggest,
      cancel: async () => {
        await browser.downloads.cancel(item.id)
      },
      erase: async () => {
        await browser.downloads.erase({ id: item.id })
      },
    },
    HOLD_DEADLINE_MS
  )

  try {
    const cfg = await deps.getConfig()
    if (!cfg.enabled) return
    if (cfg.downloadMode === 'confirm') {
      // Never hold filename determination while waiting for a human.
      hold.release()
      await confirmInterceptedDownload(item, cfg, popupWindow, deps)
      return
    }
    const guard = await deps.captureGuard()
    if (guard === null) return

    let sizeBytes: number | null =
      typeof item.totalBytes === 'number' && item.totalBytes > 0
        ? item.totalBytes
        : null
    // The probe rehearses Motrix's own GET. Its Content-Type is the only
    // evidence we get that the browser's download was not a plain GET (see
    // replayFidelity), and its length feeds minSizeMB rules. Run it at most
    // once; apply unknownSizeAction only if the probe also cannot find a size.
    let probe: ProbeResult | null = null
    const runProbe = async (): Promise<ProbeResult> => {
      probe ??= await probeTarget(url, { fetch: globalThis.fetch })
      return probe
    }
    if (sizeBytes === null) {
      sizeBytes = (await runProbe()).sizeBytes
    }

    const target = normalizeTarget({
      url,
      ...(typeof item.referrer === 'string' && item.referrer.length > 0
        ? { referrer: item.referrer }
        : {}),
      ...(typeof item.filename === 'string'
        ? { suggestedFilename: item.filename }
        : {}),
      ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
      sizeBytes,
      origin: 'auto',
    })

    const decision = decideTakeover(cfg, target)
    log.debug(
      '[takeover] onDeterminingFilename(held) url=',
      describeUrlForLog(url),
      'mime=',
      item.mime,
      'totalBytes=',
      item.totalBytes,
      'sizeBytes=',
      sizeBytes,
      'decision=',
      decision,
      'state=',
      deps.manager.getState()
    )
    if (decision !== 'motrix') return // finally releases the native download
    const { contentType } = await runProbe()
    if (
      !isFaithfulReplay({
        itemMime: item.mime ?? '',
        suggestedFilename: target.suggestedFilename,
        probedContentType: contentType,
      })
    ) {
      // Replaying this URL would fetch a different resource than the browser
      // is downloading (a form-POST download, typically). Leave it native.
      log.debug(
        '[takeover] declined: GET replay would not be faithful; contentType=',
        contentType
      )
      return
    }

    const ops = makeOps({
      manager: deps.manager,
      guard,
      deadlineAt,
      isPaired: deps.isPaired,
      gate: deps.gate,
      nudge: deps.nudge,
      cancelNative: () => hold.cancelNative(),
      fallbackToBrowser: async () => {
        await browser.downloads.download({ url })
      },
      // MVP: no blocking confirm UI in the SW, so sensitive domains auto-decline (leaves the native download intact). Real per-download confirm UI is deferred to Plan 2/3.
      confirmSensitive: async () => false,
      notify: deps.notify,
    })
    const result = await runHandoff(target, ops)
    if (result?.kind === 'accepted')
      presentation = { result, guard, enabled: cfg.openTaskPanelAfterSubmit }
  } catch (e) {
    log.debug('[takeover] held handoff aborted', e)
  } finally {
    hold.dispose()
    hold.release() // no-op if committed or already released
  }
  if (presentation && deps.popup) {
    const windowId = await popupWindow
    const { result, guard, enabled } = presentation
    if (windowId != null && guard.endpointId)
      void deps.popup.present({
        ...result,
        endpointId: guard.endpointId,
        endpointRevision: guard.endpointRevision ?? 0,
        windowId,
        enabledAtCapture: enabled,
        assertCurrent: guard.assertCurrent,
      })
  }
}
