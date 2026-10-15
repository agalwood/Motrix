import type { DownloadConfirmation } from '@/shared/downloadConfirmation'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { defaultTaskOptions } from '@/shared/taskOptions'

/** Local preview only; no browser download or Motrix request is made. */
export function createPreviewConfirmationPort(scenario: string | null) {
  let receive: (message: { draft: DownloadConfirmation | null }) => void =
    () => {}
  let disposed = false
  let draft: DownloadConfirmation | null = scenario
    ? {
        id: 'preview-confirmation',
        windowId: 1,
        expiresAt: Date.now() + 120_000,
        phase: 'editing',
        target: {
          url: 'https://download.example.com/archive.zip?signature=temporary-link',
          pageUrl: 'https://example.com/share',
          pageTitle: 'Download preview',
          suggestedFilename: 'archive.zip',
          mime: 'application/zip',
          sizeBytes: null,
          siteHint: 'example.com',
          origin:
            scenario === 'auto' || scenario === 'early'
              ? 'auto'
              : 'context-menu',
          ...(scenario === 'early' ? { nativeDownloadCancelled: true } : {}),
        },
        options: {
          ...defaultTaskOptions(navigator.userAgent),
          referer: 'https://example.com/share',
          useBrowserCookies: true,
          ...(scenario === 'directory-stale'
            ? {
                directory: {
                  path: '/downloads',
                  endpointId: 'local',
                  endpointRevision: 0,
                  instanceId: 'old-instance',
                },
              }
            : {}),
        },
      }
    : null
  const publish = () => {
    if (!disposed) receive({ draft: structuredClone(draft) })
  }
  return {
    onMessage: {
      addListener: (listener: typeof receive) => {
        receive = listener
      },
    },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {
      disposed = true
    },
    postMessage: (message: {
      windowId?: number
      decision?: { action: string; options?: DownloadConfirmation['options'] }
    }) => {
      if (message.windowId !== undefined) publish()
      const decision = message.decision
      if (!decision || !draft) return
      if (decision.action === 'cancel') {
        draft = null
        publish()
        return
      }
      if (decision.options) draft.options = decision.options
      if (decision.action === 'edit') return
      draft.phase = 'submitting'
      delete draft.error
      publish()
      setTimeout(() => {
        if (disposed || !draft) return
        if (scenario === 'failed' || scenario === 'unknown') {
          draft.phase = scenario
          draft.error =
            scenario === 'unknown'
              ? DOWNLOAD_ERROR.resultUnknown
              : DOWNLOAD_ERROR.connectionFailed
          draft.expiresAt = Date.now() + 120_000
        } else draft = null
        publish()
      }, 600)
    },
  }
}
