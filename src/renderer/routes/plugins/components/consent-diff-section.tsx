import { Badge } from '@renderer/components/ui/badge'
import type { TrustSurfaceDiff } from '@shared/types/plugin-install'
import { useTranslation } from 'react-i18next'

export function ConsentDiffSection({ diff }: { diff: TrustSurfaceDiff }) {
  const { t } = useTranslation()

  const rows: Array<{ key: string; items: ReadonlyArray<string> }> = [
    { key: 'permissions', items: diff.permissionsAdded },
    { key: 'optionalPermissions', items: diff.optionalPermissionsAdded },
    { key: 'hostPermissions', items: diff.hostPermissionsAdded },
    { key: 'invokesCommands', items: diff.invokesCommandsAdded },
    { key: 'publicCommands', items: diff.publicCommandsAdded },
    { key: 'publicCommandsSchema', items: diff.publicCommandsSchemaChanged },
  ]

  const isEmpty =
    rows.every((r) => r.items.length === 0) &&
    !diff.requestedHeapMBIncreased &&
    !diff.enginesMotrixMajorChange &&
    !diff.sourceUrlChanged

  if (isEmpty) return null

  return (
    <section className="rounded-md border border-border bg-muted/30 p-3">
      <h4 className="text-sm font-semibold">
        {t('plugins.consent.diff.title')}
      </h4>
      <ul className="mt-2 space-y-1 text-xs">
        {rows
          .filter((r) => r.items.length > 0)
          .map((r) => (
            <li key={r.key} className="flex flex-wrap items-baseline gap-1">
              <span className="font-medium">
                {t(`plugins.consent.diff.${r.key}`)}:
              </span>
              {r.items.map((it) => (
                <Badge key={it} variant="outline">
                  {it}
                </Badge>
              ))}
            </li>
          ))}
        {diff.requestedHeapMBIncreased && (
          <li>
            <span className="font-medium">
              {t('plugins.consent.diff.heap')}:
            </span>{' '}
            {diff.requestedHeapMBIncreased.from} →{' '}
            {diff.requestedHeapMBIncreased.to} MB
          </li>
        )}
        {diff.enginesMotrixMajorChange && (
          <li>
            <span className="font-medium">
              {t('plugins.consent.diff.engines')}:
            </span>{' '}
            {diff.enginesMotrixMajorChange.from} →{' '}
            {diff.enginesMotrixMajorChange.to}
          </li>
        )}
        {diff.sourceUrlChanged && (
          <li className="break-all">
            <span className="font-medium">
              {t('plugins.consent.diff.source')}:
            </span>{' '}
            {diff.sourceUrlChanged.from} → {diff.sourceUrlChanged.to}
          </li>
        )}
      </ul>
    </section>
  )
}
