import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { OperationsBoundary } from './operation-boundary'
import { OperationSkeleton } from './operation-skeleton'
import { operationSessionKey, useOperationDialog } from './operation-store'

const OperationForm = lazy(() => import('./operation-form'))
export function OperationDialogHost() {
  const { request, close } = useOperationDialog()
  const { t } = useTranslation()
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('plugins.detail.operations')}</DialogTitle>
          <DialogDescription>
            {t('pluginOperations.background')}
          </DialogDescription>
        </DialogHeader>
        <OperationsBoundary
          message={t('plugins.detail.operationsFailed')}
          retry={t('common.retry')}
        >
          <Suspense fallback={<OperationSkeleton />}>
            {request && (
              <OperationForm
                key={operationSessionKey(request)}
                {...request}
                onClose={close}
              />
            )}
          </Suspense>
        </OperationsBoundary>
      </DialogContent>
    </Dialog>
  )
}
