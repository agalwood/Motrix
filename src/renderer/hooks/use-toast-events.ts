import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

type ToastPayload = {
  key: string
  params?: Record<string, string>
}

function isToastPayload(value: unknown): value is ToastPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { key?: unknown; params?: unknown }
  if (typeof v.key !== 'string') return false
  if (v.params !== undefined) {
    if (typeof v.params !== 'object' || v.params === null) return false
  }
  return true
}

/**
 * Mount exactly once at the top of the app tree (AppLayout) — not per page.
 * Subscribes to `Events.ToastShow` for the app lifetime; the translator is
 * held through a ref so locale switches don't tear down the subscription
 * (which would drop events fired during the switch).
 */
export function useToastEvents(): void {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    const handler = (...args: unknown[]) => {
      const payload = args[0]
      if (!isToastPayload(payload)) return
      toast.add({
        title: tRef.current(payload.key, payload.params ?? {}),
        type: 'info',
      })
    }
    transport.on(Events.ToastShow, handler)
    return () => {
      transport.off(Events.ToastShow, handler)
    }
  }, [])
}
