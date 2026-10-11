import { CheckIcon, CloseIcon, InfoIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { rendererSession } from '@renderer/lib/renderer-health'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './renderer-recovery.css'

/** Completion feedback has no actions and never takes focus from the task. */
export function RendererRecoveryStatus() {
  const { t } = useTranslation()
  const session = rendererSession()
  const recovered = Boolean(
    session?.recovered && !session.submissionNeedsReview
  )
  const [phase, setPhase] = useState<'visible' | 'leaving' | 'dismissed'>(
    'visible'
  )
  const dismissed = phase === 'dismissed'

  useEffect(() => {
    if (!recovered || dismissed) return
    let leaveTimer: ReturnType<typeof setTimeout>
    let dismissTimer: ReturnType<typeof setTimeout>
    const schedule = () => {
      clearTimeout(leaveTimer)
      clearTimeout(dismissTimer)
      if (document.hidden) return
      leaveTimer = setTimeout(() => setPhase('leaving'), 3_000)
      dismissTimer = setTimeout(() => setPhase('dismissed'), 3_200)
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      clearTimeout(leaveTimer)
      clearTimeout(dismissTimer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [recovered, dismissed])

  if (!recovered || phase === 'dismissed') return null
  return (
    <div
      role="status"
      aria-hidden={phase === 'leaving' || undefined}
      data-state={phase}
      className="renderer-recovery-status pointer-events-none fixed start-1/2 top-13 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-border/60 bg-popover/90 px-3.5 py-2 text-xs font-medium text-popover-foreground shadow-sm backdrop-blur-xl rtl:translate-x-1/2"
    >
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {t('rendererRecovery.restored')}
    </div>
  )
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
