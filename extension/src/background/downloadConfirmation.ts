import {
  DownloadConfirmationService,
  type RecoverConfirmation,
} from '@/background/DownloadConfirmationService'
import { rpcDeadline } from '@/background/RpcRecovery'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { CONFIRMATION_PORT } from '@/shared/downloadConfirmation'
import { supportsAutoOpenPopup } from '@/shared/platformCapabilities'

export function createDownloadConfirmation(
  recover?: RecoverConfirmation
): DownloadConfirmationService {
  const views = new Map<Browser.runtime.Port, number>()
  const waitingViews = new Map<number, Set<() => void>>()
  const service = new DownloadConfirmationService({
    supported: supportsAutoOpenPopup,
    open: async (windowId, isCurrent) => {
      const window = await rpcDeadline(
        browser.windows.get(windowId),
        500,
        'confirmation window'
      )
      if (!isCurrent() || !window.focused || window.type !== 'normal')
        throw new Error('confirmation window unavailable')
      if ([...views.values()].includes(windowId)) return
      await rpcDeadline(
        browser.action.openPopup({ windowId }),
        5000,
        'confirmation popup'
      )
      if (!isCurrent() || [...views.values()].includes(windowId)) return
      // A popup closed before its handshake must not occupy the window for two minutes.
      let resolveView!: () => void
      const ready = new Promise<void>((resolve) => {
        resolveView = resolve
      })
      const waiters = waitingViews.get(windowId) ?? new Set<() => void>()
      waiters.add(resolveView)
      waitingViews.set(windowId, waiters)
      try {
        await rpcDeadline(ready, 5000, 'confirmation view')
      } finally {
        waiters.delete(resolveView)
        if (waiters.size === 0 && waitingViews.get(windowId) === waiters)
          waitingViews.delete(windowId)
      }
    },
    publish: (windowId, draft) => {
      for (const [port, id] of views) {
        if (id !== windowId) continue
        try {
          port.postMessage({ draft })
        } catch {
          views.delete(port)
        }
      }
    },
    userAgent: () => navigator.userAgent,
    ...(recover ? { recover, storage: browser.storage.session } : {}),
  })
  // Browsers without programmatic popup support cannot host this workflow.
  if (!supportsAutoOpenPopup()) return service
  browser.runtime.onConnect.addListener((port) => {
    if (
      port.name !== CONFIRMATION_PORT ||
      port.sender?.id !== browser.runtime.id ||
      port.sender.url !== browser.runtime.getURL('popup.html') ||
      port.sender.tab
    )
      return
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return
      if (
        'windowId' in message &&
        typeof message.windowId === 'number' &&
        Number.isInteger(message.windowId) &&
        message.windowId >= 0 &&
        !views.has(port)
      ) {
        views.set(port, message.windowId)
        const windowId = message.windowId
        void service.ready
          .then(() => {
            if (views.get(port) !== windowId) return
            port.postMessage({ draft: service.get(windowId) })
            for (const resolve of waitingViews.get(windowId) ?? []) resolve()
          })
          .catch(() => {})
      }
      const windowId = views.get(port)
      if (
        windowId !== undefined &&
        'id' in message &&
        typeof message.id === 'string' &&
        'decision' in message
      ) {
        service.decide(windowId, message.id, message.decision)
      }
    })
    port.onDisconnect.addListener(() => {
      views.delete(port)
      // Closing a popup only detaches its view. Explicit cancel, window removal,
      // or draft expiry owns cancellation; a new popup can resume the draft.
    })
  })
  browser.windows.onRemoved.addListener((windowId) => service.close(windowId))
  return service
}
