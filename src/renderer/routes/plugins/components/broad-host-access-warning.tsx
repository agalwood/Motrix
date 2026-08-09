import { Alert } from '@renderer/components/ui/alert'
import { useTranslation } from 'react-i18next'

export function BroadHostAccessWarning() {
  const { t } = useTranslation()
  return (
    <Alert variant="destructive" className="shadow-none border">
      <div className="min-w-0">
        <div className="text-sm font-semibold">
          {t('plugins.consent.broadAccess.title')}
        </div>
        <div className="text-xs">{t('plugins.consent.broadAccess.body')}</div>
      </div>
    </Alert>
  )
}
