import { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import type { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import { POPUP_PORT, POPUP_RECEIPT_EVENT } from '@/shared/autoPopup'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { supportsAutoOpenPopup } from '@/shared/platformCapabilities'

export function createAutoPopup(
  store: TakeoverConfigStore
): AutoOpenPopupService {
  const views = new Map<Browser.runtime.Port, number>()
  browser.runtime.onConnect.addListener((port) => {
    if (
      port.name !== POPUP_PORT ||
      port.sender?.id !== browser.runtime.id ||
      port.sender.url !== browser.runtime.getURL('popup.html')
    )
      return
    port.onMessage.addListener((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'windowId' in message &&
        typeof message.windowId === 'number' &&
        Number.isInteger(message.windowId)
      )
        views.set(port, message.windowId)
    })
    port.onDisconnect.addListener(() => views.delete(port))
  })
  return new AutoOpenPopupService({
    supported: supportsAutoOpenPopup,
    config: () => store.get(),
    focusedWindow: async () => {
      const window = await browser.windows.getLastFocused()
      return window.focused &&
        window.type === 'normal' &&
        typeof window.id === 'number'
        ? window.id
        : null
    },
    isOpen: (windowId) => [...views.values()].includes(windowId),
    open: (windowId) => browser.action.openPopup({ windowId }),
    publish: async (receipt) => {
      for (const [port, windowId] of views) {
        if (windowId === receipt.windowId) {
          try {
            port.postMessage({ kind: POPUP_RECEIPT_EVENT, receipt })
          } catch {
            views.delete(port)
          }
        }
      }
    },
    storage: browser.storage.session,
  })
}
