import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import { Badge } from '@renderer/components/ui/badge'
import type { LegacyImportItem } from '@shared/schemas/legacy-import'
import { useTranslation } from 'react-i18next'

/** The path describes the original save directory, not a new destination. */
export function ImportTaskInfo({
  item,
  showReason = true,
}: {
  item: LegacyImportItem
  showReason?: boolean
}) {
  const { t } = useTranslation()
  const reason = t(`legacyImport.reasons.${item.reason}`)
  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <MiddleEllipsis
          text={item.name}
          className="min-w-0 font-sans! text-[13px] font-medium"
        />
        <Badge variant="secondary" className="border-border">
          {t(`legacyImport.page.types.${item.type}`)}
        </Badge>
      </div>
      <p className="flex min-w-0 text-xs leading-4 text-foreground/70">
        {item.saveDir ? (
          <MiddleEllipsis text={item.saveDir} className="font-sans!" />
        ) : (
          t('legacyImport.page.pathUnavailable')
        )}
      </p>
      {showReason && item.reason !== 'metadata-required' && (
        <p
          title={reason}
          className="truncate text-xs leading-4 text-foreground/70"
        >
          {reason}
        </p>
      )}
    </div>
  )
}
