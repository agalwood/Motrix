import { Button } from '@renderer/components/ui/button'
import { OperationSkeleton } from '@renderer/features/plugin-operations/operation-skeleton'
import { useOperationState } from '@renderer/features/plugin-operations/use-operation-state'
import { lazy, Suspense, useState } from 'react'

const OperationForm = lazy(
  () => import('@renderer/features/plugin-operations/operation-form')
)

import { OperationsBoundary } from '@renderer/features/plugin-operations/operation-boundary'
import type { PluginManifestDTO } from '@shared/types/plugin'
import { useTranslation } from 'react-i18next'

export function hasPluginOperations(manifest: PluginManifestDTO): boolean {
  return !!manifest.contributes.operations?.items.length
}

export function PluginOperations({
  pluginId,
  enabled,
}: {
  pluginId: string
  enabled: boolean
}) {
  const { t } = useTranslation()
  const { snapshot, failed } = useOperationState()
  const items = (snapshot?.descriptors ?? []).filter(
    (item) =>
      item.pluginId === pluginId &&
      item.definition.entries.some((entry) => entry.surface === 'plugin-detail')
  )
  const [activeId, setActiveId] = useState<string>()
  return (
    <section className="mx-auto w-full max-w-2xl space-y-6 py-2">
      {!snapshot && !failed && <OperationSkeleton />}
      {failed && <p role="alert">{t('plugins.detail.operationsFailed')}</p>}
      {items.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <Button
              key={item.definition.id}
              size="sm"
              variant={
                (activeId ?? items[0]?.definition.id) === item.definition.id
                  ? 'default'
                  : 'outline'
              }
              onClick={() => setActiveId(item.definition.id)}
            >
              {item.definition.title}
            </Button>
          ))}
        </div>
      )}
      {items
        .filter(
          (item) => item.definition.id === (activeId ?? items[0]?.definition.id)
        )
        .map((item) => (
          <OperationsBoundary
            key={item.definition.id}
            message={t('plugins.detail.operationsFailed')}
            retry={t('common.retry')}
          >
            {item.unavailable || !enabled ? (
              <div>
                <h3>{item.definition.title}</h3>
                <p>{t(`pluginOperations.${item.unavailable ?? 'disabled'}`)}</p>
              </div>
            ) : (
              <Suspense fallback={<OperationSkeleton />}>
                <OperationForm
                  pluginId={pluginId}
                  operationId={item.definition.id}
                />
              </Suspense>
            )}
          </OperationsBoundary>
        ))}
    </section>
  )
}
