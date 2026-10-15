import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { send } from '@/background/MessageBus'
import { getBuildBrowser } from '@/shared/browserKind'
import type { NotificationCapability } from '@/shared/notifications'
import { supportsSystemNotifications } from '@/shared/platformCapabilities'

const capabilitySchema = z.object({
  available: z.boolean(),
  authorization: z.enum([
    'authorized',
    'notDetermined',
    'denied',
    'unavailable',
  ]),
})
const unavailable: NotificationCapability = {
  available: false,
  authorization: 'unavailable',
}

/** Recheck when the user returns from macOS settings without resetting form edits. */
export function useNotificationCapability() {
  const native = getBuildBrowser() === 'safari'
  const [capability, setCapability] = useState<NotificationCapability>(() =>
    supportsSystemNotifications()
      ? { available: true, authorization: 'authorized' }
      : unavailable
  )
  const mounted = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!native) return
    const current = ++generation.current
    let next = unavailable
    try {
      const parsed = capabilitySchema.safeParse(
        await send('bg.getNotificationCapability', undefined)
      )
      if (parsed.success) next = parsed.data
    } catch {
      /* Missing and incompatible native components remain hidden. */
    }
    if (mounted.current && current === generation.current) setCapability(next)
  }, [native])
  useEffect(() => {
    mounted.current = true
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const onFocus = () => {
      void refresh()
    }
    void refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mounted.current = false
      generation.current += 1
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])
  return { capability, native, refresh }
}
