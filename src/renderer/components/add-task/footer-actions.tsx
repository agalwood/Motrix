import { Button } from '@renderer/components/ui/button'
import { useTranslation } from 'react-i18next'

interface FooterActionsProps {
  submitting: boolean
  canSubmit: boolean
  onCancel: () => void
  onSubmit: () => void
}

export function FooterActions({
  submitting,
  canSubmit,
  onCancel,
  onSubmit,
}: FooterActionsProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={submitting}
      >
        {t('common.cancel')}
      </Button>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={onSubmit}
        disabled={!canSubmit || submitting}
        className="gap-2"
      >
        <span>{submitting ? t('task.add.adding') : t('common.download')}</span>
      </Button>
    </div>
  )
}
