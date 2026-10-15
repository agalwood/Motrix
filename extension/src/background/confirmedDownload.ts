import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import { downloadHttpInBrowser } from '@/background/contextMenu/register'
import type {
  ConfirmationActions,
  DownloadConfirmationService,
} from '@/background/DownloadConfirmationService'
import type { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { notifySafely } from '@/background/handoff/delivery'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps, type OpsDeps } from '@/background/handoff/makeOps'
import { i18n } from '@/shared/i18n'
import { supportsBrowserDownload } from '@/shared/platformCapabilities'
import { hostOf, isMagnetUrl, type TakeoverTarget } from '@/shared/takeover'
import { applyTaskOptions } from '@/shared/taskOptions'

export type ConfirmedDownloadDeps = Pick<
  OpsDeps,
  'manager' | 'isPaired' | 'gate' | 'nudge' | 'notify'
> & {
  confirmation: Pick<DownloadConfirmationService, 'request'>
  submissions: Pick<DownloadSubmissionService, 'run'>
}

export function createConfirmedDownloadActions(
  deps: ConfirmedDownloadDeps,
  target: TakeoverTarget,
  guard: HandoffGuard
): ConfirmationActions {
  return {
    submit: (options, operationId) => {
      guard.assertCurrent()
      return deps.submissions.run(
        {
          idempotencyKey: operationId,
          source: 'direct',
          directory: options.directory,
          pairIfNeeded: true,
          resourceKey: JSON.stringify([target.url, options]),
        },
        async ({ assertCurrent }) => {
          guard.assertCurrent()
          assertCurrent()
          const ops = makeOps({
            ...deps,
            guard,
            taskOptions: options,
            cancelNative: async () => {},
            fallbackToBrowser: async () => {},
            confirmSensitive: async () => true,
          })
          const cookies =
            isMagnetUrl(target.url) || ops.isSensitive(hostOf(target.url))
              ? []
              : await ops.captureCookies(target.url)
          guard.assertCurrent()
          assertCurrent()
          return applyTaskOptions(
            buildSubmitParams(target, cookies, {}),
            options
          )
        }
      )
    },
    browser:
      target.origin === 'auto' || supportsBrowserDownload()
        ? async () => {
            // The native adapter keeps its response; early interception cancels it.
            if (target.origin === 'auto' && !target.nativeDownloadCancelled)
              return
            guard.assertCurrent()
            await downloadHttpInBrowser(target.url)
          }
        : undefined,
  }
}

export async function requestConfirmedDownload(
  deps: ConfirmedDownloadDeps,
  target: TakeoverTarget,
  windowId: number | undefined,
  guard: HandoffGuard
): Promise<void> {
  guard.assertCurrent()
  const decision = await deps.confirmation.request(
    target,
    windowId,
    createConfirmedDownloadActions(deps, target, guard),
    guard.endpointId
      ? {
          endpointId: guard.endpointId,
          endpointRevision: guard.endpointRevision ?? 0,
        }
      : undefined
  )
  if (
    target.origin === 'context-menu' &&
    (decision.action === 'unavailable' || decision.action === 'unsupported')
  ) {
    notifySafely(deps, {
      title: i18n.t('options.downloadMode.confirm'),
      message: i18n.t(
        decision.action === 'unsupported'
          ? 'options.taskPanel.unsupported'
          : 'popup.confirmDownload.unavailable'
      ),
      // Keep a visible toolbar error even when system notifications are muted.
      severity: 'error',
    })
  }
}
