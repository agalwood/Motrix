import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { graphicsRecoveryNoticeSchema } from '@shared/schemas/graphics-recovery'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export const GRAPHICS_RECOVERY_TOAST_ID = 'graphics-recovery'

/** Read the durable notice after the main UI mounts; startup events can precede
 * the renderer, and a hidden login window must not consume the explanation. */
export function useGraphicsRecoveryToast(): void {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    if (transport.platform === 'web') return
    let disposed = false
    let pending = false
    let shownId: string | null = null
    let retries = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      if (disposed || pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const notice = graphicsRecoveryNoticeSchema
          .nullable()
          .parse(await transport.invoke(Queries.GetGraphicsRecoveryNotice))
        if (
          disposed ||
          document.visibilityState !== 'visible' ||
          !notice ||
          shownId === notice.id
        )
          return
        shownId = notice.id
        toast.add({
          id: GRAPHICS_RECOVERY_TOAST_ID,
          type: 'warning',
          title: tRef.current(
            'settings.appearance.hardwareAccelerationRecoveryTitle'
          ),
          description: tRef.current(
            'settings.appearance.hardwareAccelerationRecoveryBody'
          ),
          timeout: 0,
          onClose: () => {
            if (disposed) return
            // Keep the durable notice until the user dismisses it. If this
            // write fails, a future renderer/launch can deliver it again.
            void transport
              .invoke(Commands.AcknowledgeGraphicsRecoveryNotice, notice)
              .catch(() => {})
          },
        })
      } catch {
        if (!disposed && retries++ < 3) {
          retryTimer = setTimeout(() => void check(), 1_000)
        }
      } finally {
        pending = false
      }
    }
    const onVisible = () => void check()
    document.addEventListener('visibilitychange', onVisible)
    void check()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      if (shownId) toast.close(GRAPHICS_RECOVERY_TOAST_ID)
    }
  }, [])
}
