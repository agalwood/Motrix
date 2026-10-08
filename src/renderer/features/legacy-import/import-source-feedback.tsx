import { Button } from '@renderer/components/ui/button'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export function ImportSourceFeedback({
  id,
  title,
  description,
  busy,
  onRetry,
}: {
  id: string
  title: string
  description: string
  busy: boolean
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const notice = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (notice.current?.getClientRects().length) {
      notice.current.focus({ preventScroll: true })
      notice.current.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
  }, [])
  return (
    <div
      ref={notice}
      id={id}
      role="alert"
      tabIndex={-1}
      className="mt-2 space-y-1 ps-7 text-xs leading-relaxed outline-none"
    >
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground">{description}</p>
      {onRetry && (
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={busy}
          onClick={onRetry}
          className="h-auto px-0 py-1 text-xs"
        >
          {t('legacyImport.page.sourceFeedback.retry')}
        </Button>
      )}
    </div>
  )
}
