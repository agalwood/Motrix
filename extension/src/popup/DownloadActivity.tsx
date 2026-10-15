import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { ConnectionPhase, DownloadOperation } from '@/shared/integration'

/** Reads background-owned progress again when a popup is reopened. */
export function DownloadActivity({
  endpointId,
  endpointRevision,
  phase,
  onViewTasks,
}: {
  endpointId: string
  endpointRevision: number
  phase: ConnectionPhase
  onViewTasks: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [operations, setOperations] = useState<DownloadOperation[]>([])
  useEffect(() => {
    let cancelled = false
    let reading = false
    setOperations([])
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        const next = await send('bg.getDownloadOperations', {
          endpointId,
          endpointRevision,
        })
        if (!cancelled && Array.isArray(next)) setOperations(next)
      } catch {
        // Progress is advisory. The submission itself owns failure handling.
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [endpointId, endpointRevision])

  const active = operations.filter(
    (operation) =>
      operation.state === 'preparing' || operation.state === 'submitting'
  )
  const unknown = operations.some((operation) => operation.state === 'unknown')
  if (active.length === 0 && !unknown) return null
  const preparing = active.some((operation) => operation.state === 'preparing')
  const label =
    active.length > 0
      ? preparing && phase === 'waking'
        ? 'popup.integration.waking'
        : preparing
          ? 'popup.integration.preparing'
          : 'popup.integration.sending'
      : 'popup.integration.resultUnknown'

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2 flex shrink-0 items-center gap-2 text-xs leading-5 text-muted-foreground"
    >
      {active.length > 0 && (
        <Spinner className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">{t(label)}</span>
      {unknown && active.length === 0 && (
        <Button size="xs" variant="ghost" onClick={onViewTasks}>
          {t('popup.integration.viewTasks')}
        </Button>
      )}
    </div>
  )
}
