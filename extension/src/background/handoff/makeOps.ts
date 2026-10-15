import type { Cookie } from '@motrix/mdxp'
import type { ConnectionGate } from '@/background/ConnectionGate'
import type { ConnectionManager } from '@/background/ConnectionManager'
import {
  type BrowserCookieLike,
  mapCookies,
} from '@/background/capture/cookies'
import { isSensitiveDomain } from '@/background/capture/sensitiveDomains'
import {
  beforeDeadline,
  DownloadPreparationError,
} from '@/background/download-errors'
import type { HandoffGuard } from '@/background/handoff/guard'
import type { HandoffOps } from '@/background/handoff/runHandoff'
import { describeUrlForLog, log } from '@/background/log'
import type { PairNudge } from '@/background/pairNudge'
import { extensionBrowser as browser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import type { Notify } from '@/shared/notifications'
import type { TakeoverTarget } from '@/shared/takeover'
import { applyTaskOptions, type TaskOptions } from '@/shared/taskOptions'

export interface OpsDeps {
  taskOptions?: TaskOptions
  manager: Pick<
    ConnectionManager,
    | 'getState'
    | 'getLastError'
    | 'getRpcStatus'
    | 'clearGateAndStart'
    | 'ensureReady'
    | 'submitDownload'
  >
  guard: HandoffGuard
  /** `PairingEndpointService.isActivePaired` — the one definition of
   *  "paired" every consumer shares. */
  isPaired: () => Promise<boolean>
  gate: ConnectionGate
  nudge: PairNudge
  /** Auto path cancels its native item; right-click has no item to cancel. */
  cancelNative: () => Promise<void>
  /** Resume the auto download, or start the explicit right-click URL in the browser. */
  fallbackToBrowser: () => Promise<void>
  confirmSensitive: (t: TakeoverTarget) => Promise<boolean>
  notify: Notify
  deadlineAt?: number
}

async function waitForConnected(
  manager: Pick<ConnectionManager, 'getState'>,
  deadlineMs: number
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (manager.getState() === 'connected') return true
    if (
      manager.getState() === 'denied' ||
      manager.getState() === 'disconnected'
    ) {
      // brief grace for the single connect attempt to advance past transient states
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return manager.getState() === 'connected'
}

export function makeOps(deps: OpsDeps): HandoffOps {
  const { manager, gate, nudge } = deps
  const deadlineAt =
    deps.deadlineAt ??
    Date.now() + (deps.guard.origin === 'auto' ? 8000 : 150_000)
  const assertCurrent = (): void => {
    deps.guard.assertCurrent()
    if (Date.now() >= deadlineAt)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.preparationTimeout)
  }
  return {
    assertCurrent,
    getState: () => {
      const health = manager.getRpcStatus?.().health
      return health && health !== 'healthy'
        ? 'disconnected'
        : manager.getState()
    },
    connectWithLaunch: async () => {
      assertCurrent()
      log.debug(
        '[takeover] connectWithLaunch (clearGateAndStart); state=',
        manager.getState()
      )
      if (deps.guard.origin === 'context-menu' && !(await deps.isPaired())) {
        assertCurrent()
        await beforeDeadline(manager.clearGateAndStart(), deadlineAt)
      } else {
        await manager.ensureReady({
          intent:
            deps.guard.origin === 'auto'
              ? 'automatic-download'
              : 'explicit-download',
          deadlineAt,
          assertCurrent,
        })
      }
      assertCurrent()
    },
    waitForConnected: async (ms) => {
      const ok = await waitForConnected(
        manager,
        Math.min(ms, Math.max(0, deadlineAt - Date.now()))
      )
      log.debug(
        '[takeover] waitForConnected ->',
        ok,
        'finalState=',
        manager.getState(),
        'lastErr=',
        manager.getLastError()
      )
      return ok
    },
    isPaired: async () => {
      const paired = await deps.isPaired()
      log.debug('[takeover] isPaired=', paired)
      return paired
    },
    canAutoConnect: async () => {
      const can = await gate.shouldAutoConnect()
      log.debug('[takeover] canAutoConnect=', can)
      return can
    },
    isSensitive: (host) => isSensitiveDomain(host),
    confirmSensitive: deps.confirmSensitive,
    cancelNative: async () => {
      assertCurrent()
      log.debug('[takeover] cancelNative')
      await deps.cancelNative()
    },
    fallbackToBrowser: async () => {
      log.warn('[takeover] fallbackToBrowser (Motrix handoff unavailable)')
      await deps.fallbackToBrowser()
    },
    captureCookies: async (url): Promise<Cookie[]> => {
      if (
        deps.taskOptions &&
        (!deps.taskOptions.useBrowserCookies || deps.taskOptions.cookie)
      )
        return []
      assertCurrent()
      const raw = (await browser.cookies.getAll({
        url,
      })) as unknown as BrowserCookieLike[]
      log.debug(
        '[takeover] captureCookies count=',
        raw.length,
        'for',
        describeUrlForLog(url)
      )
      return mapCookies(raw)
    },
    buildHeaders: (t) => ({
      Referer: t.pageUrl,
      'User-Agent': navigator.userAgent,
    }),
    submit: async (params) => {
      if (deps.taskOptions) params = applyTaskOptions(params, deps.taskOptions)
      const primaryUrl =
        params.selection.kind === 'direct'
          ? describeUrlForLog(params.selection.primary.url)
          : '(non-direct)'
      log.debug(
        '[takeover] submit attempt; state=',
        manager.getState(),
        'url=',
        primaryUrl,
        'pageUrl=',
        describeUrlForLog(params.source.pageUrl),
        'title.len=',
        params.source.pageTitle.length,
        'cookies=',
        params.selection.kind === 'direct'
          ? params.selection.primary.cookies.length
          : -1
      )
      try {
        const r = await manager.submitDownload(params, {
          automaticTakeover: deps.guard.origin === 'auto',
          assertCurrent,
        })
        log.debug('[takeover] submit OK taskId=', r.taskId)
        return r
      } catch (e) {
        const err = e as { message?: string; code?: number; reason?: string }
        log.error(
          '[takeover] submit FAILED reason=',
          err?.reason ?? err?.code ?? 'unknown',
          'message=',
          err?.message
        )
        throw e
      }
    },
    notify: deps.notify,
    nudgePair: () => nudge.maybeNudge(),
  }
}
