import { useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import {
  POPUP_PORT,
  POPUP_RECEIPT_EVENT,
  type PopupReceipt,
} from '@/shared/autoPopup'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'

export function useAutoPopupReceipt(
  endpointId: string,
  endpointRevision: number,
  refresh: () => Promise<void>
): PopupReceipt | null {
  const [receipt, setReceipt] = useState<PopupReceipt | null>(null)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    let disposed = false
    let port: Browser.runtime.Port | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let receiptVersion = 0
    setReceipt(null)
    const accept = (next: PopupReceipt | null, windowId: number) => {
      if (
        disposed ||
        !next ||
        next.windowId !== windowId ||
        next.endpointId !== endpointId ||
        next.endpointRevision !== endpointRevision ||
        next.expiresAt <= Date.now()
      )
        return
      receiptVersion += 1
      setReceipt(next)
      clearTimeout(expiry)
      expiry = setTimeout(() => {
        if (!disposed) setReceipt(null)
      }, next.expiresAt - Date.now())
      void refreshRef.current().catch(() => {})
    }
    const connect = async () => {
      try {
        const window = await browser.windows.getCurrent()
        if (disposed || typeof window.id !== 'number') return
        const windowId = window.id
        port = browser.runtime.connect({ name: POPUP_PORT })
        port.onMessage.addListener(
          (message: { kind?: string; receipt?: PopupReceipt }) => {
            if (message.kind === POPUP_RECEIPT_EVENT)
              accept(message.receipt ?? null, windowId)
          }
        )
        port.onDisconnect.addListener(() => {
          if (!disposed) retry = setTimeout(() => void connect(), 1000)
        })
        port.postMessage({ windowId })
        const requestVersion = receiptVersion
        const stored = await send('bg.getPopupReceipt', { windowId })
        // Live delivery may have advanced the batch while storage was read.
        if (requestVersion === receiptVersion) accept(stored, windowId)
      } catch {
        /* Receipt delivery is advisory and must not disrupt the popup. */
      }
    }
    void connect()
    return () => {
      disposed = true
      clearTimeout(retry)
      clearTimeout(expiry)
      port?.disconnect()
    }
  }, [endpointId, endpointRevision])
  return receipt
}
