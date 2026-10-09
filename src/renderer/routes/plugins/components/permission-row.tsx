import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { type ReactNode, useId } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { getAudienceTone, permissionAudience } from '../lib/audience'

interface Props {
  permission: string
  granted: boolean
  onToggle?: () => void
  disabled?: boolean
  grouped?: boolean
  children?: ReactNode
}

export function PermissionRow({
  permission,
  granted,
  onToggle,
  disabled,
  grouped,
  children,
}: Props) {
  const labelId = useId()
  const descriptionId = useId()
  const { t } = useTranslation()
  const audience = permissionAudience(permission, t)
  const tone = getAudienceTone(audience.tone)
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 p-3',
        !grouped && 'rounded-lg border'
      )}
    >
      <div className="min-w-0">
        <strong id={labelId} className="text-sm font-medium leading-5">
          {audience.strong}
        </strong>
        <p
          id={descriptionId}
          className="text-xs leading-5 text-muted-foreground"
        >
          {permission === 'ffmpeg' ? (
            <Trans
              i18nKey="plugins.permission.ffmpeg.requirement"
              components={{
                settings: (
                  <Link
                    to="/settings/integration"
                    className="text-primary underline underline-offset-4"
                  />
                ),
              }}
            />
          ) : (
            audience.plain
          )}
        </p>
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!grouped && (
          <Badge
            variant="outline"
            className={cn('border-transparent', tone.bg, tone.text)}
          >
            {audience.toneLabel}
          </Badge>
        )}
        {onToggle && (
          <Switch
            size="sm"
            checked={granted}
            onCheckedChange={onToggle}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
          />
        )}
      </div>
    </div>
  )
}
