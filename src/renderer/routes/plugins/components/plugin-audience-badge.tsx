import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { type AudienceTone, getAudienceTone } from '../lib/audience'

interface Props {
  tone: AudienceTone
  className?: string
}

export function PluginAudienceBadge({ tone, className }: Props) {
  const { t } = useTranslation()
  const c = getAudienceTone(tone)
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent', c.bg, c.text, className)}
    >
      {t(`plugins.tone.${tone}`)}
    </Badge>
  )
}
