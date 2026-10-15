import type { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import { requestConfirmedDownload } from '@/background/confirmedDownload'
import { downloadHttpInBrowser } from '@/background/contextMenu/register'
import type { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import type { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import type { HandoffGuard } from '@/background/handoff/guard'
import { makeOps, type OpsDeps } from '@/background/handoff/makeOps'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { TakeoverConfig, TakeoverTarget } from '@/shared/takeover'

type ContextMenuDownloadDeps = Pick<
  OpsDeps,
  'manager' | 'isPaired' | 'gate' | 'nudge' | 'notify'
> & {
  popup: Pick<AutoOpenPopupService, 'captureSubmission'>
  confirmation: Pick<DownloadConfirmationService, 'request'>
  submissions: Pick<DownloadSubmissionService, 'run'>
  getConfig(): Promise<TakeoverConfig>
  ready(): Promise<unknown>
  captureGuard(): Promise<HandoffGuard | null>
}

export function createContextMenuDownloadRunner(deps: ContextMenuDownloadDeps) {
  return async (target: TakeoverTarget, windowId?: number): Promise<void> => {
    const present = deps.popup.captureSubmission()
    await deps.ready()
    const guard = await deps.captureGuard()
    if (guard === null) return
    const config = await deps.getConfig()
    guard.assertCurrent()
    if (config.downloadMode === 'confirm') {
      await requestConfirmedDownload(deps, target, windowId, guard)
      return
    }
    const result = await runHandoff(
      target,
      makeOps({
        ...deps,
        guard,
        cancelNative: async () => {},
        fallbackToBrowser: () => downloadHttpInBrowser(target.url),
        confirmSensitive: async () => false,
      })
    )
    if (result.kind === 'accepted') void present(result, guard).catch(() => {})
  }
}
