import type { DownloadSubmitParams } from '@motrix/mdxp'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import type { HandoffOps, HandoffResult } from '@/background/handoff/runHandoff'
import {
  RemoteAutomaticTakeoverConsentRequiredError,
  RemoteDataBoundaryConsentRequiredError,
} from '@/background/remote-submit-policy'
import { i18n } from '@/shared/i18n'
import type { Notify } from '@/shared/notifications'

export const CONNECT_DEADLINE_MS = 8000

export function notifySafely(
  ops: Pick<HandoffOps, 'notify'>,
  input: Parameters<Notify>[0]
): void {
  try {
    ops.notify(input)
  } catch {
    // Notifications are advisory. A renderer/API failure must never change the
    // already-committed download transaction or trigger a native fallback.
  }
}

async function submitOrFallback(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<HandoffResult> {
  let accepted: { taskId: string }
  try {
    accepted = await submitWithRetry(params, ops)
  } catch (error) {
    if (error instanceof DownloadOutcomeUnknownError) {
      notifySafely(ops, {
        title: i18n.t('notify.submitUnknownTitle'),
        message: i18n.t('notify.submitUnknownBody'),
        severity: 'reminder',
      })
      return { kind: 'unknown', operationId: params.idempotencyKey ?? '' }
    }
    let fellBack = false
    try {
      // Magnet links cannot be restored through the browser downloads API.
      if (params.selection.kind === 'direct') {
        await ops.fallbackToBrowser()
        fellBack = true
      }
    } finally {
      notifySafely(ops, {
        title: i18n.t('notify.submitFailedTitle'),
        message: i18n.t(
          fellBack ? 'notify.submitFailedBody' : 'notify.notReachableBody'
        ),
        severity: 'error',
      })
    }
    return { kind: fellBack ? 'browser' : 'failed' }
  }

  notifySafely(ops, {
    title: i18n.t('notify.handedToMotrix'),
    message: params.meta.suggestedFilename,
    severity: 'confirm',
  })
  return {
    kind: 'accepted',
    taskId: accepted.taskId,
    operationId: params.idempotencyKey ?? '',
  }
}

async function submitWithRetry(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<{ taskId: string }> {
  try {
    return await ops.submit(params)
  } catch (error) {
    // Consent and endpoint changes cannot be repaired by resending the same
    // request. Other failures retain the existing idempotent retry.
    if (
      error instanceof DownloadOutcomeUnknownError ||
      error instanceof DownloadPreparationError ||
      error instanceof HandoffEndpointChangedError ||
      error instanceof RemoteDataBoundaryConsentRequiredError ||
      error instanceof RemoteAutomaticTakeoverConsentRequiredError
    )
      throw error
    if (ops.getState() !== 'connected') {
      try {
        await ops.waitForConnected(CONNECT_DEADLINE_MS)
      } catch {
        // The retry remains authoritative if reconnect failed.
      }
    }
    return await ops.submit(params)
  }
}

function withIdempotencyKey(
  params: DownloadSubmitParams
): DownloadSubmitParams {
  return params.idempotencyKey
    ? params
    : { ...params, idempotencyKey: crypto.randomUUID() }
}

export async function commitHandoff(
  params: DownloadSubmitParams,
  ops: HandoffOps
): Promise<HandoffResult> {
  const keyedParams = withIdempotencyKey(params)
  await ops.cancelNative()
  return await submitOrFallback(keyedParams, ops)
}
