import { Skeleton } from '@renderer/components/ui/skeleton'
import { useTranslation } from 'react-i18next'

export function OperationSkeleton() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{t('pluginOperations.loading')}</span>
      <div aria-hidden="true" className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-3/4" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-24 rounded-xl sm:col-span-2" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
    </div>
  )
}
