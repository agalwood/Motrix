import type { Cookie, DownloadSubmitParams } from '@motrix/mdxp'
import type { ConnectionState } from '@/background/ConnectionManager'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import {
  CONNECT_DEADLINE_MS,
  commitHandoff,
  notifySafely,
} from '@/background/handoff/delivery'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import { i18n } from '@/shared/i18n'
import type { Notify } from '@/shared/notifications'
import { hostOf, isMagnetUrl, type TakeoverTarget } from '@/shared/takeover'

export type HandoffResult =
  | { kind: 'accepted'; taskId: string; operationId: string }
  | { kind: 'unknown'; operationId: string }
  | { kind: 'browser' | 'skipped' | 'failed' }

export interface HandoffOps {
  assertCurrent(): void
  getState(): ConnectionState
  /** Explicit user-intent (re)connect that launches Motrix (clearGateAndStart). */
  connectWithLaunch(): Promise<void>
  /** Poll until state==='connected' or the deadline elapses. */
  waitForConnected(deadlineMs: number): Promise<boolean>
  isPaired(): Promise<boolean>
  canAutoConnect(): Promise<boolean>
  isSensitive(host: string): boolean
  confirmSensitive(target: TakeoverTarget): Promise<boolean>
  /** Cancel + erase the native download (no-op on the right-click path). */
  cancelNative(): Promise<void>
  /** Resume an auto download, or start a browser download for an explicit right-click. */
  fallbackToBrowser(): Promise<void>
  captureCookies(url: string): Promise<Cookie[]>
  buildHeaders(target: TakeoverTarget): Record<string, string>
  submit(params: DownloadSubmitParams): Promise<{ taskId: string }>
  notify: Notify
  nudgePair(): Promise<void>
}

function canFallbackExplicitly(target: TakeoverTarget): boolean {
  return (
    target.origin === 'context-menu' &&
    (target.url.startsWith('http://') || target.url.startsWith('https://'))
  )
}

async function fallbackExplicitly(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<boolean> {
  if (!canFallbackExplicitly(target)) return false
  await ops.fallbackToBrowser()
  return true
}

function notifyBrowserFallback(ops: HandoffOps): void {
  notifySafely(ops, {
    title: i18n.t('notify.browserFallbackTitle'),
    message: i18n.t('notify.browserFallbackBody'),
    severity: 'reminder',
  })
}

type PreparedHandoff =
  | { kind: 'submit'; params: DownloadSubmitParams }
  | { kind: 'sensitive-skipped' }

async function prepareHandoff(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<PreparedHandoff> {
  if (ops.isSensitive(hostOf(target.url))) {
    if (!(await ops.confirmSensitive(target))) {
      return { kind: 'sensitive-skipped' }
    }
    return {
      kind: 'submit',
      params: buildSubmitParams(target, [], ops.buildHeaders(target)),
    }
  }

  const magnet = isMagnetUrl(target.url)
  const cookies = magnet ? [] : await ops.captureCookies(target.url)
  const headers = magnet ? {} : ops.buildHeaders(target)
  return {
    kind: 'submit',
    params: buildSubmitParams(target, cookies, headers),
  }
}

export async function runHandoff(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<HandoffResult> {
  try {
    return await runCurrentHandoff(target, ops)
  } catch (error) {
    // Before cancellation, the original browser download is still intact.
    if (!(error instanceof HandoffEndpointChangedError)) throw error
    return { kind: 'skipped' }
  }
}

async function runCurrentHandoff(
  target: TakeoverTarget,
  ops: HandoffOps
): Promise<HandoffResult> {
  ops.assertCurrent()
  // Step 1 — resolve connection without touching the native download.
  if (ops.getState() !== 'connected') {
    const explicit = target.origin === 'context-menu'
    if (
      !explicit &&
      (!(await ops.isPaired()) || !(await ops.canAutoConnect()))
    ) {
      await ops.nudgePair()
      ops.notify({
        title: i18n.t('notify.notConnectedTitle'),
        message: i18n.t('notify.notConnectedBody'),
        severity: 'reminder',
      })
      return { kind: 'skipped' }
    }
    let connected = false
    try {
      await ops.connectWithLaunch()
      connected = await ops.waitForConnected(CONNECT_DEADLINE_MS)
    } catch (error) {
      if (error instanceof HandoffEndpointChangedError) throw error
      // The native auto download is still untouched. Explicit HTTP(S) picks
      // have no native item yet, so they are started in the browser below.
    }
    if (!connected) {
      if (await fallbackExplicitly(target, ops)) {
        notifyBrowserFallback(ops)
        return { kind: 'browser' }
      }
      notifySafely(ops, {
        title: i18n.t('notify.notReachableTitle'),
        message: i18n.t('notify.notReachableBody'),
        severity: 'error',
      })
      return { kind: 'skipped' }
    }
  }

  // Step 2 — prepare without touching the native download. A right-click has
  // no native item to preserve, so preparation failures also start it in the
  // browser when the URL can be downloaded equivalently there.
  let prepared: PreparedHandoff
  try {
    ops.assertCurrent()
    prepared = await prepareHandoff(target, ops)
  } catch (error) {
    if (error instanceof HandoffEndpointChangedError) throw error
    if (await fallbackExplicitly(target, ops)) {
      notifyBrowserFallback(ops)
      return { kind: 'browser' }
    }
    throw error
  }

  if (prepared.kind === 'sensitive-skipped') {
    if (await fallbackExplicitly(target, ops)) {
      notifySafely(ops, {
        title: i18n.t('notify.sensitiveSkippedTitle'),
        message: i18n.t('notify.sensitiveSkippedBody'),
        severity: 'reminder',
      })
      return { kind: 'browser' }
    }
    notifySafely(ops, {
      title: i18n.t('notify.sensitiveSkippedTitle'),
      message: i18n.t('notify.sensitiveSkippedBody'),
      severity: 'reminder',
    })
    return { kind: 'skipped' }
  }

  // Step 3 — commit. Only now may the auto path cancel its native download.
  ops.assertCurrent()
  return await commitHandoff(prepared.params, ops)
}
