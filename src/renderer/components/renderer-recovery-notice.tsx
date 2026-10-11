import { CloseIcon, InfoIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Toaster, toast } from '@renderer/components/ui/toast'
import { rendererSession } from '@renderer/lib/renderer-health'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import type { RendererSession } from '@shared/schemas/renderer-health'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

// A session belongs to this document. Remounts and locale changes must not
// repeat feedback after the toast has expired or the user has closed it.
const notifiedSessions = new WeakSet<RendererSession>()

/** Mount the host before publishing recovery feedback to its toast manager. */
export function RendererToaster() {
  const { t } = useTranslation()

  useEffect(() => {
    const session = rendererSession()
    if (!session?.recovered || session.submissionNeedsReview) return
    const notify = () => {
      if (document.hidden || notifiedSessions.has(session)) return
      toast.add({
        title: t('rendererRecovery.restored'),
        type: 'success',
        priority: 'low',
        timeout: 3_000,
      })
      notifiedSessions.add(session)
    }
    notify()
    document.addEventListener('visibilitychange', notify)
    return () => document.removeEventListener('visibilitychange', notify)
  }, [t])

  return <Toaster />
}

/** Submission uncertainty stays beside the form until explicitly dismissed. */
export function RendererSubmissionNotice({
  className,
  onOpenDownloads,
}: {
  className?: string
  onOpenDownloads?: () => void
}) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || !rendererSession()?.submissionNeedsReview) return null
  return (
    <aside
      role="status"
      className={cn(
        'flex shrink-0 items-start gap-2.5 rounded-xl bg-muted/60 px-3 py-2.5 text-xs',
        className
      )}
    >
      <InfoIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="leading-5 text-muted-foreground">
          {t('rendererRecovery.submissionNotice')}
        </p>
        <Button
          type="button"
          size="xs"
          variant="link"
          className="h-auto px-0 py-1 text-xs"
          onClick={
            onOpenDownloads ??
            (() => {
              void transport.invoke(Commands.ShowMainWindow).catch(() => {})
            })
          }
        >
          {t('rendererRecovery.downloads')}
        </Button>
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('common.close')}
        className="-me-1 -mt-0.5 text-muted-foreground"
        onClick={() => setDismissed(true)}
      >
        <CloseIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </aside>
  )
}
