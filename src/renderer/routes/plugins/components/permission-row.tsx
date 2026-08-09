import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { getAudienceTone, permissionAudience } from '../lib/audience'

interface Props {
  permission: string
  granted: boolean
  onToggle?: () => void
}

export function PermissionRow({ permission, granted, onToggle }: Props) {
  const { t } = useTranslation()
  const audience = permissionAudience(permission, t)
  const tone = getAudienceTone(audience.tone)
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <strong className="text-sm font-medium leading-5">
          {audience.strong}
        </strong>
        <p className="text-xs leading-5 text-muted-foreground">
          {audience.plain}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn('border-transparent', tone.bg, tone.text)}
        >
          {audience.toneLabel}
        </Badge>
        {onToggle && (
          <Switch
            size="sm"
            checked={granted}
            onCheckedChange={onToggle}
            aria-label={
              granted
                ? t('plugins.permission.accessTone.allowed')
                : t('plugins.permission.accessTone.grant')
            }
          />
        )}
      </div>
    </div>
  )
}
